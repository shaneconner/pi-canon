/* Surfacing: tool calls stage the articles governing what they touch; the staged
   lines flush as ONE message per turn, once per article per session. One message per
   turn matters: pi's steering queue drains one message per provider round trip, so
   a message per tool call would buy each nudge its own extra LLM call.

   Nothing here is bounded by a character count. A session budget used to cap the
   capsule text and degrade the overflow to bare pointers, and it was deleted in 2.0
   (Shane, 2026-08-12): the constant was a guess at a policy nobody had measured, and
   it decided what an agent got to see. What replaces it is measurement. Every
   surfaced line records what it cost, so context taken can be read against relevance
   after the fact instead of a constant ruling on it in advance. */

import { appendFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { intentQuery, NONE, residue, userIntent, type IntentTurn, type Retriever } from "./retrieval.ts";
import type { CanonStore } from "./store.ts";

/* Observability, env-gated and inert otherwise: PI_CANON_TRACE=<file> appends one
   JSON line per surfacing decision, so a harness can audit the staged -> flushed ->
   seen funnel instead of guessing at it. */
function trace(kind: string, data: Record<string, unknown>): void {
  const file = process.env.PI_CANON_TRACE;
  if (!file) return;
  try {
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), kind, ...data }) + "\n");
  } catch {
    /* tracing must never break surfacing */
  }
}

const PATHLIKE = /(?:^|[\s"'`=:,([{])(\/?[\w.@-]+(?:\/[\w.@-]+)+)/g;

/* Presence marks -----------------------------------------------------------------

   "Seen" used to mean "we sent it once", which is only the same thing as "the agent
   can see it" in a session where nothing ever leaves the window. Once anything folds
   or compacts, the two come apart, and the agent is not aware of what was folded
   away. So seen is checked against the projection rather than remembered.

   A mark is a normalized slice of what the article put in the window, and the caller
   passes exactly that: the LINE for a surfaced article, capsule plus body for a read.
   Passing anything else is the one way to break this, because presence then tests for
   text that was never shown. Normalizing both sides to lowercase alphanumerics survives
   JSON escaping, whitespace rewrapping, and quoting differences between however the
   projection is rendered and however we wrote it. A short mark is not distinctive enough
   to test, so it is never expired; failing to expire only costs a re-surface that does
   not happen, while a false expiry would spam the window. A surfaced line always carries
   its own address and so is always long enough; only a read of a very small article is
   not.

   A mark has two parts and BOTH must be in the projection.

   IDENTITY is the article's own address, which is in the window whichever way the
   article got there: the surfaced line reads "path: capsule" and a read prints the
   address as its title. LIVENESS is the tail of whatever actually entered, the caller
   passing the whole of it. A surfaced line is its capsule and is held to the capsule;
   a read is capsule plus body and is held to the body.

   Both parts are needed because either alone is wrong in a way that matters. Identity
   alone cannot tell a one-line nudge from the full article, which is the defect that
   started this (Codex, 2026-08-12): an article read in full stayed present on the
   strength of its surviving capsule while the body holding the rule had folded away.
   Liveness alone collides, because two articles sharing a common ending share a tail,
   and the survivor then keeps the other marked present (Codex, 2026-08-13). Addresses
   are unique, so requiring both closes that.

   Tail rather than head for liveness, because the two ways content leaves a window are
   not symmetric: a fold takes the whole message, a truncation takes the end first, so a
   head mark survives exactly the loss it is supposed to report. */
const MARK_CHARS = 120;
const MARK_MINIMUM = 24;

/* How many RANKED articles may ride one message. Not a relevance threshold: see
   retrieve(). Three because a nudge is read or it is not, and the addressed lines it
   shares the message with are the ones that were certain. */
const RETRIEVED_PER_TURN = 3;

function fingerprint(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/* The projection's actual text, gathered from the message structure rather than from
   JSON.stringify of it. Stringifying introduced escapes that are not in anyone's text:
   a newline arrived as the two characters \ and n, and n is a letter, so the two sides
   disagreed at every line break. Erasing escapes afterwards fixed that and broke
   something else, making an article containing a literal backslash-n fingerprint
   identically to one without it (Codex, 2026-08-13), which is a false PRESENCE and so
   the expensive direction: the article is gone and nothing re-surfaces it. Reading the
   strings directly means no escape is ever introduced and none has to be erased. */
function projectionText(messages: unknown[]): string {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      out.push(value);
    } else if (value && typeof value === "object") {
      if (seen.has(value)) return; /* a cyclic projection is still readable */
      seen.add(value);
      for (const inner of Array.isArray(value) ? value : Object.values(value)) walk(inner);
    }
  };
  walk(messages);
  return out.join("\n");
}

/* A store and the directory whose assets it governs. The project is the first,
   unnamed mount; named mounts are outside directories (a data lake, a shared
   corpus) whose articles address as name:path. */
export interface Mount {
  name: string;
  dir: string;
  store: CanonStore;
}

export class Surfacer {
  private mounts: Mount[];
  private seen = new Set<string>();
  /* What to look for in the projection to decide an article is still visible. Absent
     for an article whose entered text is too short to test, which is never expired. */
  private marks = new Map<string, { id: string; tail: string }>();
  private pendingUpdates = new Set<string>();
  /* Raw asset paths this session touched, as the tools wrote them. Kept unresolved
     because the article governing one is often created after the touch; see checkBack(). */
  private touched = new Set<string>();
  private checkedBack = new Set<string>();
  private staged = new Map<string, { capsule: string; stamp: string; asset: string; score?: number }>();
  private retriever: Retriever;
  /* The intent the residue was last ranked against, so an unchanged question does not keep
     buying more guesses every turn. See retrieve(). */
  private lastQuery = "";
  private resurface: boolean;
  /* This turn's tool calls, cleared when it flushes: what the agent is doing right now,
     and nothing older. Recency is structural here rather than a weighting. */
  private intent: IntentTurn[] = [];
  /* The user's own words, refreshed from each projection. Kept apart from the tool
     calls because it has a different lifetime: a question stays the question across the
     turns spent answering it, while a tool call is spent the moment it flushes. */
  private spoken: IntentTurn[] = [];
  /* What each currently present article cost the window, kept for the same reason the
     budget was removed: the analysis wants context taken beside relevance. */
  private cost = new Map<string, number>();
  private surfacedEver = new Set<string>();
  /* What the last flush and settle committed on the assumption the message would be
     delivered. Kept so a failed send can be undone rather than silently believed. */
  private lastFlush = new Map<string, { capsule: string; stamp: string; asset: string; score?: number }>();
  private lastNudge: string[] = [];

  /* How far the best must beat the rest of the same query before anything rides. See
     retrieve(). The default is an operating point priced by a 120-cell study rather than
     picked: at 1.4 a session kept every rule fact the uncut channel delivered at a ninth
     of the suggestion volume, and a store with nothing relevant never reached it. 1 turns
     the cutoff off. */
  private standout: number;

  constructor(mounts: Mount[], retriever: Retriever = NONE, resurface = true, standout = 1.4) {
    this.mounts = mounts;
    this.retriever = retriever;
    this.resurface = resurface;
    this.standout = standout;
  }

  private get project(): Mount {
    return this.mounts[0];
  }

  private mountFor(asset: string): Mount {
    const path = asset.replace(/\\/g, "/");
    const absolute = isAbsolute(path) ? path : join(this.project.dir, path);
    for (const mount of this.mounts.slice(1)) {
      if (absolute === mount.dir || absolute.startsWith(`${mount.dir}/`)) return mount;
    }
    return this.project;
  }

  /* `entered` is everything the caller just put in the window for this article, not a
     mark: the tail of it becomes the mark, so a caller that sent the body is held to
     the body and one that sent only a capsule is held to the capsule. */
  markSeen(path: string, entered?: string): void {
    if (this.staged.has(path)) trace("withdrawn", { path });
    this.seen.add(path);
    this.remember(path, entered);
    this.staged.delete(path);
    /* Counted like a flushed line. The session budget was deleted in favour of measuring
       what context is actually taken, so a full read that recorded neither its cost nor
       its having happened left the measurement reporting present=1 at chars=0 (Codex,
       2026-08-13). A read is the largest thing this package ever puts in a window. */
    if (entered) {
      this.cost.set(path, entered.length);
      this.surfacedEver.add(path);
      trace("entered", { path, chars: entered.length, via: "read" });
    }
  }

  private remember(path: string, text: string | undefined): void {
    const print = fingerprint(text ?? "");
    const id = fingerprint(path);
    if (print.length >= MARK_MINIMUM && id) this.marks.set(path, { id, tail: print.slice(-MARK_CHARS) });
    else this.marks.delete(path);
  }

  /* The live projection, as the provider is about to receive it. Every article whose
     mark is no longer in it has left the agent's window and stops counting as seen, so
     the next touch of its asset surfaces it again.

     Two honest limits. This reads whatever the projection holds when pi-canon's
     handler runs, so if another extension folds after us we observe its previous
     state and lag by a turn; a lagging expiry is a late re-surface, not a wrong one.
     And a digested or summarized block does not carry the capsule, which is the
     intended reading: a digest of a line about an article is not the article.

     Never called means never expired, which is exactly 1.0 behavior, so a harness that
     does not report a projection loses the mechanism and nothing else. */
  observe(messages: unknown): void {
    if (!Array.isArray(messages)) return;
    const projection = fingerprint(projectionText(messages));
    /* Read before the expiry check and independently of it: the projection is the only
       place the user's own words are visible, and a run with resurface off still wants
       them for the query. Presence is what the switch governs, not observation. */
    this.spoken = userIntent(messages);
    if (!this.resurface) return;
    for (const path of [...this.seen]) {
      const mark = this.marks.get(path);
      if (!mark || (projection.includes(mark.id) && projection.includes(mark.tail))) continue;
      this.seen.delete(path);
      this.marks.delete(path);
      this.cost.delete(path);
      trace("departed", { path });
    }
  }

  /* Authoring an article is a way of having it in the window, so it takes `entered`
     for the same reason a read does. Passing nothing here was a real bug (Codex,
     2026-08-13): the mark was cleared, observe() skips a seen path with no mark, and the
     article then stayed present for the rest of the session and could never re-surface.
     Only what the write itself carried counts: a capsule-only write leaves the stored
     body unseen, so marking the whole article present would be a claim about text the
     agent never received. */
  markUpdated(path: string, entered?: string): void {
    this.markSeen(path, entered);
    this.pendingUpdates.delete(path);
  }

  /* surfaced counts every article this session ever put in the window; present counts
     the ones still in it, and chars what those are currently occupying. They diverge
     exactly when something folded an article away, which is the whole point. */
  get stats(): { surfaced: number; present: number; chars: number } {
    let chars = 0;
    for (const value of this.cost.values()) chars += value;
    return { surfaced: this.surfacedEver.size, present: this.seen.size, chars };
  }

  /* Candidate asset paths in a tool call: string values that are paths, and path
     shaped tokens inside them. A candidate needs to exist, or to have an existing
     parent, so a file about to be created still surfaces its governing article. */
  pathsIn(input: unknown): string[] {
    const found = new Set<string>();
    const consider = (candidate: string) => {
      const path = candidate.replace(/\\/g, "/");
      const absolute = isAbsolute(path) ? path : join(this.project.dir, path);
      if (existsSync(absolute) || (path.includes("/") && existsSync(dirname(absolute)))) found.add(path);
    };
    const walk = (value: unknown): void => {
      if (typeof value === "string") {
        const whole = value.trim();
        if (whole && whole.length < 512 && !whole.includes("\n")) consider(whole);
        for (const match of value.matchAll(PATHLIKE)) consider(match[1]);
      } else if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (value && typeof value === "object") {
        Object.values(value).forEach(walk);
      }
    };
    walk(input);
    return [...found];
  }

  /* This turn's intent, one entry per tool call. Kept separate from `collect` because
     they answer different questions: collect asks what asset was touched, which the
     spine answers by address, and this asks what the agent is trying to do, which is
     the only thing an unaddressed article can be ranked against. */
  noteIntent(toolName: unknown, input: unknown): void {
    if (typeof toolName === "string" && toolName) this.intent.push({ toolName, input });
  }

  /* The residue, rebuilt only when the store moved under it.

     This used to rebuild every turn on the grounds that the residue is small by
     construction. Measured, that justifies the wrong quantity: residue() reads and stats
     every article in the store before it filters any of them, so the cost tracks the STORE.
     5,000 articles cost 242ms a turn when all of them are residue and 214ms when only 50
     are. At 20,000 it is 891ms, every turn, on the path a provider round trip is waiting on.

     The stated reason not to cache was real and is answered rather than ignored: `updated`
     has day granularity, so an article rewritten in the same session keeps its stamp and any
     key built from it serves a stale ranking for the rest of the run. store.signature() keys
     on mtimeMs and size instead, which move on every write, and costs 114ms where the
     rebuild costs 891ms. */
  private residueCache?: { signature: string; candidates: ReturnType<typeof residue> };
  private reindex = true;

  private candidates(store: CanonStore, dir: string): ReturnType<typeof residue> {
    const signature = store.signature();
    if (this.residueCache?.signature === signature) return this.residueCache.candidates;
    const candidates = residue(store, dir);
    this.residueCache = { signature, candidates };
    /* The retriever's index is built from these, so it is stale for exactly as long as
       they are. One flag, set here, cleared where the index is rebuilt. */
    this.reindex = true;
    trace("residue-rebuilt", { candidates: candidates.length });
    return candidates;
  }

  /* Rank the residue against this turn's intent and stage what the query touched.

     `score > 0` is not a tuned cutoff. With BM25 normalized against its saturation
     ceiling it means "at least one query term appears in this article at all", which is
     a property of the query rather than a constant someone picked. `standout` is the
     tuned one. A 120-cell study priced it on a corpus with something worth finding in
     its residue, and 1.4 held every fact the uncut channel delivered at a ninth of the
     volume; that is the default, and the caller moves it against their own trace.

     There used to be an absolute threshold here, on the grounds that a study session was
     handed 28 ranked lines and opened 5, and the scores of the opened and the ignored
     overlapped but separated. That is the precondition a cutoff needs, and the shape it
     was given was wrong. Read back across two studies the same cutoff had to be 0.25 on
     one corpus and 0.03 on the other, and read WITHIN one session it moved by a factor
     of four with nothing but how much the agent happened to say that turn. It was never
     one quantity being tuned to three values. What it was really doing was silencing
     whole queries rather than trimming tails, 82% of what it removed at its operating
     point, so it is now written as the thing it was doing, in a unit that ports.

     What IS bounded is how many articles ride one message, and that is a different thing
     from a cutoff. A cutoff rules on relevance; this rules on transport. Sharing
     one token with the query is enough to score above zero, so a residue of fifty rule
     articles and a query saying "export" stages fifty lines, and every one of them is
     unrequested context the agent never asked to spend. The address spine is exempt
     because an addressed article is a certainty and the agent touched its asset; ranked
     candidates are guesses, and a guess does not get to fill the window. Nothing is
     discarded: what does not fit is still eligible next turn, and the trace records what
     was held back, so the cutoff question stays answerable from data. */
  retrieve(): void {
    if (this.retriever === NONE) return;
    /* Oldest first, so intentQuery's newest-first walk reads in true order: this turn's
       tool calls lead, the question that prompted them follows. */
    const turns = [...this.spoken, ...this.intent];
    if (!turns.length) return;
    const { store, dir } = this.project;
    const candidates = this.candidates(store, dir);
    if (!candidates.length) return;
    /* Indexed only when the store actually changed; see candidates(). */
    if (this.reindex) {
      this.retriever.index?.(candidates);
      this.reindex = false;
    }
    const query = intentQuery(turns);
    if (!query.trim()) return;
    /* A new ranked article is justified by new intent, never by another turn passing.

       The per-message cap bounds how much rides one message; on its own it did not bound
       what a session spends. `seen` keeps a flushed path from returning but does nothing to
       stop the NEXT three being released against the very same query, and user speech
       persists in the projection while flush clears only tool intent, so an unchanged
       question released three more articles every turn until the residue ran out. That
       serialises the fan-out rather than bounding it (Codex, 2026-08-13). The two together
       are the bound: three per message, and nothing further until the agent's intent
       actually moves. */
    if (query === this.lastQuery) return;
    this.lastQuery = query;
    let scores: Map<string, number>;
    try {
      scores = this.retriever.score(query, candidates);
    } catch (error) {
      trace("retrieval-failed", { retriever: this.retriever.name, error: String(error) });
      return; /* a retriever that throws must never break the turn */
    }
    const scored = candidates
      .map((candidate) => ({ candidate, score: scores.get(candidate.path) as number }))
      .filter((entry) => typeof entry.score === "number" && entry.score > 0)
      .sort((a, b) => b.score - a.score);
    if (!scored.length) return;
    const ranked = scored
      .filter((entry) => !this.seen.has(entry.candidate.path) && !this.staged.has(entry.candidate.path))
      /* Once a session, and never again. `seen` alone says "not while it is still in the
         window", which lets a guess the agent already declined come back the moment the
         window rolls past it. An address may resurface, because a fresh touch means the
         agent is working on that asset again and no longer has the article. A GUESS may
         not: nothing new happened, the agent was offered it and passed, and asking twice
         is what teaches a reader to stop looking.

         Measured before it was changed: a build whose ranked line did not contain the
         capsule re-offered 38% of its suggestions, 151 of 393 in one arm, because
         presence was tested against text that had never been delivered. That was a bug
         in a study build, but the only reason it could express itself as a repeat at all
         is that nothing here said once. */
      .filter((entry) => !this.surfacedEver.has(entry.candidate.path));
    if (!ranked.length) return;
    /* Is the best thing left here worth a line, or did the query merely brush the whole
       residue at once? Measured against the crowd this same query raised rather than
       against a number, for the reason in the option's own comment: a score is a fraction
       of the query's idf mass, so it moves with how much the agent said this turn and with
       how alike the corpus is, and a constant that is right on one project is wrong on the
       next by a multiple.

       The crowd is the best article that will NOT ride: rank RETRIEVED_PER_TURN + 1, the
       one the cap is already about to leave behind. So the question is "does the best beat
       what we were not going to send anyway", which needs no constant of its own and cannot
       be set inconsistently with the cap.

       Both terms come from what is still ELIGIBLE, after the articles already offered this
       session are taken out, because the question is whether to spend a line on what is
       left rather than on what was already delivered. Computed over the whole ranking
       instead, it barely moves: the best and fourth-best answers to a task the agent is
       still working on are the same articles turn after turn, so every turn of a study
       session reported 1.81 to 2.00 whether it had anything new to offer or not. Against
       the eligible set the same sessions separated, 1.68 to 1.81 on the rankings that
       carried a decisive article and 1.00 to 1.28 on the rankings that did not, which is
       the session going quiet as it uses up what was worth saying.

       It is measured near the top of the ranking rather than at a quantile of it because a
       real query is long. An agent's turn touches nearly the whole residue, 377 of 378
       articles in a study session, so a tenth of the way down is deep in the mass sharing
       one common word, and the ratio to it reports the shape of the corpus rather than
       anything about this query: ordinary queries reached 2.64 to 3.28 there and the query
       that had something to find reached 3.10, inside that range rather than above it.

       The cost of tying it to the cap is that four articles genuinely relevant at once
       silence each other. That is the same bet the cap already makes, and it is bounded the
       same way: what is not sent stays eligible next turn.

       Fewer eligible than the cap is the case with no crowd at all. They ride, because
       being one of a handful of articles in the residue that share a word with what the
       agent is doing is the strongest form of standing out, not the weakest. */
    const crowd = ranked.length > RETRIEVED_PER_TURN ? ranked[RETRIEVED_PER_TURN].score : 0;
    const reached = crowd > 0 ? ranked[0].score / crowd : Infinity;
    const passed = reached >= this.standout;
    /* Every ranking, not only the ones that were cut. The number that says a cutoff is set
       too high is the one it silently removed, and the number that says it is set too low
       is the ratio the queries reached anyway; a trace that only records refusals can
       report the first and never the second. Both readings are needed to place it, and
       neither survives being inferred from the scores that rode, because the crowd they
       were measured against is not in those lines. */
    trace("ranked", {
      standout: this.standout,
      reached: reached === Infinity ? null : reached,
      responders: scored.length,
      eligible: ranked.length,
      passed,
    });
    if (!passed) return;
    /* What is already staged counts against the cap.

       undoFlush restages an undelivered message, and restaged entries are excluded from
       the candidate pool by the `staged` check above, so they were invisible to the budget
       and the next turn added a full three on top of them: three, six, nine, twelve ranked
       lines over four failed deliveries (workflow review, 2026-08-13). The cap is on what
       one message carries, so it has to count everything that message will carry, not just
       what this call contributed. */
    const already = [...this.staged.values()].filter((entry) => entry.score !== undefined).length;
    const room = Math.max(0, RETRIEVED_PER_TURN - already);
    for (const { candidate, score } of ranked.slice(0, room)) {
      this.staged.set(candidate.path, {
        capsule: candidate.capsule,
        stamp: candidate.updated ? ` (updated ${candidate.updated})` : "",
        asset: candidate.path,
        score,
      });
      trace("retrieved", {
        path: candidate.path,
        retriever: this.retriever.name,
        score,
        /* So a run can report how much of what it ranked was a rule on purpose. */
        declared: candidate.declared,
      });
    }
    const held = ranked.slice(room);
    if (held.length) {
      trace("retrieval-held", {
        count: held.length,
        /* The best score that did NOT ride this turn, against the worst that did: the
           pair that says whether the cap ever cut anything worth carrying. */
        bestHeld: held[0].score,
        worstSent: room ? ranked[room - 1].score : null,
      });
    }
  }

  /* Stage each newly touched governing article. Nothing is sent or spent here. */
  collect(assets: string[]): void {
    for (const asset of assets) {
      this.touched.add(asset);
      const mount = this.mountFor(asset);
      const article = mount.store.resolve(asset, mount.dir);
      if (!article) continue;
      const key = mount.name ? `${mount.name}:${article.path}` : article.path;
      this.pendingUpdates.add(key);
      if (this.seen.has(key) || this.staged.has(key)) continue;
      const stamp = article.updated ? ` (updated ${article.updated})` : "";
      this.staged.set(key, { capsule: article.capsule, stamp, asset });
      trace("staged", { path: key, asset });
    }
  }

  /* Everything staged since the last flush, as one message. Nothing is held back and
     nothing is truncated: an article whose governing asset this turn touched either
     surfaces whole or does not surface. Cost is recorded per line rather than charged
     against an allowance, so a nudge withdrawn by markSeen still costs nothing and the
     funnel stays auditable. An article with no capsule surfaces as a pointer, which is
     the only remaining reason a line is not the capsule text. */
  flush(): string | undefined {
    this.intent = [];
    this.lastFlush.clear();
    if (!this.staged.size) return undefined;
    /* Addressed articles first, in the order they were touched, because the address is
       a certainty and nothing ranked should push it down the message. Retrieved ones
       follow, best score first. */
    const order = [...this.staged.entries()].sort((a, b) => {
      const left = a[1].score, right = b[1].score;
      if (left === undefined && right === undefined) return 0;
      if (left === undefined) return -1;
      if (right === undefined) return 1;
      return right - left;
    });
    const lines: string[] = [];
    for (const [path, entry] of order) {
      const line = entry.capsule
        ? `${path}${entry.stamp}: ${entry.capsule}`
        : `${path}${entry.stamp}: article exists. Read it before relying on ${entry.asset}.`;
      lines.push(line);
      this.cost.set(path, line.length);
      this.surfacedEver.add(path);
      trace("surfaced", {
        path,
        chars: line.length,
        capsule: Boolean(entry.capsule),
        /* The pair the analysis wants: what it cost, and how relevant it was thought to
           be. null is the address, which was never ranked and never needed to be. */
        score: entry.score ?? null,
        via: entry.score === undefined ? "address" : this.retriever.name,
      });
      this.seen.add(path);
      /* The LINE, which is what actually entered the window. Remembering the capsule
         instead was right only while every line happened to contain its capsule, and two
         cases break that. An article with no capsule surfaces as a pointer, so the mark was
         built from an empty string, fell under MARK_MINIMUM, and left the article seen for
         the rest of the session: it could never surface again however long ago it left the
         window. A build whose ranked line did not carry the capsule hit the mirror image,
         testing for text that had never been shown and reading as departed every turn.
         Both are the same mistake, which is testing presence against something other than
         what was delivered.

         This also retires the workaround the short-capsule case needed. A line always
         carries its own address, so it always clears MARK_MINIMUM: `Cache.` fingerprints to
         5 characters and its line to 39. The guard still earns its place on the other call
         site, where a read of a tiny article really can be too short to test. */
      this.remember(path, line);
      this.lastFlush.set(path, entry);
      this.staged.delete(path);
    }
    const plural = lines.length > 1 ? "s" : "";
    trace("flushed", { lines: lines.length, chars: this.stats.chars });
    return (
      `[pi-canon] Governing article${plural} for what this turn touches. Read the full article with ` +
      `pi_canon before depending on details; update it after real changes.\n${lines.join("\n")}`
    );
  }

  /* Put back everything the last flush and settle committed. Both mark their work done
     before the message is handed to pi, because the message is built from that work; if
     the send then fails, the agent never saw the nudge and the state is a lie. Undoing
     restages the lines and restores the reminders, so the next turn tries again. */
  undoFlush(): void {
    for (const [path, entry] of this.lastFlush) {
      this.staged.set(path, entry);
      this.seen.delete(path);
      this.marks.delete(path);
      this.cost.delete(path);
      this.surfacedEver.delete(path);
    }
    this.lastFlush.clear();
    for (const path of this.lastNudge) this.pendingUpdates.add(path);
    this.lastNudge = [];
    trace("delivery-undone", {});
  }

  /* The write-after half of the doctrine: every governing article touched since its
     last update draws one reminder, then the slate clears for the next batch. */
  settleNudge(): string | undefined {
    const stale = [...this.pendingUpdates];
    this.lastNudge = stale;
    this.pendingUpdates.clear();
    if (!stale.length) return undefined;
    trace("settle-nudge", { paths: stale });
    return (
      `[pi-canon] Touched but not updated: ${stale.join(", ")}. If this work changed what is true, ` +
      `update the article with pi_canon; if nothing durable changed, leave it.`
    );
  }

  /* The write-after check the settle reminder cannot carry. The measured failure runs
     the other way from staleness: a session works on an asset, then records the rule it
     was following, and ends with code that disobeys the article it just wrote. Sessions
     that looked back at the asset fixed it every time; sessions that did not never saw
     it. The write is the one moment both halves are in hand, the rule as recorded and
     the touched asset it governs, and a settle reminder rides the next turn, which a
     session that ends at the write never hears.

     Touches are re-resolved here rather than looked up, because the governing article is
     often CREATED by this very write: at touch time there was nothing to resolve to.
     Once per article per session; asking twice is what teaches a reader to stop
     looking. */
  checkBack(written: string): string | undefined {
    if (this.checkedBack.has(written)) return undefined;
    for (const asset of this.touched) {
      const mount = this.mountFor(asset);
      const article = mount.store.resolve(asset, mount.dir);
      if (!article) continue;
      const key = mount.name ? `${mount.name}:${article.path}` : article.path;
      if (key !== written) continue;
      this.checkedBack.add(written);
      /* The asset is in the record because the path alone cannot distinguish a real
         touch from a write that somehow triggered itself: an audit of this channel
         needs to see WHAT the session touched to earn the line (Sol Pro, 2026-08-14). */
      trace("check-back", { path: written, asset });
      return (
        "This session touched the asset this article governs. Check the asset as it " +
        "stands does what the article says; the session that records a rule is the one " +
        "most likely to have just broken it."
      );
    }
    return undefined;
  }
}
