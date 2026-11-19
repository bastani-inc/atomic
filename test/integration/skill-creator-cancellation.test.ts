/**
 * The skill-creator description scripts start `claude -p` for every query. Stopping a script must stop
 * everything it started and nothing else. These tests run the real scripts against a fake `claude` that
 * starts a child of its own, then check which of those processes are still running.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, test } from "vitest";
import { makeTempDirectory, moduleDir, removeTempDirectory, sleep } from "../helpers/runtime.js";

const root = resolve(moduleDir(import.meta.url), "../..");
const skillCreator = resolve(root, "packages/workflows/skills/skill-creator");
const fakeClaude = resolve(root, "test/fixtures/skill-creator-fake-claude.py");
const posix = process.platform !== "win32";
const python = posix ? "python3" : "python";
const hasPython = spawnSync(python, ["-c", ""]).status === 0;

interface FakeClaude {
	pid: number;
	child: number;
	argv: string[];
}

interface Workspace {
	dir: string;
	project: string;
	skill: string;
	evalSet: string;
	records: string;
	env: Record<string, string>;
}

const workspaces: Workspace[] = [];
const programs: ChildProcess[] = [];

afterEach(() => {
	for (const program of programs.splice(0)) {
		if (program.exitCode === null && program.signalCode === null && program.pid) {
			try {
				process.kill(-program.pid, "SIGKILL");
			} catch {}
		}
	}
	for (const space of workspaces.splice(0)) {
		for (const fake of fakes(space)) {
			for (const pid of [fake.pid, fake.child]) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
		}
		removeTempDirectory(space.dir);
	}
});

/** A project with a skill to evaluate, an eval set of `queries`, and `claude` on PATH being the fake. */
function workspace(queries: string[], mode: string): Workspace {
	const dir = makeTempDirectory("skill-creator-cancel-");
	const project = join(dir, "project");
	const skill = join(dir, "skill");
	const records = join(dir, "records");
	const bin = join(dir, "bin");
	for (const path of [join(project, ".claude"), skill, records, bin]) mkdirSync(path, { recursive: true });
	writeFileSync(join(skill, "SKILL.md"), "---\nname: probe\ndescription: Answers probe questions.\n---\n\n# Probe\n");
	const evalSet = join(dir, "eval.json");
	writeFileSync(evalSet, JSON.stringify(queries.map((query) => ({ query, should_trigger: true }))));
	const claude = join(bin, "claude");
	writeFileSync(claude, `#!/bin/sh\nexec ${JSON.stringify(python)} ${JSON.stringify(fakeClaude)} "$@"\n`);
	chmodSync(claude, 0o755);
	const env = {
		PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
		PYTHONPATH: skillCreator,
		PYTHONDONTWRITEBYTECODE: "1",
		FAKE_CLAUDE_RECORDS: records,
		FAKE_CLAUDE_MODE: mode,
	};
	const space = { dir, project, skill, evalSet, records, env };
	workspaces.push(space);
	return space;
}

function fakes(space: Workspace): FakeClaude[] {
	return readdirSync(space.records)
		.filter((name) => name.endsWith(".json"))
		.map((name) => JSON.parse(readFileSync(join(space.records, name), "utf8")) as FakeClaude);
}

async function startedFakes(space: Workspace, count: number): Promise<FakeClaude[]> {
	for (let waited = 0; waited < 20_000; waited += 25) {
		const started = fakes(space);
		if (started.length >= count) return started;
		await sleep(25);
	}
	assert.fail(`only ${fakes(space).length} of ${count} fake claude commands started`);
}

/** Whether a process is running: a zombie waiting to be reaped has already stopped. */
function running(pid: number): boolean {
	try {
		const state = readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /su, "")[0];
		return state !== "Z" && state !== "X";
	} catch {
		if (process.platform === "linux") return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** The fake commands and their children still running after a short grace for the kernel to finish them. */
async function survivors(started: FakeClaude[]): Promise<number[]> {
	const pids = started.flatMap((fake) => [fake.pid, fake.child]);
	for (let waited = 0; waited < 3_000 && pids.some(running); waited += 25) await sleep(25);
	return pids.filter(running);
}

function commandFiles(space: Workspace): string[] {
	return readdirSync(join(space.project, ".claude", "commands")).filter((name) => name.endsWith(".md"));
}

interface Exit {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

/** Run a skill-creator script as a command in its own process group, the way a terminal runs a foreground job. */
function launch(space: Workspace, script: string, args: string[], env: Record<string, string> = {}) {
	const program = spawn(python, ["-m", script, ...args], {
		cwd: space.project,
		env: { ...space.env, ...env },
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	programs.push(program);
	let stdout = "";
	let stderr = "";
	program.stdout?.on("data", (data) => {
		stdout += data;
	});
	program.stderr?.on("data", (data) => {
		stderr += data;
	});
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
		program.on("exit", (code, signal) => resolveExit({ code, signal }));
	});
	// Output is complete once every holder of the script's stdout and stderr has exited, its own children included.
	const closed = new Promise<void>((resolveClose) => program.on("close", () => resolveClose()));
	return {
		program,
		exited: async (limit = 20_000): Promise<Exit> => {
			const exit = await Promise.race([exited, sleep(limit).then(() => undefined)]);
			assert.ok(exit, `${script} did not exit within ${limit} ms of being stopped\n${stderr}`);
			await Promise.race([closed, sleep(2_000)]);
			return { ...exit, stdout, stderr };
		},
	};
}

const importer = resolve(root, "test/fixtures/skill-creator-importer.py");

/** Run the importer fixture's scenario and return its JSON report. */
async function imported(space: Workspace, scenario: string, signalOnceStarted?: NodeJS.Signals) {
	const program = spawn(python, [importer, space.project, scenario], {
		cwd: space.project,
		env: space.env,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	programs.push(program);
	let stdout = "";
	let stderr = "";
	program.stdout?.on("data", (data) => {
		stdout += data;
	});
	program.stderr?.on("data", (data) => {
		stderr += data;
	});
	const closed = new Promise<number | null>((resolveClose) => program.on("close", (code) => resolveClose(code)));
	if (signalOnceStarted) {
		await startedFakes(space, 2);
		process.kill(program.pid ?? 0, signalOnceStarted);
	}
	const code = await Promise.race([closed, sleep(100_000).then(() => "timeout" as const)]);
	assert.notEqual(code, "timeout", `${scenario} did not finish\n${stderr}`);
	assert.equal(code, 0, stderr);
	return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
}

function improve(space: Workspace, env: Record<string, string>) {
	const results = join(space.dir, "results.json");
	const failed = { query: "first question", should_trigger: true, trigger_rate: 0, triggers: 0, runs: 1, pass: false };
	const summary = { total: 1, passed: 0, failed: 1 };
	writeFileSync(results, JSON.stringify({ description: "Answers probe questions.", results: [failed], summary }));
	const args = ["--eval-results", results, "--skill-path", space.skill, "--model", "any"];
	return launch(space, "scripts.improve_description", args, env);
}

function optimize(space: Workspace, env: Record<string, string>) {
	const args = ["--eval-set", space.evalSet, "--skill-path", space.skill, "--model", "any", "--runs-per-query", "1"];
	const loop = [
		"--max-iterations",
		"2",
		"--holdout",
		"0",
		"--report",
		"none",
		"--timeout",
		"600",
		"--num-workers",
		"2",
	];
	return launch(space, "scripts.run_loop", [...args, ...loop], env);
}

function evaluate(space: Workspace, extra: string[] = []) {
	const args = ["--eval-set", space.evalSet, "--skill-path", space.skill, "--runs-per-query", "1", "--timeout", "600"];
	return launch(space, "scripts.run_eval", [...args, "--num-workers", "2", ...extra]);
}

describe.runIf(posix && hasPython)("skill-creator description scripts on POSIX (#5625)", () => {
	for (const [signal, target] of [
		["SIGTERM", "the script"],
		["SIGHUP", "the script"],
		["SIGINT", "the script"],
		["SIGINT", "its process group"],
		["SIGHUP", "its process group"],
	] as const) {
		test(`${signal} to ${target} stops every query command and its children and exits with that signal (#5625)`, async () => {
			const space = workspace(["first question", "second question"], "wait");
			const run = evaluate(space);
			const started = await startedFakes(space, 2);
			assert.ok(run.program.pid);
			process.kill(target === "the script" ? run.program.pid : -run.program.pid, signal);
			const exit = await run.exited();
			assert.deepEqual(await survivors(started), [], "processes the script started are still running");
			assert.deepEqual(commandFiles(space), [], "temporary command files were left behind");
			assert.equal(exit.signal, signal, `exit ${exit.code}, stderr:\n${exit.stderr}`);
			assert.doesNotMatch(exit.stderr, /Traceback/u);
		});
	}

	test("an evaluation started with SIGHUP ignored, as nohup does, keeps ignoring it and finishes (#5625)", async () => {
		const space = workspace(["first question"], "held-trigger");
		// Ignore SIGHUP, then become the evaluator, as `nohup python -m scripts.run_eval ...` would.
		const nohup =
			"import os, signal, sys; signal.signal(signal.SIGHUP, signal.SIG_IGN); os.execvp(sys.argv[1], sys.argv[1:])";
		const args = [
			"--eval-set",
			space.evalSet,
			"--skill-path",
			space.skill,
			"--runs-per-query",
			"1",
			"--timeout",
			"600",
		];
		const program = spawn(python, ["-c", nohup, python, "-m", "scripts.run_eval", ...args, "--num-workers", "1"], {
			cwd: space.project,
			env: space.env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		programs.push(program);
		let stdout = "";
		program.stdout?.on("data", (data) => {
			stdout += data;
		});
		const closed = new Promise<number | null>((resolveClose) => program.on("close", (code) => resolveClose(code)));
		await startedFakes(space, 1);
		process.kill(program.pid ?? 0, "SIGHUP");
		writeFileSync(join(space.records, "allow-trigger"), "");
		assert.equal(await closed, 0);
		assert.equal(JSON.parse(stdout).results[0].triggers, 1);
	});

	test("SIGTERM to the description improver stops its command and the command's children (#5625)", async () => {
		const space = workspace([], "wait");
		const run = improve(space, { FAKE_CLAUDE_IMPROVE_MODE: "wait" });
		const started = await startedFakes(space, 1);
		process.kill(run.program.pid ?? 0, "SIGTERM");
		const exit = await run.exited();
		assert.deepEqual(await survivors(started), []);
		assert.equal(exit.signal, "SIGTERM", exit.stderr);
	});

	test("the description improver ends what its finished command left running and keeps the answer (#5625)", async () => {
		const space = workspace([], "wait");
		const run = improve(space, { FAKE_CLAUDE_IMPROVE_MODE: "answer" });
		const exit = await run.exited();
		assert.equal(exit.code, 0, exit.stderr);
		assert.equal(JSON.parse(exit.stdout).description, "A clearer description.");
		assert.deepEqual(await survivors(fakes(space)), []);
	});

	test("SIGTERM to the optimization loop while it improves the description stops everything it started (#5625)", async () => {
		const space = workspace(["first question", "second question"], "slow");
		const run = optimize(space, { FAKE_CLAUDE_SECONDS: "0", FAKE_CLAUDE_IMPROVE_MODE: "wait" });
		const started = await startedFakes(space, 1);
		process.kill(run.program.pid ?? 0, "SIGTERM");
		const exit = await run.exited();
		assert.deepEqual(await survivors(started), []);
		assert.equal(exit.signal, "SIGTERM", exit.stderr);
	});

	test("Ctrl+C to the optimization loop while it evaluates stops every query and removes the command files (#5625)", async () => {
		const space = workspace(["first question", "second question"], "wait");
		const run = optimize(space, {});
		const started = await startedFakes(space, 2);
		process.kill(-(run.program.pid ?? 0), "SIGINT");
		const exit = await run.exited();
		assert.deepEqual(await survivors(started), []);
		assert.deepEqual(commandFiles(space), []);
		assert.equal(exit.signal, "SIGINT", exit.stderr);
		assert.doesNotMatch(exit.stderr, /Traceback/u);
	});

	test("the eval viewer leaves a process it did not start on its port running and serves on another port (#5625)", async () => {
		const space = workspace([], "wait");
		const run = join(space.dir, "workspace", "eval-0");
		mkdirSync(join(run, "outputs"), { recursive: true });
		writeFileSync(join(run, "outputs", "answer.txt"), "An answer.\n");
		writeFileSync(join(run, "eval_metadata.json"), JSON.stringify({ eval_id: 0, prompt: "A question" }));
		const serve =
			"import http.server, sys; s = http.server.HTTPServer(('127.0.0.1', 0), http.server.SimpleHTTPRequestHandler); print(s.server_address[1], flush=True); s.serve_forever()";
		const bystander = spawn(python, ["-c", serve], {
			cwd: space.dir,
			stdio: ["ignore", "pipe", "ignore"],
			detached: true,
		});
		programs.push(bystander);
		const port = await new Promise<string>((resolvePort) =>
			bystander.stdout?.once("data", (data) => resolvePort(String(data).trim())),
		);
		const viewerScript = join(skillCreator, "eval-viewer", "generate_review.py");
		const viewer = spawn(python, [viewerScript, join(space.dir, "workspace"), "--port", port], {
			cwd: space.dir,
			env: { ...space.env, BROWSER: "true", PYTHONUNBUFFERED: "1" },
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		programs.push(viewer);
		let printed = "";
		viewer.stdout?.on("data", (data) => {
			printed += data;
		});
		for (let waited = 0; waited < 20_000 && !/URL:\s+\S+:\d+/u.test(printed); waited += 25) await sleep(25);
		const served = printed.match(/URL:\s+\S+:(\d+)/u)?.[1];
		assert.ok(served, `the viewer did not start:\n${printed}`);
		assert.notEqual(served, port);
		await sleep(200);
		assert.equal(bystander.exitCode, null, "the viewer stopped a server it did not start");
		assert.equal(bystander.signalCode, null, "the viewer stopped a server it did not start");
	});

	const linux = process.platform === "linux";
	test.runIf(linux && spawnSync("tmux", ["-V"]).status === 0)(
		"Ctrl+Z suspends the queries with the foreground job and fg continues them (#5625)",
		async () => {
			const space = workspace(["first question", "second question"], "wait");
			const socket = join(space.dir, "tmux");
			const tmux = (...args: string[]) => {
				const result = spawnSync("tmux", ["-S", socket, ...args], { env: space.env, encoding: "utf8" });
				assert.equal(result.status, 0, result.stderr);
			};
			try {
				tmux("-f", "/dev/null", "new-session", "-d", "-c", space.project, "bash --noprofile --norc");
				const command =
					"python3 -m scripts.run_eval --eval-set ../eval.json --skill-path ../skill --runs-per-query 1";
				tmux("send-keys", "-l", command);
				tmux("send-keys", "Enter");
				const started = await startedFakes(space, 2);
				const pids = started.flatMap((fake) => [fake.pid, fake.child]);
				const stopped = (pid: number) => readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)?.[0] === "T";
				const expectStopped = async (target: boolean) => {
					const ready = () => pids.every((pid) => stopped(pid) === target);
					for (let i = 0; i < 120 && !ready(); ++i) await sleep(25);
					assert.ok(ready(), target ? "queries kept running" : "queries did not resume");
				};
				tmux("send-keys", "C-z");
				await expectStopped(true);
				tmux("send-keys", "fg", "Enter");
				await expectStopped(false);
				tmux("send-keys", "C-c");
				assert.deepEqual(await survivors(started), []);
			} finally {
				spawnSync("tmux", ["-S", socket, "kill-server"]);
			}
		},
	);

	for (const signal of ["SIGTERM", "SIGHUP"] as const) {
		test.runIf(linux)(`a pending ${signal} stops a suspended evaluation promptly (#5625)`, async () => {
			const space = workspace(["first question", "second question"], "wait");
			const run = evaluate(space);
			const started = await startedFakes(space, 2);
			const pid = run.program.pid;
			assert.ok(pid);
			process.kill(-pid, "SIGSTOP");
			// Linux can deliver a signal pending across SIGCONT to any thread. Pick a worker rather than
			// depending on which thread the kernel happens to schedule first when the shell continues the job.
			const tid = readdirSync(`/proc/${pid}/task`).find((id) => Number(id) !== pid);
			assert.ok(tid);
			const deliver = [
				"import ctypes, signal, sys",
				"pid, tid = map(int, sys.argv[1:3])",
				"assert ctypes.CDLL(None).tgkill(pid, tid, getattr(signal, sys.argv[3])) == 0",
			].join("\n");
			const sent = spawnSync(python, ["-c", deliver, String(pid), tid, signal], { encoding: "utf8" });
			assert.equal(sent.status, 0, sent.stderr);
			process.kill(-pid, "SIGCONT");
			const exit = await run.exited(3_000);
			assert.equal(exit.signal, signal, exit.stderr);
			assert.deepEqual(await survivors(started), []);
			assert.deepEqual(commandFiles(space), []);
		});
	}

	// Ctrl+C at each line the evaluator runs on the importer's thread, each in a forked importer that then exits.
	test.runIf(linux)(
		"Ctrl+C at any line of an imported query leaves nothing running and no command file (#5625)",
		{ timeout: 120_000 },
		async () => {
			const report = await imported(workspace([], "trigger"), "interrupt-every-line");
			assert.deepEqual(report.running, [], `still running after Ctrl+C at line ${report.point}: ${report.where}`);
			assert.deepEqual(report.files, [], `command file left after Ctrl+C at line ${report.point}: ${report.where}`);
			assert.ok(report.points > 0);
		},
	);

	for (const scenario of ["cancel-from-thread", "cancel-from-handler"] as const) {
		test.runIf(linux)(
			`cancel() ${scenario === "cancel-from-thread" ? "from another thread" : "from the importer's own signal handler"} stops a running evaluation (#5625)`,
			async () => {
				const space = workspace([], "wait");
				const report = await imported(space, scenario, scenario === "cancel-from-handler" ? "SIGTERM" : undefined);
				assert.equal(report.outcome, "cancelled");
				assert.ok(report.seconds < 10, `cancelling took ${report.seconds} s`);
				assert.deepEqual(report.running, []);
				assert.deepEqual(report.files, []);
			},
		);
	}

	test("importing the scripts and evaluating keeps the importer's signal handlers (#5625)", async () => {
		const report = await imported(workspace([], "trigger"), "keep-handlers");
		assert.equal(report.kept, true);
		assert.equal(report.triggers, 1);
	});
});

describe.runIf(!posix && hasPython)("skill-creator description scripts on Windows (#5625)", () => {
	const driver = resolve(root, "test/fixtures/skill-creator-windows.py");
	const STATUS_CONTROL_C_EXIT = 0xc000013a;
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) removeTempDirectory(dir);
	});

	function windowsScenario(name: string) {
		const dir = makeTempDirectory("skill-creator-windows-");
		dirs.push(dir);
		const result = spawnSync(python, [driver, name, dir], { encoding: "utf8", timeout: 180_000 });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
	}

	test("a query whose command uses the skill counts as a trigger (#5625)", { timeout: 200_000 }, () => {
		const report = windowsScenario("triggers");
		assert.equal(report.status, 0, report.stderr);
		assert.equal(report.triggers, 1, report.stderr);
		assert.deepEqual(report.running, []);
		assert.deepEqual(report.files, []);
	});

	test("the description improver returns its command's answer and ends what the command left running (#5625)", {
		timeout: 200_000,
	}, () => {
		const report = windowsScenario("improve");
		assert.equal(report.status, 0, report.stderr);
		assert.equal(report.description, "A clearer description.");
		assert.deepEqual(report.running, []);
	});

	test("the description improver can run a native command that Windows won't let Python debug (#5625)", {
		timeout: 200_000,
	}, () => {
		const report = windowsScenario("native-command");
		assert.equal(report.status, 0, report.stderr);
		assert.equal(report.description, "A clearer description.");
	});

	test("terminating the evaluator outright still ends every query command and its children (#5625)", {
		timeout: 200_000,
	}, () => {
		const report = windowsScenario("terminate");
		assert.deepEqual(report.running, []);
	});

	test("terminating the evaluator during command creation does not strand a suspended process (#5625)", {
		timeout: 200_000,
	}, () => {
		assert.equal(windowsScenario("terminate-at-launch").exited, true, "the command did not exit");
	});

	for (const event of ["break", "ctrl-c", "close"] as const) {
		const what = { break: "Ctrl+Break", "ctrl-c": "Ctrl+C", close: "closing the console" }[event];
		test(`${what} stops every query command and its children and removes the command files (#5625)`, {
			timeout: 200_000,
		}, () => {
			const report = windowsScenario(event);
			assert.deepEqual(report.running, []);
			assert.deepEqual(report.files, []);
			assert.equal(report.status, STATUS_CONTROL_C_EXIT);
		});
	}
});
