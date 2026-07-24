import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const EXPECTED_BUILTIN_DIRECTORY_NAMES = [
  "intercom",
  "mcp",
  "subagents",
  "web-access",
  "workflows",
] as const;

export function assertExactBuiltinSet(root: string): string[] {
  const actual = readdirSync(root, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort();
  const expected = [...EXPECTED_BUILTIN_DIRECTORY_NAMES];
  const absoluteRoot = resolve(root);
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(
      `Builtin entry set mismatch in ${absoluteRoot}: expected ${expected.join(",")}; found ${actual.join(",")}`,
    );
  }
  for (const name of expected) {
    const stats = lstatSync(join(root, name));
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Builtin entry must be a real, non-link directory in ${absoluteRoot}: ${name}`);
    }
  }
  return actual;
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root || process.argv.length !== 3) {
    throw new Error("Usage: bun run scripts/assert-builtin-set.ts <builtin-directory>");
  }
  const actual = assertExactBuiltinSet(root);
  console.log(`Builtin directory set verified: ${actual.join(",")}`);
}
