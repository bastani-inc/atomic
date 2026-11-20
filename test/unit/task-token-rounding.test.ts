import assert from "node:assert/strict";
import { test } from "vitest";
import { formatTokenCount } from "../../packages/coding-agent/src/utils/token-count.js";

test("task token counts promote rounded thousands to millions (#5224)", () => {
	for (const [tokens, expected] of [
		[999, "999"],
		[1_000, "1.0k"],
		[999_949, "999.9k"],
		[999_950, "1.0M"],
		[999_999, "1.0M"],
		[1_000_000, "1.0M"],
	] as const)
		assert.equal(formatTokenCount(tokens), expected, `token count ${tokens}`);
});
