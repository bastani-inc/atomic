import { test, expect } from "bun:test";
import { join } from "node:path";

// Construct the ellipsis character via codepoint so this file's own source
// bytes never contain a literal U+2026 inside an http URL — self-protecting.
const ELLIPSIS = String.fromCharCode(0x2026);

// Regex: http(s):// followed by any non-whitespace chars that include U+2026
const BROKEN_URL_RE = new RegExp(`https?:\\/\\/[^\\s]*${ELLIPSIS}`);

test("no U+2026 (horizontal ellipsis) inside http(s) URLs in src/**/*.ts", async () => {
  // import.meta.dir = packages/atomic/src — go up 3 levels to repo root
  const repoRoot = join(import.meta.dir, "..", "..", "..");
  const srcDir = join(repoRoot, "packages", "atomic", "src");

  const glob = new Bun.Glob("**/*.ts");
  const offenders: string[] = [];

  for await (const rel of glob.scan({ cwd: srcDir })) {
    const abs = join(srcDir, rel);
    const text = await Bun.file(abs).text();
    if (BROKEN_URL_RE.test(text)) {
      offenders.push(abs);
    }
  }

  expect(offenders).toEqual([]);
});
