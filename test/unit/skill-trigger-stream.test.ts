import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";
import { createScriptSandbox, python } from "../helpers/skill-creator-scripts.js";

/** One query through the bundled evaluator, against the fake `atomic`; prints the decision. */
function evaluate(scenario: string, timeout: string, extra: Record<string, string> = {}) {
	const sandbox = createScriptSandbox("skill-trigger-stream-");
	const program = [
		"import sys",
		"from scripts.run_eval import run_single_query",
		"print(run_single_query('query', 'sample', 'sample skill', int(sys.argv[1]), sys.argv[2]))",
	].join("\n");
	try {
		return spawnSyncCollect([python ?? "python3", "-c", program, timeout, sandbox.project], {
			cwd: sandbox.project,
			env: sandbox.env({ FAKE_ATOMIC_SCENARIO: scenario, ...extra }),
		});
	} finally {
		removeTempDirectory(sandbox.dir);
	}
}

describe.skipIf(python === undefined)("bundled skill trigger evaluator", () => {
	test("reports a timeout rather than counting a trigger observed after the deadline (#5566)", () => {
		const result = evaluate("slow:1.5", "1");
		assert.notEqual(result.exitCode, 0, result.stdout.toString());
		assert.match(result.stderr.toString(), /timed out/iu);
	});

	test("counts producer startup against the query timeout (#5566)", () => {
		const result = evaluate("read-skill", "1", { FAKE_ATOMIC_STARTUP: "1.5" });
		assert.notEqual(result.exitCode, 0, result.stdout.toString());
		assert.match(result.stderr.toString(), /timed out/iu);
	});

	test("accepts a buffered trigger with a timeout larger than the platform timer (#5566)", () => {
		const result = evaluate("unterminated", `1${"0".repeat(350)}`);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.equal(result.stdout.toString().trim(), "True");
	});

	test("counts a timely trigger still buffered after the producer exits (#5566)", () => {
		const result = evaluate("unterminated", "30");
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.equal(result.stdout.toString().trim(), "True");
	});
});
