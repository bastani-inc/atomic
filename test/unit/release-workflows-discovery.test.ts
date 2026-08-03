import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "vitest";

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

	test("release-docs owns its generic repository research stages", () => {
		const source = repoFile(".atomic/workflows/release-docs.ts");

		assert.doesNotMatch(
			source,
			/@bastani\/workflows\/builtin\//,
			"release-docs should not depend on a bundled child workflow",
		);
		assert.match(source, /ctx\.parallel\(/, "release-docs should fan out repository research");
		assert.match(
			source,
			/synthesize-current-code-docs-gaps/,
			"release-docs should synthesize its research artifacts before docs updates",
		);
	});
});
