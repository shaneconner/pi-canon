/* Advisory only: advice strings, never a refusal. A blocked write teaches an agent
   to stop writing; a warning teaches it what to do next. */

import { CAPSULE_CHARS, type Article, type CanonStore } from "./store.ts";

export const BODY_WARN_CHARS = 8000;
export const BODY_LARGE_CHARS = 20000;
export const BODY_TINY_CHARS = 400;

const JOURNALISH = /(^|\/)(logs?|journal|sessions?|standups?|meetings?)(\/|$)|\d{4}-\d{2}-\d{2}/i;

export function advise(article: Article, store: CanonStore): string[] {
  const advice: string[] = [];
  const size = article.body.length;

  if (size > BODY_LARGE_CHARS) {
    advice.push(
      `Body is ${size} chars (large past ${BODY_LARGE_CHARS}). Densify, or split children under ` +
        `${article.path}/ and leave a router summary here.`,
    );
  } else if (size > BODY_WARN_CHARS) {
    advice.push(`Body is ${size} chars (warn past ${BODY_WARN_CHARS}). Densify before it needs splitting.`);
  } else if (size > 0 && size < BODY_TINY_CHARS) {
    const parent = parentOf(article.path);
    if (parent && store.read(parent)) {
      advice.push(`Body is ${size} chars. Consider folding it into ${parent}; split at asset boundaries, never for size.`);
    }
  }

  if (!article.capsule) {
    advice.push("No capsule. Add one dense line of front matter; surfacing has nothing to inject without it.");
  } else if (article.capsule.length > CAPSULE_CHARS) {
    advice.push(
      `Capsule is ${article.capsule.length} chars (cap ${CAPSULE_CHARS}). A capsule is one dense line, not a second body.`,
    );
  }

  if (JOURNALISH.test(article.path)) {
    advice.push(`The address ${article.path} reads like an event log. Articles hold current truth; the event belongs in the journal.`);
  }

  for (const match of article.body.matchAll(/\[\[([^\]|#]+)[^\]]*\]\]/g)) {
    const target = match[1].trim().replace(/\.md$/, "");
    if (!store.lookup(target)) advice.push(`Link [[${match[1]}]] resolves to no article.`);
  }

  return advice;
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}
