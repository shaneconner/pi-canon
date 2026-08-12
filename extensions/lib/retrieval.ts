/* Retrieval: the seam for knowledge the spine cannot address.

   The spine answers every asset-scoped question deterministically and for free, and
   nothing here changes that. Retrieval runs over the RESIDUE, the articles whose
   address matches no asset, which is the category 1.0 named and left open ("knowledge
   filed off the asset path never surfaces"). That scoping is what makes an expensive
   ranker affordable: the corpus to rank is what has no home, not the whole store, and
   it stays small precisely because everything with a home is answered without ranking.

   Two built-ins ship. `none` is 1.0 exactly and is the experiment's control. `lexical`
   is BM25 with nothing but the standard library. Anything that needs a model is
   supplied by the caller as a function, so this package never grows a torch, ONNX or
   network dependency and never decides which model you run.

   Deliberately absent: any threshold. A retriever returns SCORES, and what to do with
   them is measured rather than assumed. A constant deciding what an agent gets to see
   is the mistake the session budget already made once. */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CanonStore } from "./store.ts";

export interface Candidate {
  path: string;
  capsule: string;
  body: string;
  updated: string;
}

export interface Retriever {
  name: string;
  /* Called off the hot path whenever the residue changes. Free to be a no-op. */
  index?(candidates: Candidate[]): void;
  /* Higher is more relevant. A path missing from the result scored nothing. */
  score(query: string, candidates: Candidate[]): Map<string, number>;
}

/* ---------------------------------------------------------------------------------
   The query: intent, never evidence.

   pi-fold measured this on memex and it is the single most expensive thing to get
   wrong: a live window of 29,369 characters carried 29,244 characters of raw tool
   output and 125 characters of the agent's own reasoning, so a lexical scorer was
   matching against `read` and `shell` dumps and every retrieval number it produced was
   that one defect. Tool RESULTS are therefore excluded outright.

   The agent's own prose is excluded for a second, independent reason. Accordion's
   relevance-signals exploration showed that a signal read off text the agent already
   produced is retrospective: the text was generated while the article was absent, so
   scoring against it measures agreement with the path already taken rather than need.
   Where the agent went wrong for lack of an article, its own words argue against it.

   What survives both objections is intent. A user message is exogenous and is a
   statement of what is wanted. A tool call is agent-authored but is a forward
   declaration of an action rather than reasoning about content, so the circularity
   objection does not reach it; its name plus first meaningful argument is the whole
   signal, and the rest is payload.
---------------------------------------------------------------------------------- */

const INTENT_ARGUMENT_KEYS = ["path", "file_path", "pattern", "query", "command", "description"];
const INTENT_ARGUMENT_CHARS = 200;

export interface IntentTurn {
  role?: unknown;
  content?: unknown;
  toolName?: unknown;
  input?: unknown;
}

function firstArgument(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  for (const key of INTENT_ARGUMENT_KEYS) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, INTENT_ARGUMENT_CHARS);
  }
  return "";
}

/* Newest first, because relevance to now sits at the tail: replaying 56 real retrieval
   targets, pi-fold measured MRR 0.1071 with 10 targets in the top 5 for the newest half
   of a window against 0.0485 and 4 for the oldest half of the SAME window, which makes
   it a position effect rather than a length effect. */
export function intentQuery(turns: readonly IntentTurn[]): string {
  const pieces: string[] = [];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn?.toolName) {
      const argument = firstArgument(turn.input);
      pieces.push(argument ? `${String(turn.toolName)} ${argument}` : String(turn.toolName));
      continue;
    }
    if (turn?.role === "user" && typeof turn.content === "string" && turn.content.trim()) {
      pieces.push(turn.content.trim());
    }
  }
  return pieces.join("\n");
}

/* ---------------------------------------------------------------------------------
   BM25, standard library only.

   Reimplemented rather than lifted from pi-fold. The two packages publish
   independently, and a verbatim copy between them rebuilds exactly the drift problem
   pi-fold deliberately retired. What crosses is the lessons, above and below, not the
   code.
---------------------------------------------------------------------------------- */

const K1 = 1.5;
const B = 0.75;
const MIN_TOKEN = 4;
const STOPWORDS = new Set([
  "about", "after", "again", "against", "because", "been", "before", "being", "between",
  "both", "cannot", "could", "does", "doing", "down", "during", "each", "from", "further",
  "have", "having", "here", "into", "itself", "just", "more", "most", "once", "only",
  "other", "over", "same", "should", "some", "such", "than", "that", "their", "them",
  "then", "there", "these", "they", "this", "those", "through", "under", "until", "very",
  "were", "what", "when", "where", "which", "while", "will", "with", "would", "your",
]);

/* Tokens WITH repetition: BM25 reads term frequency, and deduping here would silently
   flatten every tf to 1. */
export function tokens(value: string): string[] {
  const out: string[] = [];
  for (const raw of value.toLowerCase().split(/[^a-z0-9_]+/)) {
    const token = raw.replace(/^_+|_+$/g, "");
    if (token.length < MIN_TOKEN || STOPWORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}

interface Indexed {
  length: number;
  frequencies: Map<string, number>;
}

export class LexicalRetriever implements Retriever {
  readonly name = "lexical";
  private documents = new Map<string, Indexed>();
  private documentFrequency = new Map<string, number>();
  private averageLength = 0;

  index(candidates: Candidate[]): void {
    this.documents = new Map();
    this.documentFrequency = new Map();
    let total = 0;
    for (const candidate of candidates) {
      const frequencies = new Map<string, number>();
      const terms = tokens(`${candidate.path} ${candidate.capsule} ${candidate.body}`);
      for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
      this.documents.set(candidate.path, { length: terms.length, frequencies });
      total += terms.length;
      for (const term of frequencies.keys()) {
        this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
      }
    }
    this.averageLength = candidates.length ? total / candidates.length : 0;
  }

  private idf(term: string): number {
    const n = this.documentFrequency.get(term) ?? 0;
    if (!n) return 0;
    return Math.log(1 + (this.documents.size - n + 0.5) / (n + 0.5));
  }

  /* Divide by what a document scores when every query term is saturated in it. BM25's
     raw score is unbounded and its scale moves with the query, so the same number means
     different things run to run; against the ceiling it is an absolute 0..1 reading,
     which is what makes a score comparable across turns and worth recording beside the
     context it cost. */
  private ceiling(terms: ReadonlySet<string>): number {
    let ceiling = 0;
    for (const term of terms) ceiling += this.idf(term) * (K1 + 1);
    return ceiling;
  }

  score(query: string, candidates: Candidate[]): Map<string, number> {
    const out = new Map<string, number>();
    const terms = new Set(tokens(query));
    if (!terms.size || !this.documents.size) return out;
    const ceiling = this.ceiling(terms);
    if (ceiling <= 0) return out;
    for (const candidate of candidates) {
      const document = this.documents.get(candidate.path);
      if (!document?.length) continue;
      let score = 0;
      for (const term of terms) {
        const frequency = document.frequencies.get(term);
        if (!frequency) continue;
        const denominator =
          frequency + K1 * (1 - B + B * (document.length / (this.averageLength || 1)));
        score += this.idf(term) * ((frequency * (K1 + 1)) / denominator);
      }
      if (score > 0) out.set(candidate.path, score / ceiling);
    }
    return out;
  }
}

export const NONE: Retriever = {
  name: "none",
  score: () => new Map(),
};

export type RetrievalOption = "none" | "lexical" | Retriever;

export function buildRetriever(option: RetrievalOption | undefined): Retriever {
  if (option === undefined || option === "none") return NONE;
  if (option === "lexical") return new LexicalRetriever();
  if (typeof option === "object" && option && typeof option.score === "function") {
    if (typeof option.name !== "string" || !option.name.trim()) {
      throw new Error("pi-canon: a retrieval object needs a name, so runs can be told apart.");
    }
    return option;
  }
  throw new Error(
    `pi-canon: retrieval must be "none", "lexical", or an object with a name and a score function; got ${
      typeof option === "string" ? `"${option}"` : typeof option
    }.`,
  );
}

/* The residue: articles at addresses that govern no asset on disk. These are exactly
   the ones the spine can never surface, because surfacing is triggered by touching an
   asset and there is nothing to touch. Everything else is already answered for free and
   must not be ranked, or retrieval would compete with the address instead of completing
   it. */
export function residue(store: CanonStore, dir: string): Candidate[] {
  const out: Candidate[] = [];
  for (const path of store.list()) {
    if (governsAnAsset(dir, path)) continue;
    const article = store.read(path);
    if (article) out.push({ path, capsule: article.capsule, body: article.body, updated: article.updated });
  }
  return out;
}

/* An address governs an asset when something on disk normalizes back to it. Addresses
   drop the extension, so `src/core/config` has to match `src/core/config.ts` as well as
   a bare `src/core/config` directory or file, which is one readdir of the parent rather
   than a walk of the tree. A path that cannot be read is treated as governing nothing,
   which puts the article in the residue: over-including costs a ranking slot, while
   under-including would silently drop knowledge from the only mechanism that can reach
   it. */
export function governsAnAsset(dir: string, path: string): boolean {
  const full = join(dir, path);
  if (existsSync(full)) return true;
  const base = path.slice(path.lastIndexOf("/") + 1);
  try {
    return readdirSync(dirname(full)).some(
      (entry) => entry === base || (entry.startsWith(`${base}.`) && !entry.slice(base.length + 1).includes(".")),
    );
  } catch {
    return false;
  }
}
