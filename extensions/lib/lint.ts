/* Advisory only: advice strings, never a refusal. A blocked write teaches an agent
   to stop writing; a warning teaches it what to do next. */

import { normalize, type Article, type CanonStore } from "./store.ts";

export const BODY_WARN_CHARS = 8000;
export const BODY_LARGE_CHARS = 20000;
export const CAPSULE_CHARS = 1000;
const BODY_TINY_CHARS = 400;

const JOURNALISH = /(^|\/)(logs?|journal|sessions?|standups?|meetings?)(\/|$)|\d{4}-\d{2}-\d{2}/i;
const EVENTISH = /^(added|updated|fixed|changed|implemented|removed|refactored|renamed|migrated|verified)\b/i;

const CONSTRAINT = /\b(must|never|always|require[sd]?|do not|don't)\b/i;

export function advise(article: Article, store: CanonStore, priorBody?: string): string[] {
  const advice: string[] = [];
  const size = article.body.length;

  /* The laundering guard: an agent that just violated a documented constraint will
     faithfully update the article to describe the violation as current truth. Name
     what disappeared; whether it still holds is the agent's call, stated out loud. */
  if (priorBody !== undefined) {
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

  if (size > BODY_LARGE_CHARS) {
    advice.push(
      `Body is ${size} chars (large past ${BODY_LARGE_CHARS}). Go hierarchical: keep this article ` +
        `as the summary and router, and move detail into children under ${article.path}/ at chunks ` +
        `worth loading separately.`,
    );
  } else if (size > BODY_WARN_CHARS) {
    advice.push(`Body is ${size} chars (warn past ${BODY_WARN_CHARS}). Densify before it needs splitting.`);
  } else if (size > 0 && size < BODY_TINY_CHARS) {
    const parent = parentOf(article.path);
    if (parent && store.read(parent)) {
      advice.push(`Body is ${size} chars. Consider folding it into ${parent}; keep children only at real asset or chunk boundaries.`);
    }
  }

  if (!article.capsule) {
    advice.push("No capsule. Add one dense line of front matter; surfacing has nothing to inject without it.");
  } else if (article.capsule.length > CAPSULE_CHARS) {
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
