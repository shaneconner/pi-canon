/* Advisory only: advice strings, never a refusal. A blocked write teaches an agent
   to stop writing; a warning teaches it what to do next. */

import { statSync } from "node:fs";
import { join } from "node:path";
import { governsAnAsset, RULE_SCOPE } from "./retrieval.ts";
import type { CanonSchema } from "./schema.ts";
import { normalize, type Article, type CanonStore } from "./store.ts";

export const BODY_WARN_CHARS = 8000;
export const BODY_LARGE_CHARS = 20000;
export const CAPSULE_CHARS = 1000;
const BODY_TINY_CHARS = 400;

const JOURNALISH = /(^|\/)(logs?|journal|sessions?|standups?|meetings?)(\/|$)|\d{4}-\d{2}-\d{2}/i;
const EVENTISH = /^(added|updated|fixed|changed|implemented|removed|refactored|renamed|migrated|verified)\b/i;

const CONSTRAINT = /\b(must|never|always|require[sd]?|do not|don't)\b/i;

/* Where the article sits relative to the tree, and whether anything can reach an
   article that sits off it. Absent means do not raise the scope question at all: with no
   retriever an off-path article is unreachable, so the advice would be advice to lose
   information. */
export interface Reach {
  dir: string;
  retrieval: string;
}

/* Value-shaped tokens. Not an attempt to understand the text: these are the shapes a
   fact takes when it cannot be paraphrased without being destroyed. An id, a key, a
   count, a duration. Prose survives distillation; these are what it drops. */
const CARDINAL =
  "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|" +
  "fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|" +
  "eighty|ninety|hundred|thousand|million)";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const VALUE_SHAPES: RegExp[] = [
  /`([^`\n]{2,60})`/g, //                                    backticked
  /"([^"\n]{2,60})"/g, //                                    quoted
  /\b([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\b/gi, //                hyphenated id: nightly-dispatch
  /\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/g, //                     SNAKE_CASE
  /\b([a-z][a-z0-9]*\.[a-z][a-z0-9]+)\b/g, //                dotted: period.close
  /\b(\d[\d,]*(?:\.\d+)?\s*%?)/g, //                         counts and limits: 40,000
  new RegExp(`\\b(${CARDINAL}\\s+[a-z]{3,})\\b`, "gi"), //   spelled durations: eleven weeks
];

const VALUE_CAP = 6;

function valuesIn(text: string): string[] {
  const found = new Map<string, string>();
  for (const shape of VALUE_SHAPES) {
    for (const match of text.matchAll(shape)) {
      const value = (match[1] ?? "").trim();
      if (value.length < 2 || ISO_DATE.test(value)) continue;
      found.set(value.toLowerCase(), value);
    }
  }
  return [...found.values()];
}

/* The values this journal entry recorded that its article did not keep.
   cap1 measured what this is for: an article stating a rule's shape without its values
   scores exactly what no article scores, and capbase found the journal holding every
   value 48/48 while the article kept 13/48. The journal is the provenance, so the check
   is a literal diff and needs no model: what did you just write down that the article
   someone else will read does not carry. */
export function unretained(journalBody: string, article: Article | undefined): string[] {
  if (!article) return [];
  const kept = `${article.capsule} ${article.body}`.toLowerCase().replace(/\s+/g, " ");
  /* Bounded containment, not bare substring: a journal value of 42 must not count as
     kept because the article happens to say 142, which is the failure mode a guard
     about exact values can least afford. A value may still sit inside a larger
     identifier at a symbol boundary, so billing-close counts inside
     system:billing-close. */
  const holds = (value: string): boolean => {
    const needle = value.toLowerCase().replace(/\s+/g, " ");
    let from = 0;
    for (;;) {
      const at = kept.indexOf(needle, from);
      if (at === -1) return false;
      const before = kept[at - 1] ?? " ";
      const after = kept[at + needle.length] ?? " ";
      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
      from = at + 1;
    }
  };
  return valuesIn(journalBody)
    .filter((value) => !holds(value))
    .sort((a, b) => b.length - a.length)
    .slice(0, VALUE_CAP);
}

export function advise(
  article: Article,
  store: CanonStore,
  priorBody?: string,
  reach?: Reach,
  schema?: CanonSchema,
): string[] {
  const advice: string[] = [];
  const size = article.body.length;
  /* A schema-declared aspect owns its message: when the store's schema.json bounds a
     field, the schema check reports the violation with the owner's own hint, and the
     built-in line for the same aspect stays quiet instead of saying it twice. */
  const declared = {
    capsuleRequired: schema?.capsule?.required === true,
    capsuleMax: schema?.capsule?.max_chars !== undefined,
    bodyMax: schema?.body?.max_chars !== undefined,
    bodyMin: schema?.body?.min_chars !== undefined,
  };

  /* The laundering guard: an agent that just violated a documented constraint will
     faithfully update the article to describe the violation as current truth. Name
     what disappeared; whether it still holds is the agent's call, stated out loud. */
  /* Only when this write actually replaced the body. priorBody is now the article's real
     prior state on every write, including capsule-only ones, because the scope question
     below needs it; a capsule-only write drops nothing, so it has nothing to launder. */
  if (priorBody !== undefined && article.body !== priorBody) {
    const kept = article.body.replace(/\s+/g, " ");
    const dropped = priorBody
      .split(/\r?\n/)
      .map((line) => line.replace(/^[-*\s]+/, "").trim())
      .filter((line) => CONSTRAINT.test(line) && !kept.includes(line.replace(/\s+/g, " ")))
      .slice(0, 2);
    for (const line of dropped) {
      advice.push(
        `This write dropped constraint language: "${line.slice(0, 160)}". If it still holds, keep it; ` +
          "if it genuinely changed, journal what changed it.",
      );
    }
  }

  /* The scope question, asked once per article at the moment it first becomes a rule.
     Filing a constraint at the asset you happened to be editing is the addressing
     version of the paraphrase failure: the rule survives, in full, at an address
     nothing else resolves to. A run-2 miss lost "docs claim 1000" by wording; this
     loses a house rule by placement, and neither is visible to the agent that did it.

     Not a classifier. Nothing here can tell a rule about this asset from a rule about
     every asset, and guessing wrong in the quiet direction is the expensive way to be
     wrong. So it asks rather than decides, and it asks only on the write that turns an
     article into one carrying a rule, so a store being maintained stays quiet. */
  if (
    reach && reach.retrieval !== "none" &&
    CONSTRAINT.test(article.body) && !CONSTRAINT.test(priorBody ?? "") &&
    governsAnAsset(reach.dir, article.path)
  ) {
    advice.push(
      `This article now carries a rule, and it lives at ${article.path}, which governs an asset. ` +
        `Anything working on a different asset resolves to its own article and never reaches this one. ` +
        `If the rule holds beyond ${article.path}, give it its own address naming the rule instead, ` +
        "where relevance to the work can find it.",
    );
  }

  /* The complement of the scope question above. That one fires when a rule lands at an
     address that governs an asset and says move it off. This one fires when a rule
     lands where no asset lives, which is exactly where the doctrine asked for it, and
     says name it as such. Undeclared, that article is indistinguishable from one whose
     asset was deleted under it, and the two want opposite things: one is the design
     working, the other is knowledge quietly going stale. Same trigger as the scope
     question, so an article is asked once and a store being maintained stays quiet.
     It cannot catch a stale article that never carried a rule, and nothing here can. */
  if (
    reach && reach.retrieval !== "none" &&
    CONSTRAINT.test(article.body) && !CONSTRAINT.test(priorBody ?? "") &&
    !governsAnAsset(reach.dir, article.path) && article.scope !== RULE_SCOPE
  ) {
    advice.push(
      `${article.path} governs no asset on disk, so relevance is the only thing that reaches it. ` +
        "If that is deliberate and this names a rule, write it again with scope rule; an undeclared " +
        "article here reads the same as one whose asset was deleted under it.",
    );
  }

  if (size > BODY_LARGE_CHARS && !declared.bodyMax) {
    advice.push(
      `Body is ${size} chars (large past ${BODY_LARGE_CHARS}). Go hierarchical: keep this article ` +
        `as the summary and router, and move detail into children under ${article.path}/ at chunks ` +
        `worth loading separately.`,
    );
  } else if (size > BODY_WARN_CHARS && size <= BODY_LARGE_CHARS) {
    advice.push(`Body is ${size} chars (warn past ${BODY_WARN_CHARS}). Densify before it needs splitting.`);
  } else if (size > 0 && size < BODY_TINY_CHARS && !declared.bodyMin) {
    const parent = parentOf(article.path);
    if (parent && store.read(parent)) {
      advice.push(`Body is ${size} chars. Consider folding it into ${parent}; keep children only at real asset or chunk boundaries.`);
    }
  }

  if (!article.capsule) {
    if (!declared.capsuleRequired) {
      advice.push("No capsule. Add one dense line of front matter; surfacing has nothing to inject without it.");
    }
  } else if (article.capsule.length > CAPSULE_CHARS && !declared.capsuleMax) {
    advice.push(
      `Capsule is ${article.capsule.length} chars (cap ${CAPSULE_CHARS}). A capsule is one dense line, not a second body.`,
    );
  } else if (EVENTISH.test(article.capsule)) {
    advice.push("The capsule reads like a change log. Capsules hold current truth; the event belongs in the journal.");
  }

  if (JOURNALISH.test(article.path)) {
    advice.push(`The address ${article.path} reads like an event log. Articles hold current truth; the event belongs in the journal.`);
  }

  for (const match of article.body.matchAll(/\[\[([^\]|#]+)[^\]]*\]\]/g)) {
    const target = match[1].trim().replace(/\.md$/, "");
    if (!store.read(target) && !store.read(normalize(target))) {
      advice.push(`Link [[${match[1]}]] resolves to no article.`);
    }
  }

  return advice;
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/* The article whose asset went missing: the complement scope: rule was designed
   against, finally checked from the other side. Fires only when the address is
   nested and its PARENT directory really exists on disk, so a store of purely
   conceptual addresses (a knowledge base whose articles never mapped to files)
   stays silent: the rename-or-delete case this catches is precisely an article
   whose neighborhood is real while its asset is not. Root-level addresses are
   conventional (a project or concept name) and are never questioned. Advisory
   on read and write, never a refusal, because the agent holding the article is
   the one positioned to heal it. */
export function orphaned(dir: string, article: Article): string | undefined {
  if (article.scope === RULE_SCOPE) return undefined;
  const cut = article.path.lastIndexOf("/");
  if (cut === -1) return undefined;
  try {
    if (!statSync(join(dir, article.path.slice(0, cut))).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  if (governsAnAsset(dir, article.path)) return undefined;
  return (
    `No asset on disk matches ${article.path}, though its parent directory exists. ` +
    "If the asset moved, move this article to the new address; if the asset is gone, " +
    "fold what still matters into the parent article and journal the retirement; if the " +
    "address is deliberate, write it with scope rule."
  );
}
