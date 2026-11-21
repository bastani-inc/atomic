import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";
import { createScriptSandbox, python, type ScriptSandbox, skillCreatorDir } from "../helpers/skill-creator-scripts.js";

const NOTE =
	"Note: Atomic found no credentials for the model. On Windows a query cannot answer a credential command " +
	'that asks for input; see "Credentials on Windows" in skill-creator\'s SKILL.md.';
const windows = process.platform === "win32";

const sandboxes: ScriptSandbox[] = [];
afterEach(() => {
	for (const sandbox of sandboxes.splice(0)) removeTempDirectory(sandbox.dir);
});

function sandbox(): ScriptSandbox {
	const created = createScriptSandbox("skill-creator-credentials-");
	sandboxes.push(created);
	return created;
}

/** Standard error's lines, as Windows ends them too. */
function stderrLines(stderr: Uint8Array): string[] {
	return new TextDecoder().decode(stderr).replaceAll("\r\n", "\n").trimEnd().split("\n");
}

function runEval(box: ScriptSandbox, scenario: string) {
	const evalSet = box.writeEvalSet([
		{ query: "make a report", should_trigger: true },
		{ query: "plan a trip", should_trigger: false },
	]);
	return spawnSyncCollect(
		[
			python ?? "python",
			join(skillCreatorDir, "scripts", "run_eval.py"),
			"--eval-set",
			evalSet,
			"--skill-path",
			box.skill,
			"--runs-per-query",
			"2",
		],
		{ cwd: box.project, env: box.env({ FAKE_ATOMIC_SCENARIO: scenario }) },
	);
}

describe.skipIf(python === undefined)("skill-creator's note on missing credentials", () => {
	test.runIf(windows)(
		"on Windows, an evaluation whose queries fail for missing credentials ends with one note pointing to SKILL.md",
		() => {
			const box = sandbox();
			const result = runEval(box, "no-credentials");
			assert.equal(result.exitCode, 0, result.stderr.toString());
			const lines = stderrLines(result.stderr);
			assert.equal(
				lines.filter((line) => line.startsWith("Warning: query failed: atomic -p exited 1: No API key")).length,
				4,
			);
			assert.equal(lines.filter((line) => line === NOTE).length, 1, lines.join("\n"));
			assert.equal(lines.at(-1), NOTE);
		},
	);

	test.runIf(windows)(
		"on Windows, the optimization loop stopped by the improvement step's missing credentials prints the note once",
		() => {
			const box = sandbox();
			const evalSet = box.writeEvalSet([{ query: "make a report", should_trigger: true }]);
			const result = spawnSyncCollect(
				[
					python ?? "python",
					join(skillCreatorDir, "scripts", "run_loop.py"),
					"--eval-set",
					evalSet,
					"--skill-path",
					box.skill,
					"--model",
					"local/model",
					"--max-iterations",
					"2",
					"--runs-per-query",
					"1",
					"--holdout",
					"0",
					"--report",
					"none",
				],
				{ cwd: box.project, env: box.env({ FAKE_ATOMIC_SCENARIO: "no-credentials" }) },
			);
			assert.equal(result.exitCode, 1, "the improvement step's failure ends the loop");
			const lines = stderrLines(result.stderr);
			assert.ok(
				lines.some((line) => line.includes("RuntimeError: atomic -p exited 1")),
				lines.join("\n"),
			);
			assert.equal(lines.filter((line) => line === NOTE).length, 1, lines.join("\n"));
		},
	);

	test.runIf(windows)("on Windows, an evaluation run from a program prints no note", () => {
		const box = sandbox();
		const evalSet = box.writeEvalSet([{ query: "make a report", should_trigger: true }]);
		const program = [
			"import json, sys",
			"from pathlib import Path",
			"from scripts.run_eval import run_eval",
			"items = json.loads(Path(sys.argv[1]).read_text())",
			"run_eval(items, 'sample', 'Use this skill for sample reports.', 1, 30, Path.cwd())",
		].join("\n");
		const result = spawnSyncCollect([python ?? "python", "-c", program, evalSet], {
			cwd: box.project,
			env: box.env({ FAKE_ATOMIC_SCENARIO: "no-credentials" }),
		});
		assert.equal(result.exitCode, 0, result.stderr.toString());
		const lines = stderrLines(result.stderr);
		assert.ok(
			lines.some((line) => line.startsWith("Warning: query failed:")),
			lines.join("\n"),
		);
		assert.ok(!lines.includes(NOTE), lines.join("\n"));
	});

	test("an evaluation whose queries fail for another reason prints no note", () => {
		const box = sandbox();
		const result = runEval(box, "exit:3");
		assert.equal(result.exitCode, 0, result.stderr.toString());
		const lines = stderrLines(result.stderr);
		assert.equal(lines.filter((line) => line.startsWith("Warning: query failed: atomic -p exited 3")).length, 4);
		assert.ok(!lines.includes(NOTE), lines.join("\n"));
	});

	test.skipIf(windows)("on Linux and macOS, queries failing for missing credentials print no note", () => {
		const box = sandbox();
		const result = runEval(box, "no-credentials");
		assert.equal(result.exitCode, 0, result.stderr.toString());
		const lines = stderrLines(result.stderr);
		assert.equal(
			lines.filter((line) => line.startsWith("Warning: query failed: atomic -p exited 1: No API key")).length,
			4,
		);
		assert.ok(!lines.includes(NOTE), lines.join("\n"));
	});
});
