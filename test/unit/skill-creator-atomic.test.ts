import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { removeTempDirectory, spawnProcess, spawnSyncCollect } from "../helpers/runtime.js";
import {
	createScriptSandbox,
	processRuns,
	python,
	type ScriptSandbox,
	skillCreatorDir,
	startedPids,
	waitUntilGone,
} from "../helpers/skill-creator-scripts.js";

const sandboxes: ScriptSandbox[] = [];
afterEach(() => {
	for (const sandbox of sandboxes.splice(0)) removeTempDirectory(sandbox.dir);
});

function sandbox(): ScriptSandbox {
	const created = createScriptSandbox("skill-creator-atomic-");
	sandboxes.push(created);
	return created;
}

function runScript(box: ScriptSandbox, args: readonly string[], env: Record<string, string> = {}) {
	return spawnSyncCollect([python ?? "python3", "-m", ...args], { cwd: box.project, env: box.env(env) });
}

interface EvalOutput {
	readonly results: readonly { readonly query: string; readonly triggers: number; readonly runs: number }[];
}

function triggersByQuery(stdout: Buffer): Record<string, number> {
	const output = JSON.parse(stdout.toString()) as EvalOutput;
	return Object.fromEntries(output.results.map((result) => [result.query, result.triggers]));
}

describe.skipIf(python === undefined)("skill-creator scripts run Atomic", () => {
	test("evaluate a description with `atomic -p`, the read tool only and the candidate in a private folder, never `claude` (#5625)", () => {
		const box = sandbox();
		const claudeMarker = join(box.dir, "claude-started");
		const bin = join(box.dir, "bin");
		if (process.platform === "win32") writeFileSync(join(bin, "claude.cmd"), `@echo started> "${claudeMarker}"\r\n`);
		else writeFileSync(join(bin, "claude"), `#!/bin/sh\necho started > "${claudeMarker}"\n`, { mode: 0o755 });
		// Read verbatim from standard input: not an option, not a file reference, not a shell word.
		const query = '--help @notes.md "quoted" & 100% \u2713\nsecond line';
		const evalSet = box.writeEvalSet([{ query, should_trigger: true }]);
		const result = runScript(box, [
			"scripts.run_eval",
			"--eval-set",
			evalSet,
			"--skill-path",
			box.skill,
			"--runs-per-query",
			"1",
			"--model",
			"local/model:high",
		]);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.deepEqual(triggersByQuery(result.stdout), { [query]: 1 });

		const [record] = box.records();
		assert.ok(record);
		const skillDir = record.args[record.args.indexOf("--skill") + 1] ?? "";
		assert.deepEqual(record.args, [
			"-p",
			"--mode",
			"json",
			"--no-session",
			"--no-extensions",
			"--no-mcp",
			"--no-prompt-templates",
			"--tools",
			"read",
			"--skill",
			skillDir,
			"--model",
			"local/model:high",
		]);
		assert.equal(record.prompt, query);
		assert.equal(realpathSync(record.cwd), realpathSync(box.project));
		assert.equal(record.heap, "0", "a single Atomic process, without a larger-heap restart");
		assert.match(basename(skillDir), /^sample-skill-[0-9a-f]{8}$/u);
		assert.equal(
			record.skill,
			`---\nname: ${basename(skillDir)}\ndescription: |\n  Use this skill for sample reports.\n---\n\n# sample\n\nThis skill handles: Use this skill for sample reports.\n`,
		);
		assert.equal(realpathSync(dirname(dirname(skillDir))), realpathSync(box.temp));
		assert.deepEqual(readdirSync(box.project), [], "nothing is written into the project");
		assert.deepEqual(readdirSync(box.temp), [], "the private folder is removed");
		assert.equal(existsSync(claudeMarker), false);
	});

	test("count a trigger only when the model's first tool call reads the candidate's SKILL.md (#5625)", () => {
		const box = sandbox();
		const expected: Record<string, number> = {
			"read-skill": 1,
			"read-skill-relative": 1,
			"read-skill-selector": 1,
			"read-skill-at": 1,
			"final-only": 1,
			"retry-then-read": 1,
			unterminated: 1,
			"read-other": 0,
			"bash-first": 0,
			answer: 0,
		};
		const scenarios = Object.keys(expected);
		const evalSet = box.writeEvalSet(scenarios.map((query) => ({ query, should_trigger: true })));
		const result = runScript(
			box,
			["scripts.run_eval", "--eval-set", evalSet, "--skill-path", box.skill, "--runs-per-query", "1"],
			{ FAKE_ATOMIC_PLAN: JSON.stringify(Object.fromEntries(scenarios.map((name) => [name, name]))) },
		);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.deepEqual(triggersByQuery(result.stdout), expected);
		assert.doesNotMatch(result.stderr.toString(), /query failed/u);
	});

	test("report a failed Atomic run with its exit status and error output (#5625)", () => {
		const box = sandbox();
		const evalSet = box.writeEvalSet([{ query: "fails", should_trigger: true }]);
		const result = runScript(
			box,
			["scripts.run_eval", "--eval-set", evalSet, "--skill-path", box.skill, "--runs-per-query", "1"],
			{ FAKE_ATOMIC_SCENARIO: "exit:3" },
		);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.deepEqual(triggersByQuery(result.stdout), { fails: 0 });
		assert.match(result.stderr.toString(), /query failed: atomic -p exited 3: fake atomic failed on purpose/u);
	});

	test("do not start Atomic for a query whose time is already up (#5625)", () => {
		const box = sandbox();
		const program = [
			"from scripts.run_eval import run_single_query",
			"try:",
			"    run_single_query('query', 'sample', 'sample skill', 0, '.')",
			"except TimeoutError as error:",
			"    print(error)",
		].join("\n");
		const result = spawnSyncCollect([python ?? "python3", "-c", program], { cwd: box.project, env: box.env() });
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.match(result.stdout.toString(), /Timed out after 0s/u);
		assert.deepEqual(box.records(), []);
	});

	test("stop with an error, evaluating nothing, when no `atomic` command exists (#5625)", () => {
		const box = sandbox();
		const evalSet = box.writeEvalSet([{ query: "q", should_trigger: true }]);
		const empty = join(box.dir, "empty");
		mkdirSync(empty);
		const result = runScript(box, ["scripts.run_eval", "--eval-set", evalSet, "--skill-path", box.skill], {
			PATH: empty,
		});
		assert.equal(result.exitCode, 1);
		assert.match(result.stderr.toString(), /Error: Atomic was not found/u);
		assert.equal(result.stdout.toString(), "");
	});

	test("improve a description with `atomic -p` and no tools, sending the prompt on standard input (#5625)", () => {
		const box = sandbox();
		const results = join(box.dir, "results.json");
		writeFileSync(
			results,
			JSON.stringify({
				description: "Use this skill for sample reports.",
				summary: { passed: 0, failed: 1, total: 1 },
				results: [{ query: "make the quarterly report", should_trigger: true, pass: false, triggers: 0, runs: 3 }],
			}),
		);
		const result = runScript(
			box,
			[
				"scripts.improve_description",
				"--eval-results",
				results,
				"--skill-path",
				box.skill,
				"--model",
				"local/model",
			],
			{ FAKE_ATOMIC_SCENARIO: "improve" },
		);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.equal(
			(JSON.parse(result.stdout.toString()) as { description: string }).description,
			"Use this skill for fake work. \u2713",
		);
		const [record] = box.records();
		assert.ok(record);
		assert.deepEqual(record.args, [
			"-p",
			"--no-session",
			"--no-extensions",
			"--no-mcp",
			"--no-prompt-templates",
			"--no-tools",
			"--model",
			"local/model",
		]);
		assert.match(record.prompt, /make the quarterly report/u);
		assert.match(record.prompt, /# Sample/u);
		assert.deepEqual(readdirSync(box.temp), []);
	});

	test.skipIf(process.platform === "win32")(
		"serve the review viewer on a free port and leave the program on the requested port running (#5625)",
		async () => {
			const box = sandbox();
			const workspace = join(box.dir, "workspace");
			mkdirSync(join(workspace, "eval-1", "with_skill", "outputs"), { recursive: true });
			writeFileSync(join(workspace, "eval-1", "with_skill", "outputs", "answer.txt"), "answer");
			const listener = spawnProcess(
				[
					python ?? "python3",
					"-c",
					"import socket,sys,time\ns=socket.socket()\ns.bind(('127.0.0.1',0))\ns.listen()\nprint(s.getsockname()[1],flush=True)\ntime.sleep(60)",
				],
				{ stdout: "pipe" },
			);
			let viewer: ReturnType<typeof spawnProcess> | undefined;
			try {
				const port = Number((await readLine(listener.stdout)).trim());
				viewer = spawnProcess(
					[
						python ?? "python3",
						join(skillCreatorDir, "eval-viewer", "generate_review.py"),
						workspace,
						"--port",
						`${port}`,
					],
					{ cwd: box.dir, env: box.env({ PYTHONUNBUFFERED: "1" }), stdout: "pipe" },
				);
				const url = await readUntil(viewer.stdout, /URL:\s+(\S+)/u);
				assert.notEqual(new URL(url).port, `${port}`);
				assert.ok(listener.pid !== undefined && processRuns(listener.pid), "the program on the port still runs");
			} finally {
				viewer?.kill("SIGTERM");
				listener.kill("SIGKILL");
				await Promise.allSettled([viewer?.exited, listener.exited]);
			}
		},
	);

	test("leave no Atomic process running after a query that timed out (#5625)", async () => {
		const box = sandbox();
		const evalSet = box.writeEvalSet([{ query: "slow", should_trigger: true }]);
		const result = runScript(
			box,
			[
				"scripts.run_eval",
				"--eval-set",
				evalSet,
				"--skill-path",
				box.skill,
				"--runs-per-query",
				"1",
				"--timeout",
				"1",
			],
			{ FAKE_ATOMIC_SCENARIO: "hold-child" },
		);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.match(result.stderr.toString(), /query failed: Timed out after 1s/u);
		await waitUntilGone(startedPids(box.records()), 5_000);
		assert.deepEqual(readdirSync(box.temp), []);
	});
});

async function readLine(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	return readUntil(stream, /^(.*)\n/u);
}

async function readUntil(stream: ReadableStream<Uint8Array> | null, pattern: RegExp): Promise<string> {
	assert.ok(stream);
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		for (;;) {
			const match = pattern.exec(text);
			if (match) return match[1] ?? "";
			const { value, done } = await reader.read();
			if (done) throw new Error(`output ended before ${pattern}: ${text}`);
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
}
