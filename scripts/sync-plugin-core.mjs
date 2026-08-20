#!/usr/bin/env node

/* The harness plugin must be self-contained after a marketplace installs only its
   directory. These files are generated mirrors, never a second implementation. */

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "extensions", "lib");
const target = join(root, "plugins", "pi-canon", "core");
const files = ["lint.ts", "retrieval.ts", "schema.ts", "store.ts", "surfacing.ts", "tool.ts"];

mkdirSync(target, { recursive: true });
for (const file of files) copyFileSync(join(source, file), join(target, file));

console.log(`Synced ${files.length} canonical core files into plugins/pi-canon/core.`);
