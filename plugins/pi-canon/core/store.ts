/* Article and journal storage: a plain markdown tree under one root.
   articles/<path>.md is the article governing asset <path>; journal/ holds immutable
   entries. Front matter is a strict YAML subset (single line values, inline arrays)
   so the tree stays hand editable and Obsidian readable with no parser dependency;
   keys this package does not own are carried through writes untouched. */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Article {
  path: string;
  capsule: string;
  updated: string;
  /* Declared scope. "rule" means this article names a cross-cutting rule and is not
     expected to govern an asset; empty means the address is the claim, as usual. */
  scope: string;
  extra: string[];
  body: string;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const OWNED_KEYS = new Set(["capsule", "updated", "scope"]);

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

/* The same address with nothing dropped. Needed to tell an asset path from an address
   that is already canonical: normalize drops one extension, so putting the article
   address src/core/config.test back through it yields src/core/config, a different
   article. Callers that accept an address from an agent must not canonicalise twice. */
export function contained(path: string, cwd = ""): string {
  let out = path.trim().replace(/\\/g, "/");
  if (cwd && (out === cwd || out.startsWith(`${cwd}/`))) out = out.slice(cwd.length);
  return contain(out);
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

/* Which collision an entry was: name.md is the first, name-2.md the second. A burst of
   entries lands inside one millisecond and shares a stamp, so this is what actually
   separates them, and it is the same counter that wrote the file. */
/* One journal entry as the index carries it: name, the instant it recorded, its subjects.
   Short keys because this file grows one line per entry forever and is never read by a
   human; the shape is documented here instead. */
interface JournalRow {
  n: string;
  a: string;
  s: string[];
}

function sequenceOf(name: string): number {
  return Number(/-(\d+)\.md$/.exec(name)?.[1] ?? 1);
}

/* An inline array of scalars, each optionally quoted. Splitting on every comma broke
   any value that legitimately contained one. */
function subjectList(raw: string): string[] {
  const inner = raw.trim().replace(/^\[|\]$/g, "");
  const out: string[] = [];
  for (const match of inner.matchAll(/"((?:[^"\\]|\\.)*)"|([^,]+)/g)) {
    const value = match[1] !== undefined ? unscalar(`"${match[1]}"`) : (match[2] ?? "").trim();
    if (value) out.push(value);
  }
  return out;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function serialize(article: Article): string {
  const meta = [
    article.capsule ? `capsule: ${scalar(article.capsule)}` : "",
    `updated: ${article.updated}`,
    article.scope ? `scope: ${scalar(article.scope)}` : "",
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
      scope: typeof meta.scope === "string" ? meta.scope : "",
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

  /* What the store looks like right now, cheaply enough to ask every turn.

     Retrieval re-reads and re-parses every article once a turn to rebuild the residue, and
     the comment justifying that says the residue is small by construction. Measured, the
     cost tracks the STORE and not the residue: 5,000 articles cost 242ms a turn when all of
     them are residue and 214ms when only 50 are, because every path is read and stat-ed
     before anything is filtered. At 20,000 articles it is 891ms, on every turn.

     Statting instead of reading is 8x cheaper, 114ms against 891ms at 20,000. mtimeMs is the
     reason this works where the obvious key does not: `updated` has day granularity, so an
     article rewritten in the same session carries the same stamp and any cache built on it
     serves a stale ranking for the rest of the run. Milliseconds do not have that problem,
     and size catches a same-millisecond rewrite of a different length. */
  signature(): string {
    const parts: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
        else if (entry.name.endsWith(".md")) {
          const stats = statSync(join(dir, entry.name));
          parts.push(`${prefix}${entry.name}:${stats.mtimeMs}:${stats.size}`);
        }
      }
    };
    walk(this.articlesDir, "");
    return parts.sort().join("|");
  }

  write(path: string, fields: { capsule?: string; body?: string; scope?: string }): Article {
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
      scope: (fields.scope ?? prior?.scope ?? "").trim(),
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
  journal(entry: {
    body: string;
    slug?: string;
    subject?: string[];
    provenance?: { harness: string; sessionId?: string };
  }): string {
    const slug =
      (entry.slug ?? "entry").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "entry";
    mkdirSync(this.journalDir, { recursive: true });
    /* An explicit instant, because the filename cannot carry one. Entries are named by
       date plus slug with -2, -3 for collisions, and sorting those lexicographically puts
       -10 before -2 and the unsuffixed name after every suffixed one, so "the newest
       three" was not the newest three (Codex, 2026-08-13). Subjects are quoted through
       the same scalar() as everything else, so an address containing a comma survives
       the round trip instead of splitting into two. */
    const stamp = new Date().toISOString();
    const front = [
      entry.subject?.length ? `subject: [${entry.subject.map(scalar).join(", ")}]` : "",
      `logged: ${stamp}`,
      entry.provenance?.harness ? `harness: ${scalar(entry.provenance.harness)}` : "",
      entry.provenance?.sessionId ? `session: ${scalar(entry.provenance.sessionId)}` : "",
    ].filter(Boolean).join("\n");
    const text = `---\n${front}\n---\n${entry.body.trimEnd()}\n`;
    for (let n = 1; ; n += 1) {
      const name = `${today()}-${slug}${n > 1 ? `-${n}` : ""}.md`;
      const file = join(this.journalDir, name);
      try {
        writeFileSync(file, text, { flag: "wx" });
        this.note({ n: name, a: stamp, s: entry.subject ?? [] });
        return file;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }

  /* Append the new entry to both the loaded index and the file on disk, so the count stays
     matched and the next session loads instead of rebuilding. Appending only when the index
     is already loaded would leave the file one row short of the directory and force a
     rebuild every session that journals without reading. */
  private note(row: JournalRow): void {
    try {
      if (existsSync(this.indexFile)) {
        if (this.index) this.index.push(row);
        appendFileSync(this.indexFile, JSON.stringify(row) + "\n");
        return;
      }
      /* No index yet. Drop what is cached and rebuild from the directory, which already
         holds this entry, so the file is created complete rather than one row short. */
      this.index = undefined;
      this.rows();
    } catch {
      /* Losing the append costs a rebuild next session, never a failed write. */
    }
  }

  /* Every journal entry, with its body. Distinct from the index, which deliberately holds
     no bodies so an article read never opens a journal file: this reads them all, and is
     therefore only for the agent-solicited path, never the hot one. A journal entry has no
     address, so what scopes it is its instant and the subjects it names. */
  journalEntries(): { name: string; logged: string; subjects: string[]; body: string }[] {
    let names: string[];
    try {
      names = readdirSync(this.journalDir).filter((name) => name.endsWith(".md"));
    } catch {
      return [];
    }
    const out = [];
    for (const name of names.sort()) {
      try {
        const text = readFileSync(join(this.journalDir, name), "utf8");
        /* The same two regexes CanonStore.row uses, deliberately. Journal front matter is
           written as `subject: [a, b]`, which the generic parser does not return under
           `meta`, so reading it a second way here would let search and the journal index
           disagree about what an entry names. */
        out.push({
          name,
          logged: /^logged:\s*(.*)$/m.exec(text)?.[1]?.trim() || name.slice(0, 10),
          subjects: subjectList(/^subject:\s*(.*)$/m.exec(text)?.[1] ?? ""),
          body: text.replace(/^---\n[\s\S]*?\n---\n/, ""),
        });
      } catch {
        /* An unreadable entry is skipped, never fatal: search is a convenience and one
           bad file must not make the whole journal unsearchable. */
      }
    }
    return out;
  }

  journalCount(): number {
    try {
      return readdirSync(this.journalDir).filter((name) => name.endsWith(".md")).length;
    } catch {
      return 0;
    }
  }

  /* One row per entry: filename, the instant it recorded, the addresses it names.
     Everything journalMentions needs, so a read never opens a journal file. */
  private index: JournalRow[] | undefined;

  private get indexFile(): string {
    return join(this.root, ".journal-index.jsonl");
  }

  private static row(dir: string, name: string): JournalRow {
    const text = readFileSync(join(dir, name), "utf8");
    /* Hand written and pre-2.0 entries have no stamp; the date in the name is the
       best available and still orders them against each other. */
    return {
      n: name,
      a: /^logged:\s*(.*)$/m.exec(text)?.[1]?.trim() || name.slice(0, 10),
      s: subjectList(/^subject:\s*(.*)$/m.exec(text)?.[1] ?? ""),
    };
  }

  /* The index, checked against one directory listing and no file reads.

     Holding the cache without checking was wrong: a second CanonStore on the same root, or
     this one after an entry arrives from outside, answers from a snapshot that has since
     moved. One readdir per call is the cheap validation, and it is still the whole point,
     because what this replaced read every entry on every article read.

     What a count cannot see is an entry whose subject line is edited in place: the count
     matches and the stale row stands. That is the deliberate trade. Catching it means
     opening every entry, which is the scan this exists to remove, and the cost of being
     wrong is one filename missing from a hint list that only invites digging. */
  private rows(): JournalRow[] {
    const count = this.journalCount();
    if (this.index && this.index.length === count) return this.index;
    let loaded: JournalRow[] | undefined;
    try {
      loaded = readFileSync(this.indexFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as JournalRow);
    } catch {
      loaded = undefined;
    }
    if (loaded && loaded.length === count) return (this.index = loaded);
    let rebuilt: JournalRow[] = [];
    try {
      rebuilt = readdirSync(this.journalDir)
        .filter((name) => name.endsWith(".md"))
        .map((name) => CanonStore.row(this.journalDir, name));
    } catch {
      return (this.index = []);
    }
    try {
      mkdirSync(this.root, { recursive: true });
      writeFileSync(this.indexFile, rebuilt.map((r) => JSON.stringify(r)).join("\n") + "\n");
    } catch {
      /* An unwritable index costs a rebuild next session, never a failed read. */
    }
    return (this.index = rebuilt);
  }

  /* Journal entries whose subject names this address: the index a read surfaces
     so the agent can dig into event history when it wants more than current truth. */
  /* Oldest first, by the instant the entry recorded rather than by its filename. */
  journalMentions(path: string): string[] {
    return this.rows()
      .filter((row) => row.s.includes(path))
      .sort((a, b) => (a.a === b.a ? sequenceOf(a.n) - sequenceOf(b.n) : a.a.localeCompare(b.a)))
      .map((row) => row.n);
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
