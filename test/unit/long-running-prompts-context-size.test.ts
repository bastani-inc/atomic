import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

// A worker once ended its turn at ~66k tokens to "resume in a fresh run"; the parent saw an ordinary completion.
test("shipped implementation subagents do not stop because their conversation grew long", () => {
	const root = join(process.cwd(), "packages/subagents/agents");
	for (const agent of ["worker.md", "debugger.md", "code-simplifier.md"]) {
		const prompt = readFileSync(join(root, agent), "utf8");
		assert.match(
			prompt,
			/A long conversation is never a reason to stop or to hand work to a fresh run; Atomic compacts context automatically\./,
			agent,
		);
	}
	for (const agent of ["worker.md", "debugger.md"]) {
		const prompt = readFileSync(join(root, agent), "utf8");
		assert.match(prompt, /ask through `contact_supervisor` and continue any work the decision does not block/, agent);
	}
});
