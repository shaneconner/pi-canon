/* Article and journal storage: a plain markdown tree under one root.
   wiki/<path>.md is the article governing asset <path>; journal/ holds immutable
   entries. Front matter is a strict YAML subset (single line values, inline arrays)
   so the tree stays hand editable and Obsidian readable with no parser dependency;
   keys this package does not own are carried through writes untouched. */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Article {
  path: string;
  file: string;
  capsule: string;
  aliases: string[];
  updated: string;
  extra: string[];
  body: string;
}

export const CAPSULE_CHARS = 1000;

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n?/;
const OWNED_KEYS = new Set(["capsule", "aliases", "updated"]);

/* An asset address: relative to the project, dot segments removed so an address can
   never leave the wiki tree, file extension dropped so src/core/config.ts shares its
   article's address. */
export function normalize(asset: string, cwd = ""): string {
  let path = asset.trim().replace(/\\/g, "/");
  if (cwd && (path === cwd || path.startsWith(`${cwd}/`))) path = path.slice(cwd.length);
  path = path.split("/").filter((part) => part && part !== "." && part !== "..").join("/");
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
  for (const line of match[1].split("\n")) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) {
      if (keepingForeign) extra.push(line);
      continue;
    }
    keepingForeign = !OWNED_KEYS.has(pair[1]);
    if (keepingForeign) {
      extra.push(line);
      continue;
    }
    const value = pair[2].trim();
    meta[pair[1]] = value.startsWith("[") && value.endsWith("]")
      ? value.slice(1, -1).split(",").map((item) => item.trim()).filter(Boolean)
      : value;
  }
  return { meta, extra, body: text.slice(match[0].length) };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function serialize(article: Article): string {
  const meta = [
    article.capsule ? `capsule: ${article.capsule}` : "",
    article.aliases.length ? `aliases: [${article.aliases.join(", ")}]` : "",
    `updated: ${article.updated}`,
    ...article.extra,
  ].filter(Boolean).join("\n");
  return `---\n${meta}\n---\n${article.body.trimEnd()}\n`;
}

export class CanonStore {
  private aliasIndex?: { key: string; map: Map<string, string> };

  constructor(readonly root: string) {}

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
      file,
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
    while (path) {
      const article = this.lookup(path);
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

  write(path: string, fields: { capsule?: string; body?: string; aliases?: string[] }): Article {
    path = normalize(path);
    const prior = this.read(path);
    const article: Article = {
      path,
      file: this.fileFor(path),
      capsule: (fields.capsule ?? prior?.capsule ?? "").replace(/\s*\n\s*/g, " ").trim(),
      aliases: fields.aliases ?? prior?.aliases ?? [],
      updated: today(),
      extra: prior?.extra ?? [],
      body: fields.body ?? prior?.body ?? "",
    };
    mkdirSync(dirname(article.file), { recursive: true });
    writeFileSync(article.file, serialize(article));
    this.aliasIndex = undefined;
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

  /* Rebuilt whenever the tree changes shape or content, so a hand-edited aliases
     line resolves without a restart. Freshness is a stat pass, not a read pass. */
  private aliases(): Map<string, string> {
    const paths = this.list();
    let newest = 0;
    for (const path of paths) {
      const mtime = statSync(this.fileFor(path), { throwIfNoEntry: false })?.mtimeMs ?? 0;
      if (mtime > newest) newest = mtime;
    }
    const key = `${paths.length}:${newest}`;
    if (this.aliasIndex?.key !== key) {
      const map = new Map<string, string>();
      for (const path of paths) {
        for (const alias of this.read(path)?.aliases ?? []) map.set(normalize(alias), path);
      }
      this.aliasIndex = { key, map };
    }
    return this.aliasIndex.map;
  }
}
