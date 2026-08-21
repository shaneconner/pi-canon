/* The pi_canon tool: one tool, five verbs. Read and update over create; the journal
   for events; map to orient; search when the agent asks. */

import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { advise, orphaned, unretained } from "./lint.ts";
import { checkArticle, loadSchema, outgoingOf, READ_ONLY, SCHEMA_FILE } from "./schema.ts";
import { contained, normalize, type CanonStore } from "./store.ts";
import { type Candidate, LexicalRetriever, RULE_SCOPE } from "./retrieval.ts";
import type { Mount, Surfacer } from "./surfacing.ts";

export interface CanonRuntime {
  store: CanonStore;
  surfacer: Surfacer;
  cwd: string;
  mounts: Mount[];
  retrieval: string;
  provenance?: { harness: string; sessionId?: string };
}

export const CANON_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["read", "write", "journal", "map", "search"] },
    path: {
      type: "string",
      description: "Article address, e.g. src/core/config. Required for read and write; optional filter for map.",
    },
    body: {
      type: "string",
      description:
        "write: the full article body; specifics beat summaries (who consumes what, exact " +
        "limits, what breaks). journal: the event text, source details intact.",
    },
    capsule: { type: "string", description: "write: one dense line injected when the asset is touched." },
    query: { type: "string", description: "search: words to look for, across articles and the journal." },
    journal: {
      type: "boolean",
      description:
        "search: true to include journal entries in the results. Off by default because " +
        "events are history, not current truth; the result names how many entries matched " +
        "so you can opt in when the history is the point.",
    },
    scope: {
      type: "string",
      enum: ["rule", "asset"],
      description:
        "write: 'rule' when this article names a cross-cutting rule instead of governing an " +
        "asset, so it is a rule on purpose rather than an article whose asset went missing; " +
        "'asset' to take that back, when the article governs an asset after all.",
    },
    subject: {
      type: "array",
      items: { type: "string" },
      description: "journal: article addresses this event concerns.",
    },
    slug: { type: "string", description: "journal: short name for the entry file." },
  },
  required: ["action"],
} as const;

export function canonToolDescription(retrieval = "none"): string {
  return (
    "Canonical project memory. Every asset has at most one governing article at its own address " +
    "(src/core/config, lake/prices). read the governing article before working on an asset; " +
    "write it after real changes. journal appends an immutable event entry: record the source " +
    "as it happened, names and exact numbers included, because articles distill and only the " +
    "journal keeps the original, so distil the prose but carry exact values through verbatim: " +
    "ids, keys, names, counts, limits and durations, every member of a named set and not " +
    "just the one you are working on. A rule without its values is worth nothing to the " +
    "session that needs it. map lists articles with their capsules. " +
    "Creation is rare: prefer updating the article that already governs. " +
    "File a constraint at the asset it governs, or the shared parent when it spans assets, not " +
    "the asset you happened to edit. " + filingTail(retrieval)
  );
}

/* A path routes to the mount it names (lake:prices), the mount whose directory
   contains it, or the project. */
function route(runtime: CanonRuntime, raw: string): { mount: Mount; path: string } {
  const qualified = /^([\w.-]+):(.*)$/.exec(raw);
  if (qualified) {
    const mount = runtime.mounts.find((m) => m.name === qualified[1]);
    if (mount) return { mount, path: settle(mount, qualified[2], mount.dir) };
  }
  const slashed = raw.replace(/\\/g, "/");
  for (const mount of runtime.mounts) {
    if (mount.name && (slashed === mount.dir || slashed.startsWith(`${mount.dir}/`))) {
      return { mount, path: settle(mount, slashed, mount.dir) };
    }
  }
  return { mount: runtime.mounts[0], path: settle(runtime.mounts[0], raw, runtime.cwd) };
}

/* An address that already names an article wins over canonicalising it a second time.
   normalize drops one extension at the asset boundary, so the article governing
   src/core/config.test.ts lives at src/core/config.test, which is the address map
   prints. Feeding that address back to read used to normalize again down to
   src/core/config and silently return a DIFFERENT article whenever the parent existed
   (Sol Pro, 2026-08-13). An asset on disk still wins, so a real file named config.test
   is not mistaken for the canonical address of config.test.ts. */
function settle(mount: Mount, raw: string, cwd: string): string {
  const exact = contained(raw, cwd);
  if (exact && !existsSync(join(mount.dir, exact)) && mount.store.read(exact)) return exact;
  return normalize(raw, cwd);
}

export function buildCanonTool(ready: (ctx: unknown) => CanonRuntime, retrieval = "none") {
  return {
    name: "pi_canon",
    label: "pi-canon",
    description: canonToolDescription(retrieval),
    parameters: CANON_TOOL_PARAMETERS,
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: unknown,
      _onUpdate: unknown,
      ctx: unknown,
    ) {
      const text = runCanon(ready(ctx), params);
      return { content: [{ type: "text", text }], details: {} };
    },
  };
}

/* The last clause of the filing rule is configuration dependent, and getting it wrong
   in either direction costs knowledge. With no retriever an article at an address that
   governs no asset is genuinely unreachable, so the doctrine must not invite one: the
   only honest instruction is to keep everything on the asset path. With a retriever
   that same article is reachable by relevance, and the instruction inverts, because the
   alternative is filing a constraint that spans unrelated packages at their only shared
   parent, which is the root, and a root article surfaces on every touch of anything.

   Taken from the caller, which built the retriever, rather than read back off the
   runtime: the runtime is created from the session's ctx, and forcing it into existence
   at registration to answer this would pin it to the wrong working directory. */
function filingTail(retrieval: string): string {
  if (retrieval === "none") {
    return "Knowledge filed off the asset path never surfaces.";
  }
  return (
    "A constraint that governs many assets and owns none belongs at its own address, one " +
    "naming the rule rather than any asset, because the only parent unrelated packages share " +
    "is the root and a root article surfaces on every touch of anything. Those articles are " +
    "reached by relevance to the work rather than by address, so give them a capsule that " +
    "reads like the situation it governs, and write them with scope rule so a rule on purpose " +
    "is not mistaken for an article whose asset went missing."
  );
}

/* Agent-solicited search, over articles AND the journal.

   Three channels reach this memory and their scopes differ on purpose. Surfacing on touch is
   ADDRESS ONLY: you touched an asset, you get the article governing it. Search is ANY: the
   agent asked, so nothing is withheld, and a journal entry is a first class result even
   though it has no address at all.

   Every result carries what SCOPES it, which is the one thing a result cannot be useful
   without. A study of a 259 KB flat memory found grep returning 201 occurrences of one
   answer with nothing saying which subsystem each applied to; the sessions almost never
   received the governing fact under its own scope, and scored accordingly. For an article
   the scope is its address; for a journal entry it is the instant and the subjects it
   named. Neither is decoration.

   Ranking reuses LexicalRetriever rather than growing a second notion of relevance, so search
   and recommendation cannot drift apart.

   The journal is opt-in (Shane, 2026-08-20): events are history, not current truth,
   and R1 measured what including them by default cost, journal entries about an
   event crowding out the article that carries its current truth for 8 to 20 points
   of governing-article recall at realistic query lengths. Default search ranks
   articles alone, never reads a journal body, and says the journal exists; with
   journal true the window is split, articles up to half, journal the rest,
   whichever side runs short ceding its slots. Current truth first, always. */
const SEARCH_RESULTS = 10;
const ARTICLE_SLOTS = 5;

function search(store: CanonStore, query: string, includeJournal: boolean): string {
  if (!query.trim()) return "search needs a query.";
  const articles: Candidate[] = [];
  for (const path of store.list()) {
    const article = store.read(path);
    if (article) {
      articles.push({
        path,
        capsule: article.capsule,
        body: article.body,
        updated: article.updated,
        declared: article.scope === RULE_SCOPE,
      });
    }
  }
  /* Journal entries enter the same index under a `journal/` key so one ranking covers both.
     The key is an index handle, never an address: it is not something `read` accepts.
     Built only on opt-in, so a default search never pays for reading every entry body. */
  const byKey = new Map<string, { logged: string; subjects: string[]; body: string }>();
  const journal: Candidate[] = !includeJournal
    ? []
    : store.journalEntries().map((entry) => {
        const key = `journal/${entry.name.replace(/\.md$/, "")}`;
        byKey.set(key, entry);
        return {
          path: key,
          capsule: entry.subjects.join(", "),
          body: entry.body,
          updated: entry.logged,
          declared: false,
        };
      });
  const invitation =
    !includeJournal && store.journalCount() > 0
      ? "The journal was not searched; pass journal true to search events too."
      : "";

  const all = [...articles, ...journal];
  if (!all.length) return "Nothing in the canon yet.";
  const retriever = new LexicalRetriever();
  retriever.index(all);
  const scored = retriever.score(query, all);
  const ranked = [...scored.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return [`Nothing matches "${query}".`, invitation].filter(Boolean).join(" ");

  const articleRanked = ranked.filter(([key]) => !byKey.has(key));
  const journalRanked = ranked.filter(([key]) => byKey.has(key));
  const articleQuota = Math.min(
    articleRanked.length,
    Math.max(ARTICLE_SLOTS, SEARCH_RESULTS - journalRanked.length),
  );
  const journalQuota = Math.min(journalRanked.length, SEARCH_RESULTS - articleQuota);
  const chosen = [...articleRanked.slice(0, articleQuota), ...journalRanked.slice(0, journalQuota)];

  const lines = chosen.map(([key]) => {
    const entry = byKey.get(key);
    if (entry) {
      const subjects = entry.subjects.length ? ` (${entry.subjects.join(", ")})` : "";
      return `journal ${entry.logged}${subjects}: ${excerpt(entry.body)}`;
    }
    const article = store.read(key);
    return `${key}: ${article?.capsule || excerpt(article?.body ?? "")}`;
  });
  /* Say what was dropped. A silent cap reads as "that is everything". */
  if (ranked.length > chosen.length) {
    lines.push(`... ${ranked.length - chosen.length} more matched; narrow the query to see them.`);
  }
  if (invitation) lines.push(invitation);
  return lines.join("\n");
}

function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
}

export function runCanon(runtime: CanonRuntime, params: Record<string, unknown>): string {
  const { surfacer } = runtime;
  const action = String(params.action ?? "");
  const { mount, path } = typeof params.path === "string" ? route(runtime, params.path) : { mount: runtime.mounts[0], path: "" };
  const store = mount.store;
  const qualify = (p: string) => (mount.name ? `${mount.name}:${p}` : p);

  switch (action) {
    case "read": {
      if (!path) return "read needs a path.";
      /* Exact address first, ancestors only if nothing governs it directly. resolve()
         normalizes what it is given, and route has already produced a canonical
         address, so handing it straight to resolve drops a second extension and
         answers src/core/config.test with src/core/config. */
      const article = store.read(path) ?? store.resolve(path);
      if (!article) {
        return `No article governs ${path}. If you are working on this asset, create its article with write after the task.`;
      }
      /* Everything this result is about to put in the window, so presence is tested
         against the body it delivered rather than the capsule it happens to share with
         a one-line surfaced nudge. An article whose body folds away is not present. */
      surfacer.markSeen(qualify(article.path), `${article.capsule}\n${article.body}`);
      const title = article.path === path ? qualify(article.path) : `${qualify(article.path)} governs ${qualify(path)}`;
      const head = [
        article.capsule ? `capsule: ${article.capsule}` : "",
        article.updated ? `updated: ${article.updated}` : "",
      ].filter(Boolean).join("\n");
      /* Filenames only, newest three: the index invites digging, it never pays for it. */
      const mentions = runtime.mounts[0].store.journalMentions(qualify(article.path));
      const recent = mentions.slice(-3).reverse();
      const earlier = mentions.length - recent.length;
      const index = recent.length
        ? `\n\njournal: ${recent.join(", ")}${earlier ? ` and ${earlier} earlier` : ""}`
        : "";
      /* Reads never reject, but they do report: an agent holding a noncompliant
         article is the one agent positioned to heal it, and silence here is how a
         store drifts out of its own contract one read at a time. */
      const { schema, problems } = loadSchema(store.root);
      const standing = schema ? checkArticle(article, schema, READ_ONLY) : { rejections: [], warnings: [] };
      const issues = [...standing.warnings, ...problems];
      const report = issues.length
        ? `\n\nschema (${SCHEMA_FILE}): ${issues.join(" ")} This article can be healed with a write.`
        : "";
      const missing = orphaned(mount.dir, article);
      const orphan = missing ? `\n\n${missing}` : "";
      return `${title}\n${head}\n\n${article.body}`.trim() + index + report + orphan;
    }
    case "write": {
      if (!path) return "write needs a path.";
      /* Blank means untouched: models fill declared string fields with "" routinely,
         and a "" here would silently erase stored content. */
      /* The stored body BEFORE this write, whether or not this write supplies one. Read
         only when a body was supplied, it was undefined on every capsule-only write, so
         the scope question tested its trigger against "" and re-fired on an article that
         had carried the same rule for weeks. What the advice needs is the article's real
         prior state; which fields this call happened to set is a separate question and is
         answered separately below. */
      const prior = store.read(path);
      const fields = {
        capsule: params.capsule ? String(params.capsule) : undefined,
        body: params.body ? String(params.body) : undefined,
        /* "asset" is the way back. The enum is the only vocabulary the model has, so
           without a second value an article declared `scope: rule` could never stop being
           one: every other input falls through to undefined, which means untouched. It
           stores empty, which is the default state, the address being the claim. */
        scope: params.scope === "asset" ? "" : params.scope ? String(params.scope) : undefined,
      };
      /* The store's declared contract, held against the article this write WOULD
         store, before anything touches disk. Only a required rule the write itself
         touched (or a brand new article) rejects; everything else warns, so the write
         still lands and the agent still learns. */
      const { schema, problems } = loadSchema(store.root);
      const composed = store.compose(path, fields);
      const verdict = schema
        ? checkArticle(composed, schema, {
            capsule: fields.capsule !== undefined,
            body: fields.body !== undefined,
            /* Touched means the reference SET changed, not that a body was sent: a
               body edit that keeps its citations must not re-litigate them. */
            refs: outgoingOf(prior ? prior.body : "").join("\n") !== outgoingOf(composed.body).join("\n"),
            created: !prior,
          })
        : { rejections: [], warnings: [] };
      if (verdict.rejections.length) {
        return [
          `Write rejected by this store's ${SCHEMA_FILE}:`,
          ...verdict.rejections.map((line) => `- ${line}`),
          "Nothing was written. Fix the listed fields and write again.",
        ].join("\n");
      }
      /* A write that changes nothing is a restatement, not a change. Measured (W1j):
         restating the current state through the write path was the one store
         corruption no content rule could catch, because no field differs; the only
         thing it changed was the freshness stamp, which then lied. So equality is
         checked here, mechanically, and `updated` keeps meaning what it says. */
      if (
        prior &&
        composed.capsule === prior.capsule &&
        composed.scope === prior.scope &&
        composed.body.trimEnd() === prior.body.trimEnd()
      ) {
        surfacer.markUpdated(
          qualify(composed.path),
          [params.capsule, params.body].filter(Boolean).map(String).join("\n"),
        );
        return [
          `${qualify(composed.path)} is already current: this write matches the stored article, ` +
            `so nothing was rewritten and updated stays ${prior.updated}.`,
          ...verdict.warnings.map((line) => `schema: ${line}`),
          ...problems,
        ].join("\n");
      }
      const article = store.write(path, fields);
      /* When a rewrite grows the body, the result says so and restates the split.
         Measured (W4, two arms over identical eight-session lineages): writers
         narrate history into articles until the store outgrows the raw transcripts
         it distills, prompt-side guidance does not change the habit, and this one
         line at the write boundary cut standing superseded values from 88 to 51 of
         96 and final store bytes by a fifth, with no reader regression. Any growth
         fires; that exact behavior is what was measured. Creation is not growth,
         and a capsule-only write never grows the stored body. */
      const priorBytes = prior ? Buffer.byteLength(prior.body.trimEnd()) : null;
      const nextBytes = Buffer.byteLength(composed.body.trimEnd());
      const growth =
        priorBytes !== null && nextBytes > priorBytes
          ? [
              `Body grew ${priorBytes} -> ${nextBytes} bytes. An article carries current ` +
                `state; if this growth is narrated history (old values, transitions), move ` +
                `it to the journal and keep the article at what is true now.`,
            ]
          : [];
      /* What this write put in the window, which is what the agent supplied, not the
         merged article: a capsule-only write does not deliver the stored body. */
      surfacer.markUpdated(
        qualify(article.path),
        [params.capsule, params.body].filter(Boolean).map(String).join("\n"),
      );
      const missingAsset = orphaned(mount.dir, article);
      return [
        `Wrote ${qualify(article.path)}.`,
        ...growth,
        ...verdict.warnings.map((line) => `schema: ${line}`),
        ...problems,
        ...advise(article, store, prior?.body, { dir: mount.dir, retrieval: runtime.retrieval }, schema),
        ...(missingAsset ? [missingAsset] : []),
      ].join("\n");
    }
    case "journal": {
      const body = typeof params.body === "string" ? params.body.trim() : "";
      if (!body) return "journal needs a body: what happened, densely.";
      /* Events are project history; the journal always lives in the project store,
         with subjects qualified so mounted articles index them too. */
      const subject = Array.isArray(params.subject)
        ? params.subject.map((s) => {
            const routed = route(runtime, String(s));
            return routed.mount.name ? `${routed.mount.name}:${routed.path}` : routed.path;
          })
        : undefined;
      const file = runtime.mounts[0].store.journal({
        body,
        subject,
        slug: typeof params.slug === "string" ? params.slug : undefined,
        provenance: runtime.provenance,
      });
      /* The article was written before this entry (agents write then journal), so this
         is the first moment both exist. Report what the source kept and the article did
         not: capbase measured the journal holding every value and the article keeping a
         quarter of them, and cap1 measured an article without its values scoring exactly
         what no article scores. */
      const missed: string[] = [];
      for (const address of subject ?? []) {
        const routed = route(runtime, address);
        const governing = routed.mount.store.read(routed.path);
        for (const value of unretained(body, governing)) {
          missed.push(`${address} is missing ${value}`);
        }
      }
      return [
        `Logged ${basename(file)}.`,
        ...(missed.length
          ? [
              `This entry records values its article does not carry: ${missed.slice(0, 6).join("; ")}. ` +
                "The article is what surfaces on a touch; the journal is not. If those values " +
                "matter beyond this event, put them in the article verbatim.",
            ]
          : []),
      ].join("\n");
    }
    case "map":
      return store.map(path);
    case "search":
      return search(store, String(params.query ?? ""), params.journal === true);
    default:
      return `Unknown action "${action}". Actions: read, write, journal, map, search.`;
  }
}
