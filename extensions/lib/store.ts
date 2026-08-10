/* Article and journal storage: a plain markdown tree under one root.
   articles/<path>.md is the article governing asset <path>; journal/ holds immutable
   entries. Front matter is a strict YAML subset (single line values, inline arrays)
   so the tree stays hand editable and Obsidian readable with no parser dependency;
   keys this package does not own are carried through writes untouched. */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Article {
  path: string;
  capsule: string;
  updated: string;
  extra: string[];
  body: string;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const OWNED_KEYS = new Set(["capsule", "updated"]);

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
    meta[pair[1]] = unscalar(pair[2].trim());
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

  get articlesDir(): string {
    return join(this.root, "articles");
  }

  get journalDir(): string {
    return join(this.root, "journal");
  }

  private fileFor(path: string): string {
    return join(this.articlesDir, `${path}.md`);
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
      updated: typeof meta.updated === "string" ? meta.updated : "",
    };
  }

  /* The closest existing article governs the asset: exact address, then the
     nearest ancestor. */
  resolve(asset: string, cwd = ""): Article | undefined {
    let path = normalize(asset, cwd);
    while (path) {
      const article = this.read(path);
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
    return walk(this.articlesDir, "").sort();
  }

  write(path: string, fields: { capsule?: string; body?: string }): Article {
    path = contain(path);
    const prior = this.read(path);
    /* Agents sometimes paste a whole file as the body, front matter included; stored
       verbatim that nests a second front matter block inside the article. Strip a
       leading block only when its lines all look like front matter keys. */
    let body = fields.body ?? prior?.body ?? "";
    const block = FRONT_MATTER.exec(body);
    if (block && block[1].split(/\r?\n/).every((line) => /^[\w-]+:\s|^\s*$/.test(line))) {
      body = body.slice(block[0].length).trimStart();
    }
    const article: Article = {
      path,
      capsule: (fields.capsule ?? prior?.capsule ?? "").replace(/\s*\n\s*/g, " ").trim(),
      updated: today(),
      extra: prior?.extra ?? [],
      body,
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

  /* Journal entries whose subject names this address: the index a read surfaces
     so the agent can dig into event history when it wants more than current truth. */
  journalMentions(path: string): string[] {
    try {
      return readdirSync(this.journalDir)
        .filter((name) => {
          if (!name.endsWith(".md")) return false;
          const subject = /^subject:\s*(.*)$/m.exec(readFileSync(join(this.journalDir, name), "utf8"))?.[1] ?? "";
          return subject.replace(/^\[|\]$/g, "").split(",").some((s) => s.trim() === path);
        })
        .sort();
    } catch {
      return [];
    }
  }

  map(under = ""): string {
    const paths = this.list().filter((path) => !under || path === under || path.startsWith(`${under}/`));
    if (!paths.length) return under ? `No articles under ${under}.` : "No articles yet.";
    return paths
      .map((path) => {
        const capsule = this.read(path)?.capsule;
        return capsule ? `${path}: ${capsule}` : path;
      })
      .join("\n");
  }

}
