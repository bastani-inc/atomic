import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { describe, it } from "vitest";
import { executeCodemode } from "../src/extensions/codemode/execute.js";

describe("codemode output over the token budget", () => {
	it("states the original token count of the output it saved in full", async () => {
		const result = await executeCodemode(
			"truncation",
			{ code: '// @options: {"max_output_tokens": 10}\nreturn "x".repeat(997);' },
			undefined,
			undefined,
			undefined,
		);

		const notice = result.content
			.flatMap((block) => (block.type === "text" ? [block.text] : []))
			.find((text) => text.startsWith("Warning: truncated output"));
		assert.ok(notice !== undefined, "the output is truncated");
		const match =
			/^Warning: truncated output \(original token count: (\d+)\)\n(.*)\n\.\.\. output truncated \.\.\.\n(.*)\nFull output: (.+)$/s.exec(
				notice,
			);
		assert.ok(match, notice);
		const saved = readFileSync(match[4], "utf8");
		rmSync(match[4], { force: true });
		assert.ok(saved.length > 40);
		assert.equal(Number(match[1]), Math.ceil(saved.length / 4));
		assert.equal(match[2], saved.slice(0, 20));
		assert.equal(match[3], saved.slice(-20));
	});
});
