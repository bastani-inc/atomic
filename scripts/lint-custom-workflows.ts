#!/usr/bin/env bun
/**
 * Guard against the alias-vs-name asymmetric lookup anti-pattern in
 * packages/atomic/src/commands/custom-workflows.ts.
 *
 * registry.resolve(<x>.alias, ...) is WRONG: the registry is keyed by
 * compiled def.name, so resolving by alias is asymmetric and produces
 * silent wrong overrides.  Use the alias-keyed healthy Set built in
 * mergeIntoRegistry instead (RFC §5.7).
 */

import { readFileSync } from "fs";
import { join } from "path";

const TARGET = join(
  import.meta.dir,
  "..",
  "packages",
  "atomic",
  "src",
  "commands",
  "custom-workflows.ts",
);

const PATTERN = /registry\.resolve\s*\(\s*[a-zA-Z_$][a-zA-Z0-9_$]*\.alias/;

const ERROR_MSG =
  "alias-vs-name asymmetric lookup — use the alias-keyed healthy set in mergeIntoRegistry (RFC §5.7) instead.";

let source: string;
try {
  source = readFileSync(TARGET, "utf-8");
} catch (err) {
  console.error(`lint-custom-workflows: cannot read ${TARGET}: ${err}`);
  process.exit(2);
}

const lines = source.split("\n");
const hits: { line: number; text: string }[] = [];

for (let i = 0; i < lines.length; i++) {
  if (PATTERN.test(lines[i])) {
    hits.push({ line: i + 1, text: lines[i].trim() });
  }
}

if (hits.length > 0) {
  console.error(
    `\nlint-custom-workflows: FAIL — anti-pattern detected in custom-workflows.ts`,
  );
  console.error(`  ${ERROR_MSG}\n`);
  for (const h of hits) {
    console.error(`  ${TARGET}:${h.line}  →  ${h.text}`);
  }
  console.error(
    "\n  Fix: build an alias-keyed Set<string> from LoadedWorkflow[] and use that for override-subtraction.\n",
  );
  process.exit(1);
}

console.log("lint-custom-workflows: OK — no alias-vs-name asymmetric lookups found.");
process.exit(0);
