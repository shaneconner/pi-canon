/* Article and journal storage: a plain markdown tree under one root.
   wiki/<path>.md is the article governing asset <path>; journal/ holds immutable
   entries. Front matter is a strict YAML subset (single line values, inline arrays)
   so the tree stays hand editable and Obsidian readable with no parser dependency. */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Article {
  path: string;
  file: string;
  capsule: string;
  aliases: string[];
  updated: string;
  body: string;
}

export const CAPSULE_CHARS = 1000;

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n?/;

/* An asset address: relative to the project, no leading dot or slash, no trailing
   slash, file extension dropped so src/core/config.ts shares its article's address. */
export function normalize(asset: string, cwd = ""): string {
  let path = asset.trim().replace(/\\/g, "/");
  if (cwd && path.startsWith(cwd)) path = path.slice(cwd.length);
  path = path.replace(/^\/+/, "").replace(/^\.{1,2}\//, "").replace(/\/+$/, "");
  const dot = path.lastIndexOf(".");
  if (dot > path.lastIndexOf("/") + 1) path = path.slice(0, dot);
  return path;
}

function parseFrontMatter(text: string): { meta: Record<string, string | string[]>; body: string } {
  const match = FRONT_MATTER.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string | string[]> = {};
  for (const line of match[1].split("\n")) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const value = pair[2].trim();
    meta[pair[1]] = value.startsWith("[")
      ? value.replace(/^\[|\]$/g, "").split(",").map((item) => item.trim()).filter(Boolean)
      : value;
  }
  return { meta, body: text.slice(match[0].length) };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function serialize(article: Article): string {
  const meta = [
    article.capsule ? `capsule: ${article.capsule}` : "",
    article.aliases.length ? `aliases: [${article.aliases.join(", ")}]` : "",
    `updated: ${article.updated}`,
  ].filter(Boolean).join("\n");
  return `---\n${meta}\n---\n${article.body.trimEnd()}\n`;
}

export class CanonStore {
  private aliasIndex?: Map<string, string>;

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
    const { meta, body } = parseFrontMatter(readFileSync(file, "utf8"));
    return {
      path,
      file,
      body,
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
    const prior = this.read(path);
    const article: Article = {
      path,
      file: this.fileFor(path),
      capsule: (fields.capsule ?? prior?.capsule ?? "").replace(/\s*\n\s*/g, " ").trim(),
      aliases: fields.aliases ?? prior?.aliases ?? [],
      updated: today(),
      body: fields.body ?? prior?.body ?? "",
    };
    mkdirSync(dirname(article.file), { recursive: true });
    writeFileSync(article.file, serialize(article));
    this.aliasIndex = undefined;
    return article;
  }

  /* Journal entries are immutable: a fresh dated file per entry, never overwritten. */
  journal(entry: { body: string; slug?: string; subject?: string[] }): string {
    const slug =
      (entry.slug ?? "entry").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "entry";
    mkdirSync(this.journalDir, { recursive: true });
    let file = join(this.journalDir, `${today()}-${slug}.md`);
    for (let n = 2; existsSync(file); n += 1) file = join(this.journalDir, `${today()}-${slug}-${n}.md`);
    const front = entry.subject?.length ? `---\nsubject: [${entry.subject.join(", ")}]\n---\n` : "";
    writeFileSync(file, `${front}${entry.body.trimEnd()}\n`, { flag: "wx" });
    return file;
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

  private aliases(): Map<string, string> {
    if (!this.aliasIndex) {
      this.aliasIndex = new Map();
      for (const path of this.list()) {
        for (const alias of this.read(path)?.aliases ?? []) this.aliasIndex.set(normalize(alias), path);
      }
    }
    return this.aliasIndex;
  }
}
