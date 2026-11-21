import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, test } from "vitest";
import { removeTempDirectory, spawnProcess, spawnSyncCollect } from "../helpers/runtime.js";
import {
	createScriptSandbox,
	python,
	readLine,
	readUntil,
	type ScriptSandbox,
	skillCreatorDir,
} from "../helpers/skill-creator-scripts.js";

// A Python start for the viewer and for the program holding its port; seconds under load.
const VIEWER_START_MS = 15_000;
// Python reports a file it opens in the locale's encoding, and fails on it, as Windows' ANSI code page would.
const NO_LOCALE_ENCODING = ["-X", "warn_default_encoding", "-W", "error::EncodingWarning"];

const sandboxes: ScriptSandbox[] = [];
afterEach(() => {
	for (const sandbox of sandboxes.splice(0)) removeTempDirectory(sandbox.dir);
});

function sandbox(): ScriptSandbox {
	const created = createScriptSandbox("skill-creator-files-");
	sandboxes.push(created);
	return created;
}

function runPython(box: ScriptSandbox, args: readonly string[], env: Record<string, string> = {}) {
	return spawnSyncCollect([python ?? "python3", ...args], { cwd: box.project, env: box.env(env) });
}

/** Every file and folder under `root`, relative to it, folders ending in `/` and links in `@`. */
function listTree(root: string): string[] {
	const found: string[] = [];
	const visit = (folder: string) => {
		for (const entry of readdirSync(folder, { withFileTypes: true })) {
			const path = join(folder, entry.name);
			if (entry.isSymbolicLink()) found.push(`${relative(root, path)}@`);
			else if (entry.isDirectory()) {
				found.push(`${relative(root, path)}/`);
				visit(path);
			} else found.push(relative(root, path));
		}
	};
	visit(root);
	return found.sort();
}

function workspaceWithOneRun(box: ScriptSandbox): string {
	const workspace = join(box.dir, "workspace");
	mkdirSync(join(workspace, "eval-1", "with_skill", "outputs"), { recursive: true });
	writeFileSync(join(workspace, "eval-1", "with_skill", "outputs", "answer.txt"), "answer");
	return workspace;
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${what} within ${milliseconds} ms`)), milliseconds);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Starts a program that listens on a free port and returns the port and the program. */
async function occupyPort(): Promise<{ port: number; listener: ReturnType<typeof spawnProcess> }> {
	const listener = spawnProcess(
		[
			python ?? "python3",
			"-c",
			"import socket,time\ns=socket.socket()\ns.bind(('127.0.0.1',0))\ns.listen()\nprint(s.getsockname()[1],flush=True)\ntime.sleep(60)",
		],
		{ stdout: "pipe" },
	);
	return { port: Number((await readLine(listener.stdout)).trim()), listener };
}

describe.skipIf(python === undefined)("skill-creator scripts' files and review viewer", () => {
	test.skipIf(process.platform === "win32")(
		"write the optimization loop's report when no queries are held out (--holdout 0)",
		() => {
			const box = sandbox();
			const report = join(box.dir, "report.html");
			const evalSet = box.writeEvalSet([{ query: "make the report", should_trigger: true }]);
			const result = runPython(box, [
				join(skillCreatorDir, "scripts", "run_loop.py"),
				"--eval-set",
				evalSet,
				"--skill-path",
				box.skill,
				"--model",
				"local/model",
				"--max-iterations",
				"1",
				"--runs-per-query",
				"1",
				"--holdout",
				"0",
				"--report",
				report,
			]);
			assert.equal(result.exitCode, 0, result.stderr.toString());
			const output = JSON.parse(result.stdout.toString()) as {
				best_score: string;
				history: { test_results: unknown }[];
			};
			assert.equal(output.best_score, "1/1");
			assert.equal(output.history[0]?.test_results, null, "no held-out results, as before");
			const html = readFileSync(report, "utf8");
			assert.match(html, /<th class="positive-col">make the report<\/th>/u);
			assert.doesNotMatch(html, /<th class="test-col/u, "no held-out query columns");
		},
	);

	test("read and write the skill-creator's files as UTF-8, whatever the locale's encoding", () => {
		const box = sandbox();
		const iteration = join(box.dir, "workspace", "iteration-1");
		const text = "Le r\u00e9sum\u00e9 a un titre \u2713 \u65e5\u672c";
		for (const config of ["with_skill", "without_skill"]) {
			const run = join(iteration, "eval-0", config, "run-1");
			mkdirSync(run, { recursive: true });
			writeFileSync(
				join(run, "grading.json"),
				JSON.stringify({
					summary: { pass_rate: 1, passed: 1, failed: 0, total: 1 },
					expectations: [{ text, passed: true, evidence: text }],
				}),
			);
		}
		const aggregate = runPython(box, [
			...NO_LOCALE_ENCODING,
			join(skillCreatorDir, "scripts", "aggregate_benchmark.py"),
			iteration,
			"--skill-name",
			"caf\u00e9 \u2713",
		]);
		assert.equal(aggregate.exitCode, 0, aggregate.stderr.toString());
		assert.match(readFileSync(join(iteration, "benchmark.md"), "utf8"), /^# Skill Benchmark: caf\u00e9 \u2713$/mu);
		const benchmark = JSON.parse(readFileSync(join(iteration, "benchmark.json"), "utf8")) as {
			runs: { expectations: { text: string }[] }[];
		};
		assert.equal(benchmark.runs[0]?.expectations[0]?.text, text);

		// The loop writes the improvement step's transcript into its results folder.
		const evalSet = box.writeEvalSet([{ query: text, should_trigger: true }]);
		const results = join(box.dir, "results");
		const loop = runPython(
			box,
			[
				...NO_LOCALE_ENCODING,
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
				"--results-dir",
				results,
			],
			{ FAKE_ATOMIC_SCENARIO: "improve", FAKE_ATOMIC_PLAN: JSON.stringify({ [text]: "read-other" }) },
		);
		assert.equal(loop.exitCode, 0, loop.stderr.toString());
		const [run] = readdirSync(results);
		const transcript = JSON.parse(readFileSync(join(results, run ?? "", "logs", "improve_iter_1.json"), "utf8")) as {
			final_description: string;
		};
		assert.equal(transcript.final_description, "Use this skill for fake work. \u2713");
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"remove a temporary folder past an entry that cannot be removed, as before",
		() => {
			const box = sandbox();
			const folder = join(box.dir, "scratch");
			// Two subfolders, each with a file that can be removed and a folder whose file cannot: whichever is
			// visited first, the other's removable file must go too.
			const locked = ["one", "two"].map((name) => join(folder, name, "locked"));
			for (const dir of locked) {
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, "..", "removable.txt"), "x");
				writeFileSync(join(dir, "kept.txt"), "x");
				chmodSync(dir, 0o500);
			}
			try {
				const result = runPython(box, [
					"-c",
					"import sys\nfrom pathlib import Path\nfrom scripts.atomic_cli import remove_folder\nremove_folder(Path(sys.argv[1]))",
					folder,
				]);
				assert.equal(result.exitCode, 0, result.stderr.toString());
				assert.deepEqual(listTree(folder), [
					"one/",
					"one/locked/",
					"one/locked/kept.txt",
					"two/",
					"two/locked/",
					"two/locked/kept.txt",
				]);
			} finally {
				for (const dir of locked) chmodSync(dir, 0o700);
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"leave a link standing in a temporary folder's place, and what it links to, as before",
		() => {
			const box = sandbox();
			const target = join(box.dir, "target");
			mkdirSync(target);
			writeFileSync(join(target, "kept.txt"), "x");
			symlinkSync(target, join(box.dir, "scratch"));
			symlinkSync(join(box.dir, "nowhere"), join(box.dir, "dangling"));
			const result = runPython(box, [
				"-c",
				"import sys\nfrom pathlib import Path\nfrom scripts.atomic_cli import remove_folder\nfor path in sys.argv[1:]: remove_folder(Path(path))",
				join(box.dir, "scratch"),
				join(box.dir, "dangling"),
			]);
			assert.equal(result.exitCode, 0, result.stderr.toString());
			assert.deepEqual(
				listTree(box.dir).filter((path) => /^(scratch|dangling|target)/u.test(path)),
				["dangling@", "scratch@", "target/", "target/kept.txt"],
			);
		},
	);

	test.skipIf(process.platform === "win32")(
		"print the review viewer's URL as soon as it serves when its output goes to a pipe in another encoding",
		async () => {
			const box = sandbox();
			const workspace = workspaceWithOneRun(box);
			const { port, listener } = await occupyPort();
			let viewer: ReturnType<typeof spawnProcess> | undefined;
			try {
				// As an agent's background shell starts it: output to a pipe, here in Windows' ANSI code page.
				viewer = spawnProcess(
					[
						python ?? "python3",
						join(skillCreatorDir, "eval-viewer", "generate_review.py"),
						workspace,
						"--port",
						`${port}`,
					],
					{ cwd: box.dir, env: box.env({ PYTHONIOENCODING: "cp1252" }), stdout: "pipe", stderr: "pipe" },
				);
				const url = await withTimeout(
					readUntil(viewer.stdout, /URL:\s+(\S+)/u),
					VIEWER_START_MS,
					"the URL is printed",
				);
				assert.notEqual(new URL(url).port, `${port}`, "a free port, not the one in use");
				const page = await fetch(url);
				assert.equal(page.status, 200);
				assert.match(await page.text(), /EMBEDDED_DATA/u);
			} finally {
				viewer?.kill("SIGTERM");
				listener.kill("SIGKILL");
				await Promise.allSettled([viewer?.exited, listener.exited]);
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"save review feedback as UTF-8, whatever the locale's encoding",
		async () => {
			const box = sandbox();
			const workspace = workspaceWithOneRun(box);
			const viewer = spawnProcess(
				[
					python ?? "python3",
					...NO_LOCALE_ENCODING,
					join(skillCreatorDir, "eval-viewer", "generate_review.py"),
					workspace,
					"--port",
					"0",
				],
				{ cwd: box.dir, env: box.env({ PYTHONUNBUFFERED: "1" }), stdout: "pipe", stderr: "pipe" },
			);
			try {
				const url = await withTimeout(
					readUntil(viewer.stdout, /URL:\s+(\S+)/u),
					VIEWER_START_MS,
					"the URL is printed",
				);
				const reviews = { reviews: [{ run_id: "eval-1-with_skill", feedback: "Le titre \u2713 \u65e5\u672c" }] };
				const saved = await fetch(`${url}/api/feedback`, { method: "POST", body: JSON.stringify(reviews) });
				assert.equal(saved.status, 200, await saved.clone().text());
				assert.deepEqual(JSON.parse(readFileSync(join(workspace, "feedback.json"), "utf8")), reviews);
				assert.deepEqual(await (await fetch(`${url}/api/feedback`)).json(), reviews);
			} finally {
				viewer.kill("SIGTERM");
				await viewer.exited;
			}
		},
	);
});
