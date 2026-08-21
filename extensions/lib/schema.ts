/* Per-store article schema: schema.json at the store root, a data contract rather
   than buried code. The file is created with these defaults made explicit the first
   time the store persists anything, so its owner can see it, edit it per project,
   and point other tools at the same contract this package enforces.

   Enforcement is asymmetric on purpose. A rule marked required rejects the write
   that violates it, because a missing required field is exactly the class of miss
   that soft advice has demonstrably failed to prevent; every other rule warns, on
   write and on read, so an agent reading a noncompliant article learns it can heal
   what it is holding. A required violation the current write did not touch also
   only warns: a capsule-only update must not be held hostage to a legacy body. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Article } from "./store.ts";

export const SCHEMA_FILE = "schema.json";
export const SCHEMA_VERSION = 1;

export interface SchemaRule {
  required?: boolean;
  min_chars?: number;
  max_chars?: number;
  hint?: string;
}

/* Relations rules are about the reference graph, not any one field. The store
   declares them once here; each tool enforces the ones it can see. This package
   sees an article's own outgoing [[references]] at the write boundary, so it
   enforces refs; orphan and children need the whole graph and are enforced by
   graph-reading tools (canon-atlas) from this same file. */
export interface RefsRule {
  required?: boolean;
  min_count?: number;
  hint?: string;
}
export interface OrphanRule {
  warn?: boolean;
  hint?: string;
}
export interface ChildrenRule {
  listed?: boolean;
  hint?: string;
}
export interface CanonRelations {
  refs?: RefsRule;
  orphan?: OrphanRule;
  children?: ChildrenRule;
}

export interface CanonSchema {
  capsule?: SchemaRule;
  title?: SchemaRule;
  body?: SchemaRule;
  relations?: CanonRelations;
}

const FIELD_NAMES = ["capsule", "title", "body"] as const;
const RULE_KEYS = new Set(["required", "min_chars", "max_chars", "hint"]);
const RELATION_KEYS: Record<string, Set<string>> = {
  refs: new Set(["required", "min_count", "hint"]),
  orphan: new Set(["warn", "hint"]),
  children: new Set(["listed", "hint"]),
};

/* The shipped defaults, written into the file verbatim. Nothing is required and the
   caps mirror what the advisory lint has always said, so a store that never edits
   this file behaves as it always did, just with the contract visible on disk. */
const DEFAULT_FILE = `{
  "schema_version": 1,
  "about": "Article schema for this canon store. pi-canon enforces it at the tool boundary: a rule marked required rejects a write that violates it (judged on what the write touches, and on everything when the article is first created); every other rule warns on write and is reported on read, so agents can heal what they are holding. Other tools reading this store can enforce the same contract from this file. Fields: capsule (the front matter line surfaced on touch), title (the body's leading # heading), body. Rule keys: required, min_chars, max_chars, hint. Relations rules live under relations: refs (required, min_count) over an article's own outgoing references, orphan (warn) and children (listed) over the whole graph; each tool enforces the rules it can see, so refs holds here and the graph rules hold in graph-reading tools like canon-atlas. Delete a rule to drop it; delete this file to disable schema checks.",
  "article": {
    "capsule": { "required": false, "max_chars": 1000, "hint": "One dense line of current truth; surfacing injects it when the asset is touched." },
    "title": { "required": false, "hint": "Start the body with a # heading naming the asset." },
    "body": { "max_chars": 20000, "hint": "Past this, go hierarchical: keep this article as the summary and router, and move detail into children at addresses under it." }
  },
  "relations": {
    "refs": { "required": false, "hint": "Outgoing [[references]] authored by this article. required rejects a write whose body cites nothing; min_count warns under a floor." },
    "orphan": { "warn": false, "hint": "Warn when no other article references this one. Needs the whole graph, so graph-reading tools enforce it." },
    "children": { "listed": false, "hint": "Warn when an article does not reference each direct child under its address. Enforced by graph-reading tools." }
  }
}
`;

/* Created only when absent, so an edited or deleted file is never fought over. */
export function ensureSchemaFile(root: string): void {
  try {
    writeFileSync(join(root, SCHEMA_FILE), DEFAULT_FILE, { flag: "wx" });
  } catch {
    /* Exists already, or the root is unwritable; either way not this call's problem. */
  }
}

/* The schema as declared, plus every problem with the declaration itself. A malformed
   file fails open and loud: rules stop being enforced, and the caller says so, because
   a schema the owner believes is enforced while a typo disabled it is the worst state. */
export function loadSchema(root: string): { schema: CanonSchema | undefined; problems: string[] } {
  const file = join(root, SCHEMA_FILE);
  if (!existsSync(file)) return { schema: undefined, problems: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return {
      schema: undefined,
      problems: [`${SCHEMA_FILE} is not valid JSON (${(error as Error).message}); its rules are not being enforced.`],
    };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { schema: undefined, problems: [`${SCHEMA_FILE} must hold a JSON object; its rules are not being enforced.`] };
  }
  const problems: string[] = [];
  /* A missing article block is an empty one, not an early exit: a schema may
     carry only relations rules. */
  const declared = (raw as Record<string, unknown>).article ?? {};
  if (typeof declared !== "object" || declared === null || Array.isArray(declared)) {
    return { schema: undefined, problems: [`${SCHEMA_FILE}: "article" must be an object; its rules are not being enforced.`] };
  }
  const schema: CanonSchema = {};
  for (const [name, value] of Object.entries(declared as Record<string, unknown>)) {
    if (!(FIELD_NAMES as readonly string[]).includes(name)) {
      problems.push(`${SCHEMA_FILE}: unknown article field "${name}" is ignored (fields: ${FIELD_NAMES.join(", ")}).`);
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      problems.push(`${SCHEMA_FILE}: rule for "${name}" must be an object and is ignored.`);
      continue;
    }
    const rule: SchemaRule = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (!RULE_KEYS.has(key)) {
        problems.push(`${SCHEMA_FILE}: unknown rule key "${name}.${key}" is ignored (keys: required, min_chars, max_chars, hint).`);
      } else if (key === "required" && typeof val === "boolean") rule.required = val;
      else if ((key === "min_chars" || key === "max_chars") && typeof val === "number" && Number.isInteger(val) && val >= 0) rule[key] = val;
      else if (key === "hint" && typeof val === "string") rule.hint = val;
      else problems.push(`${SCHEMA_FILE}: "${name}.${key}" has the wrong type and is ignored.`);
    }
    schema[name as "capsule" | "title" | "body"] = rule;
  }
  const rel = (raw as Record<string, unknown>).relations;
  if (rel !== undefined) {
    if (typeof rel !== "object" || rel === null || Array.isArray(rel)) {
      problems.push(`${SCHEMA_FILE}: "relations" must be an object and is ignored.`);
    } else {
      const relations: CanonRelations = {};
      for (const [name, value] of Object.entries(rel as Record<string, unknown>)) {
        const keys = RELATION_KEYS[name];
        if (!keys) {
          problems.push(`${SCHEMA_FILE}: unknown relations field "${name}" is ignored (fields: refs, orphan, children).`);
          continue;
        }
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          problems.push(`${SCHEMA_FILE}: rule for "relations.${name}" must be an object and is ignored.`);
          continue;
        }
        const rule: Record<string, boolean | number | string> = {};
        for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
          if (!keys.has(key)) {
            problems.push(`${SCHEMA_FILE}: unknown rule key "relations.${name}.${key}" is ignored (keys: ${[...keys].join(", ")}).`);
          } else if ((key === "required" || key === "warn" || key === "listed") && typeof val === "boolean") rule[key] = val;
          else if (key === "min_count" && typeof val === "number" && Number.isInteger(val) && val >= 0) rule[key] = val;
          else if (key === "hint" && typeof val === "string") rule[key] = val;
          else problems.push(`${SCHEMA_FILE}: "relations.${name}.${key}" has the wrong type and is ignored.`);
        }
        relations[name as keyof CanonRelations] = rule;
      }
      schema.relations = relations;
    }
  }
  return { schema, problems };
}

/* The outgoing references an article authors: [[wikilink]] targets in the body,
   fenced and inline code stripped (examples are not citations), deduplicated
   case-insensitively. The write boundary can always see these, whatever else it
   cannot see of the graph. */
export function outgoingOf(body: string): string[] {
  const stripped = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const out = new Set<string>();
  for (const m of stripped.matchAll(/\[\[([^\]|#\n]+)(?:[|#][^\]\n]*)?\]\]/g)) {
    const target = m[1].trim().toLowerCase();
    if (target) out.add(target);
  }
  return [...out].sort();
}

/* The title is the body's leading # heading; the write interface has no separate
   title field on purpose, so the rule checks the one place a title can live. */
export function titleOf(body: string): string | undefined {
  const first = body.split(/\r?\n/).find((line) => line.trim() !== "");
  const heading = first === undefined ? undefined : /^#\s+(.+)$/.exec(first.trim());
  return heading ? heading[1].trim() : undefined;
}

export interface Touched {
  capsule: boolean;
  body: boolean;
  refs: boolean;
  created: boolean;
}

/* No write in flight: every violation is reportable but none can reject. */
export const READ_ONLY: Touched = { capsule: false, body: false, refs: false, created: false };

export interface Verdict {
  rejections: string[];
  warnings: string[];
}

export function checkArticle(article: Article, schema: CanonSchema, touched: Touched): Verdict {
  const verdict: Verdict = { rejections: [], warnings: [] };
  const fields: { name: keyof CanonSchema; value: string | undefined; missing: string; carrier: "capsule" | "body" }[] = [
    { name: "capsule", value: article.capsule || undefined, missing: "required and empty", carrier: "capsule" },
    { name: "title", value: titleOf(article.body), missing: "required and the body has no leading # heading", carrier: "body" },
    { name: "body", value: article.body || undefined, missing: "required and empty", carrier: "body" },
  ];
  for (const field of fields) {
    const rule = schema[field.name];
    if (!rule) continue;
    const hint = rule.hint ? ` ${rule.hint}` : "";
    if (rule.required && field.value === undefined) {
      const message = `${field.name}: ${field.missing}.${hint}`;
      if (touched.created || touched[field.carrier]) verdict.rejections.push(message);
      else verdict.warnings.push(message);
      continue;
    }
    if (field.value === undefined) continue;
    if (rule.min_chars !== undefined && field.value.length < rule.min_chars) {
      verdict.warnings.push(`${field.name}: ${field.value.length} chars (min ${rule.min_chars}).${hint}`);
    }
    if (rule.max_chars !== undefined && field.value.length > rule.max_chars) {
      verdict.warnings.push(`${field.name}: ${field.value.length} chars (max ${rule.max_chars}).${hint}`);
    }
  }
  /* The one relations rule this boundary can see whole: the article's own
     citations. required follows the same asymmetry as the fields, rejecting only
     the write that changed the reference set or created the article. */
  const refsRule = schema.relations && schema.relations.refs;
  if (refsRule) {
    const cited = outgoingOf(article.body).length;
    const hint = refsRule.hint ? ` ${refsRule.hint}` : "";
    if (refsRule.required && cited === 0) {
      const message = `refs: required and the body references nothing.${hint}`;
      if (touched.created || touched.refs) verdict.rejections.push(message);
      else verdict.warnings.push(message);
    } else if (refsRule.min_count !== undefined && cited < refsRule.min_count) {
      verdict.warnings.push(`refs: ${cited} outgoing (min ${refsRule.min_count}).${hint}`);
    }
  }
  return verdict;
}
