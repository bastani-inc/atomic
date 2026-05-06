import { test, expect, afterAll } from "bun:test";
import { $ } from "bun";
import { mkdtemp, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { findRepoRoot } from "../../src/lib/workspace-paths.ts";
import { getVersionFiles } from "../constants-base.ts";

const WORKSPACE_ROOT = findRepoRoot(import.meta.dir);
const BUMP_SCRIPT = join(WORKSPACE_ROOT, "packages/atomic/script/bump-version.ts");
const VERSION_FILES = getVersionFiles(WORKSPACE_ROOT);

/**
 * Snapshot real package.json contents BEFORE any test runs so afterAll can
 * assert the originals were never touched.
 */
const originalContents = new Map<string, string>();
for (const rel of VERSION_FILES) {
  originalContents.set(rel, await Bun.file(join(WORKSPACE_ROOT, rel)).text());
}

afterAll(async () => {
  // Guard: real workspace files must be byte-for-byte identical to snapshot.
  // If a test leaked a write to WORKSPACE_ROOT, the throw surfaces here.
  for (const [rel, original] of originalContents) {
    const text = await Bun.file(join(WORKSPACE_ROOT, rel)).text();
    if (text !== original) {
      throw new Error(
        `bump-version test leaked a write to WORKSPACE_ROOT: ${rel}`
      );
    }
  }
});

test("bump-version writes every discovered package.json in temp fixture", async () => {
  // Build isolated fixture dir with copies of the workspace package.json files.
  // mkdir each entry's parent so the copyFile target exists; the example
  // directories are discovered at runtime, so a static mkdir list would
  // drift the moment a new example is added.
  const fixture = await mkdtemp(join(tmpdir(), "atomic-bump-"));
  for (const rel of VERSION_FILES) {
    await mkdir(join(fixture, dirname(rel)), { recursive: true });
    await copyFile(join(WORKSPACE_ROOT, rel), join(fixture, rel));
  }

  // Create a minimal bun.lock so findRepoRoot() inside the script resolves
  // to `fixture` when the script walks up from its own import.meta.dir.
  // We override that entirely with --root, so bun.lock is not required by
  // the script — but create it anyway for correctness.
  await Bun.write(join(fixture, "bun.lock"), "");

  const newVersion = "9.99.99-test";
  const r = await $`bun ${BUMP_SCRIPT} --root ${fixture} ${newVersion}`.quiet();
  expect(r.exitCode).toBe(0);

  // Sanity-check the discovered set actually picked up at least one example
  // — otherwise the loop below would silently degrade to packages-only.
  expect(VERSION_FILES.some((rel) => rel.startsWith("examples/"))).toBe(true);

  // Assertions read from fixture, NOT WORKSPACE_ROOT.
  for (const rel of VERSION_FILES) {
    const pkg = JSON.parse(await Bun.file(join(fixture, rel)).text()) as { version: string };
    expect(pkg.version).toBe(newVersion);
  }

  // WORKSPACE_ROOT files must be untouched.
  for (const [rel, original] of originalContents) {
    const current = await Bun.file(join(WORKSPACE_ROOT, rel)).text();
    expect(current).toBe(original);
  }
});
