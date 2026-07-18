import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoFile = (path: string): string => readFileSync(join(process.cwd(), path), "utf8");

describe("repo-local release workflow discovery imports", () => {
  test("release-docs avoids the @bastani/atomic package root during discovery", () => {
    const path = ".atomic/workflows/lib/release-docs.ts";
    const source = repoFile(path);

    assert.doesNotMatch(
      source,
      /from\s+["']@bastani\/atomic["']/,
      `${path} must not import @bastani/atomic because workspace discovery resolves that package root to missing dist/index.js`,
    );
    assert.match(
      source,
      /packages\/coding-agent\/src\/utils\/git-env\.js/,
      `${path} should import the Git environment helper from the workspace source file`,
    );
  });

  test("release-docs imports builtin child workflows through the virtual workflow SDK", () => {
    const source = repoFile(".atomic/workflows/release-docs.ts");

    assert.match(
      source,
      /from\s+["']@bastani\/workflows\/builtin\/deep-research-codebase["']/,
      "release-docs should use the builtin workflow specifier virtualized by the workflow module loader",
    );
    assert.doesNotMatch(
      source,
      /\.\.\/\.\.\/packages\/workflows\/builtin\/deep-research-codebase\.js/,
      "release-docs should not bypass the workflow loader with a repo-relative builtin import",
    );
  });
});
