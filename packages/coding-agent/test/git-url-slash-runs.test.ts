import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { parseGitUrl } from "../src/utils/git.ts";

/** Long enough that slash trimming with quadratic backtracking takes many seconds. */
const ADVERSARIAL_SLASH_RUN = 200_000;
/** Linear parsing finishes these inputs in a few milliseconds; this leaves headroom for a loaded machine. */
const PARSE_BUDGET_MS = 1_000;

describe("git source parsing of long slash runs", () => {
	test.each([
		[`git:example.com/a${"/".repeat(ADVERSARIAL_SLASH_RUN)}b`, undefined],
		[`https://example.com/a${"/".repeat(ADVERSARIAL_SLASH_RUN)}b`, undefined],
		[`git:git@example.com:a${"/".repeat(ADVERSARIAL_SLASH_RUN)}b`, undefined],
		[`https://example.com/${"/".repeat(ADVERSARIAL_SLASH_RUN)}a/b`, "a/b"],
	])("parses a source with a long run of slashes in linear time (%#)", (source, expectedPath) => {
		const started = performance.now();
		const parsed = parseGitUrl(source);
		const elapsedMs = performance.now() - started;
		assert.equal(parsed?.path, expectedPath);
		assert.ok(elapsedMs < PARSE_BUDGET_MS, `parsing took ${elapsedMs.toFixed(0)} ms`);
	});

	test("still drops leading and trailing slashes from the repository path", () => {
		assert.equal(parseGitUrl("git:example.com/user/repo.git///")?.path, "user/repo");
		assert.equal(parseGitUrl("https://example.com///user/repo")?.path, "user/repo");
	});
});
