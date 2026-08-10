/* Article and journal storage: a plain markdown tree under one root.
   wiki/<path>.md is the article governing asset <path>; journal/ holds immutable
   entries. Front matter is a strict YAML subset (single line values, inline arrays)
   so the tree stays hand editable and Obsidian readable with no parser dependency;
   keys this package does not own are carried through writes untouched. */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Article {
  path: string;
  capsule: string;
  aliases: string[];
  updated: string;
  extra: string[];
  body: string;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const OWNED_KEYS = new Set(["capsule", "aliases", "updated"]);

/* Keep an address inside the tree: .. resolves against its own segments, so
   a/b/../c means a/c, and clamps at the root, so nothing ever escapes. */
function contain(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

/* An asset address: relative to the project, contained, file extension dropped so
   src/core/config.ts shares its article's address. The drop happens once, here at
   the boundary; the store itself never drops again, or config.test would lose its
   .test on the way to disk. */
export function normalize(asset: string, cwd = ""): string {
  let path = asset.trim().replace(/\\/g, "/");
  if (cwd && (path === cwd || path.startsWith(`${cwd}/`))) path = path.slice(cwd.length);
  path = contain(path);
  /* Drop the extension only when something precedes the dot, so .env stays .env. */
  const dot = path.lastIndexOf(".");
  if (dot > path.lastIndexOf("/") + 1) path = path.slice(0, dot);
  return path;
}

function parseFrontMatter(text: string): {
  meta: Record<string, string | string[]>;
  extra: string[];
  body: string;
} {
  const match = FRONT_MATTER.exec(text);
  if (!match) return { meta: {}, extra: [], body: text };
  const meta: Record<string, string | string[]> = {};
  const extra: string[] = [];
  let keepingForeign = false;
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) {
      if (keepingForeign) extra.push(line);
      continue;
    }
    /* An owned key with an empty value is a block list (Obsidian's aliases shape).
       Blocks are not ours to parse, so the whole thing rides along as foreign. */
    keepingForeign = !OWNED_KEYS.has(pair[1]) || !pair[2].trim();
    if (keepingForeign) {
      extra.push(line);
      continue;
    }
    const value = pair[2].trim();
    /* aliases is the one list-valued key; every other value is a plain string. */
    meta[pair[1]] =
      pair[1] === "aliases"
        ? value.replace(/^\[/, "").replace(/\]$/, "").split(",").map((item) => unscalar(item.trim())).filter(Boolean)
        : unscalar(value);
  }
  return { meta, extra, body: text.slice(match[0].length) };
}

/* Owned values are quoted only when YAML would misread them plain, so the tree
   stays hand editable and Obsidian keeps parsing it as a vault. */
const NEEDS_QUOTES = /[:#[\]{}"'`,&*!|>%@\\]|^\s|\s$/;

function scalar(value: string): string {
  return NEEDS_QUOTES.test(value) ? JSON.stringify(value) : value;
}

function unscalar(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function serialize(article: Article): string {
  const meta = [
    article.capsule ? `capsule: ${scalar(article.capsule)}` : "",
    article.aliases.length ? `aliases: [${article.aliases.map(scalar).join(", ")}]` : "",
    `updated: ${article.updated}`,
    ...article.extra,
  ].filter(Boolean).join("\n");
  return `---\n${meta}\n---\n${article.body.trimEnd()}\n`;
}

export class CanonStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  get wikiDir(): string {
    return join(this.root, "wiki");
  }

  get journalDir(): string {
    return join(this.root, "journal");
  }

  private fileFor(path: string): string {
    return join(this.wikiDir, `${path}.md`);
  }

  read(path: string): Article | undefined {
    if (!path) return undefined;
    const file = this.fileFor(path);
    if (!existsSync(file)) return undefined;
    const { meta, extra, body } = parseFrontMatter(readFileSync(file, "utf8"));
    return {
      path,
      body,
      extra,
      capsule: typeof meta.capsule === "string" ? meta.capsule : "",
      aliases: Array.isArray(meta.aliases) ? meta.aliases : [],
      updated: typeof meta.updated === "string" ? meta.updated : "",
    };
  }

  /* Exact address or a registered alias; no ancestor walk. */
  lookup(path: string): Article | undefined {
    return this.read(path) ?? this.read(this.aliases().get(normalize(path)) ?? "");
  }

  /* The closest existing article governs the asset: exact address, then alias,
     then nearest ancestor. */
  resolve(asset: string, cwd = ""): Article | undefined {
    let path = normalize(asset, cwd);
    const aliases = this.aliases();
    while (path) {
      const article = this.read(path) ?? this.read(aliases.get(normalize(path)) ?? "");
      if (article) return article;
      const cut = path.lastIndexOf("/");
      path = cut === -1 ? "" : path.slice(0, cut);
    }
    return undefined;
  }

  list(): string[] {
    const walk = (dir: string, prefix: string): string[] => {
      if (!existsSync(dir)) return [];
      const paths: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) paths.push(...walk(join(dir, entry.name), `${prefix}${entry.name}/`));
        else if (entry.name.endsWith(".md")) paths.push(`${prefix}${entry.name.slice(0, -3)}`);
      }
      return paths;
    };
    return walk(this.wikiDir, "").sort();
  }

  write(path: string, fields: { capsule?: string; body?: string }): Article {
    path = contain(path);
    const prior = this.read(path);
    const article: Article = {
      path,
      capsule: (fields.capsule ?? prior?.capsule ?? "").replace(/\s*\n\s*/g, " ").trim(),
      aliases: prior?.aliases ?? [],
      updated: today(),
      extra: prior?.extra ?? [],
      body: fields.body ?? prior?.body ?? "",
    };
    const file = this.fileFor(path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, serialize(article));
    return article;
  }

  /* Journal entries are immutable: a fresh dated file per entry, wx so nothing is
     ever overwritten. EEXIST is the retry signal, so concurrent writers each land
     on their own file instead of one losing its entry. */
  journal(entry: { body: string; slug?: string; subject?: string[] }): string {
    const slug =
      (entry.slug ?? "entry").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "entry";
    mkdirSync(this.journalDir, { recursive: true });
    const front = entry.subject?.length ? `---\nsubject: [${entry.subject.join(", ")}]\n---\n` : "";
    const text = `${front}${entry.body.trimEnd()}\n`;
    for (let n = 1; ; n += 1) {
      const file = join(this.journalDir, `${today()}-${slug}${n > 1 ? `-${n}` : ""}.md`);
      try {
        writeFileSync(file, text, { flag: "wx" });
        return file;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }

  journalCount(): number {
    try {
      return readdirSync(this.journalDir).filter((name) => name.endsWith(".md")).length;
    } catch {
      return 0;
    }
  }

  map(under = ""): string {
    const paths = this.list().filter((path) => !under || path === under || path.startsWith(`${under}/`));
    if (!paths.length) return under ? `No articles under ${under}.` : "The wiki is empty.";
    return paths
      .map((path) => {
        const capsule = this.read(path)?.capsule;
        return capsule ? `${path}: ${capsule}` : path;
      })
      .join("\n");
  }

  /* Built fresh per lookup: a hand-edited aliases line resolves immediately, and the
     tree is small enough that the cache this replaced cost more than it saved. */
  private aliases(): Map<string, string> {
    const map = new Map<string, string>();
    for (const path of this.list()) {
      for (const alias of this.read(path)?.aliases ?? []) map.set(normalize(alias), path);
    }
    return map;
  }
}
