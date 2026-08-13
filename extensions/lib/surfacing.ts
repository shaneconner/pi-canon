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

   A mark is a normalized slice of what the article put in the window. Normalizing
   both sides to lowercase alphanumerics survives JSON escaping, whitespace
   rewrapping, and quoting differences between however the projection is rendered and
   however we wrote it. A short mark is not distinctive enough to test, so it is never
   expired; failing to expire only costs a re-surface that does not happen, while a
   false expiry would spam the window.

   The mark is the TAIL of whatever actually entered the window, and the caller passes
   the whole of it. This corrects a real defect (Codex, 2026-08-12): the capsule used
   to be the mark for both paths, so an article read in full stayed "present" on the
   strength of its surviving capsule line while the body that held the rule had been
   folded away, which is the one case presence exists to catch. A surfaced line is its
   capsule and marks on the capsule; a read is capsule plus body and marks on the body.
   The tail rather than the head because the two ways content leaves a window are not
   symmetric: a fold takes the whole message, and a truncation takes the end first, so
   a head mark survives exactly the loss it should report. */
const MARK_CHARS = 120;
const MARK_MINIMUM = 24;

/* Escaped whitespace first, then the normal pass. A projection is read through
   JSON.stringify, which renders a newline as the two characters \ and n, and n is a
   letter: dropping only non-alphanumerics leaves a stray "n" token exactly where the
   article had a line break, so the two sides stop agreeing at every boundary a break
   crosses. Invisible while marks came from single-line capsules. The moment a mark is
   drawn from a body it decides the mechanism, and in the direction that spams: a mark
   that can never match is an article that is never present and re-surfaces on every
   touch. Applied to both sides, so it corrects rather than tilts. */
function fingerprint(text: string): string {
  return text.replace(/\\[nrt]/g, " ").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
  private marks = new Map<string, string>();
  private pendingUpdates = new Set<string>();
  private staged = new Map<string, { capsule: string; stamp: string; asset: string; score?: number }>();
  private retriever: Retriever;
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

  constructor(mounts: Mount[], retriever: Retriever = NONE, resurface = true) {
    this.mounts = mounts;
    this.retriever = retriever;
    this.resurface = resurface;
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
  }

  private remember(path: string, text: string | undefined): void {
    const print = fingerprint(text ?? "");
    if (print.length >= MARK_MINIMUM) this.marks.set(path, print.slice(-MARK_CHARS));
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
    let projection: string;
    try {
      projection = fingerprint(JSON.stringify(messages));
    } catch {
      return; /* an unserializable projection is no evidence of absence */
    }
    /* Read before the expiry check and independently of it: the projection is the only
       place the user's own words are visible, and a run with resurface off still wants
       them for the query. Presence is what the switch governs, not observation. */
    this.spoken = userIntent(messages);
    if (!this.resurface) return;
    for (const path of [...this.seen]) {
      const mark = this.marks.get(path);
      if (!mark || projection.includes(mark)) continue;
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

  /* Rank the residue against this turn's intent and stage what the query touched.

     `score > 0` is not a tuned threshold. With BM25 normalized against its saturation
     ceiling it means "at least one query term appears in this article at all", which is
     a property of the query rather than a constant someone picked. Where a real cutoff
     belongs is a question for the data: every staged line carries its score and records
     what it cost, so context taken can be read against relevance afterwards. Deciding
     it in advance with a constant is the mistake the session budget already made.

     The project store only. A mount is somebody else's directory and its residue is
     their business, and the spine already serves mounted assets by address. */
  retrieve(): void {
    if (this.retriever === NONE) return;
    /* Oldest first, so intentQuery's newest-first walk reads in true order: this turn's
       tool calls lead, the question that prompted them follows. */
    const turns = [...this.spoken, ...this.intent];
    if (!turns.length) return;
    const { store, dir } = this.project;
    const candidates = residue(store, dir);
    if (!candidates.length) return;
    /* Rebuilt every turn rather than cached behind a change check. `updated` has day
       granularity, so an article rewritten in the same session carries the same stamp
       and any signature built from it would serve a stale ranking for the rest of the
       run. The residue is small by construction, being only what no address reaches, so
       the honest rebuild costs less than the bug the cache would hide. */
    this.retriever.index?.(candidates);
    const query = intentQuery(turns);
    if (!query.trim()) return;
    let scores: Map<string, number>;
    try {
      scores = this.retriever.score(query, candidates);
    } catch (error) {
      trace("retrieval-failed", { retriever: this.retriever.name, error: String(error) });
      return; /* a retriever that throws must never break the turn */
    }
    for (const candidate of candidates) {
      const score = scores.get(candidate.path);
      if (!(typeof score === "number") || !(score > 0)) continue;
      if (this.seen.has(candidate.path) || this.staged.has(candidate.path)) continue;
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
  }

  /* Stage each newly touched governing article. Nothing is sent or spent here. */
  collect(assets: string[]): void {
    for (const asset of assets) {
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
      this.remember(path, entry.capsule);
      this.staged.delete(path);
    }
    const plural = lines.length > 1 ? "s" : "";
    trace("flushed", { lines: lines.length, chars: this.stats.chars });
    return (
      `[pi-canon] Governing article${plural} for what this turn touches. Read the full article with ` +
      `pi_canon before depending on details; update it after real changes.\n${lines.join("\n")}`
    );
  }

  /* The write-after half of the doctrine: every governing article touched since its
     last update draws one reminder, then the slate clears for the next batch. */
  settleNudge(): string | undefined {
    const stale = [...this.pendingUpdates];
    this.pendingUpdates.clear();
    if (!stale.length) return undefined;
    trace("settle-nudge", { paths: stale });
    return (
      `[pi-canon] Touched but not updated: ${stale.join(", ")}. If this work changed what is true, ` +
      `update the article with pi_canon; if nothing durable changed, leave it.`
    );
  }
}
