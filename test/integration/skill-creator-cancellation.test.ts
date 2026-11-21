import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { startPtyProgram } from "../helpers/pty-program.js";
import { removeTempDirectory, sleep, spawnProcess, spawnSyncCollect } from "../helpers/runtime.js";
import {
	createScriptSandbox,
	processRuns,
	python,
	type ScriptSandbox,
	startedPids,
	waitUntilGone,
} from "../helpers/skill-creator-scripts.js";

// Each query's Atomic gets two stop requests of 50 polls of 100 ms each before it is killed.
const STOP_ESCALATION_MS = 10_000;
// A real Python interpreter per script and per fake Atomic; a few seconds under load.
const START_MS = 15_000;
const STALLED_TEST_MS = START_MS + STOP_ESCALATION_MS + 15_000;

const sandboxes: ScriptSandbox[] = [];
afterEach(() => {
	for (const sandbox of sandboxes.splice(0)) removeTempDirectory(sandbox.dir);
});

function sandbox(): ScriptSandbox {
	const created = createScriptSandbox("skill-creator-stop-");
	sandboxes.push(created);
	return created;
}

function evalArgs(box: ScriptSandbox, queries: readonly string[]): string[] {
	const evalSet = box.writeEvalSet(queries.map((query) => ({ query, should_trigger: true })));
	return ["-m", "scripts.run_eval", "--eval-set", evalSet, "--skill-path", box.skill, "--runs-per-query", "1"];
}

describe.skipIf(python === undefined || process.platform === "win32")(
	"skill-creator scripts stop what they start",
	() => {
		for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
			test(`${signal} to the script stops every Atomic it started and their processes, removes its files and exits by ${signal} (#5625)`, async () => {
				const box = sandbox();
				const script = spawnProcess([python ?? "python3", ...evalArgs(box, ["one", "two"])], {
					cwd: box.project,
					env: box.env({ FAKE_ATOMIC_SCENARIO: "hold-child" }),
					stdout: "pipe",
				});
				const records = await box.waitForRecords(2, START_MS);
				script.kill(signal);
				await script.exited;
				assert.equal(script.signalCode, signal);
				await waitUntilGone(startedPids(records), 5_000);
				assert.deepEqual(readdirSync(box.temp), []);
				assert.equal(await new Response(script.stdout).text(), "", "no results for a stopped evaluation");
			});
		}

		test.skipIf(process.platform !== "linux")(
			"after a stop signal, kills a query's Atomic that does not act on it and everything that Atomic left running (#5625)",
			async () => {
				const box = sandbox();
				const script = spawnProcess([python ?? "python3", ...evalArgs(box, ["stalled"])], {
					cwd: box.project,
					// The helper's own child does not inherit the evaluation's environment.
					env: box.env({ FAKE_ATOMIC_SCENARIO: "stalled-child", FAKE_ATOMIC_CLEAN_GRANDCHILD: "1" }),
				});
				const records = await box.waitForRecords(1, START_MS);
				const stoppedAt = Date.now();
				script.kill("SIGTERM");
				await script.exited;
				assert.equal(script.signalCode, "SIGTERM");
				assert.ok(Date.now() - stoppedAt < STOP_ESCALATION_MS + 5_000);
				await waitUntilGone(startedPids(records), 5_000);
				assert.deepEqual(readdirSync(box.temp), []);
			},
			STALLED_TEST_MS,
		);

		test.skipIf(process.platform !== "linux")(
			"leaves the browser that run_loop opened for its report running when a stop signal ends the evaluation (#5625)",
			async () => {
				const box = sandbox();
				const browserPid = join(box.dir, "browser.pid");
				// A browser command that starts the browser in a session of its own and returns.
				const opener = join(box.dir, "open-browser");
				writeFileSync(
					opener,
					`#!/bin/sh\nsetsid sleep 120 </dev/null >/dev/null 2>&1 &\necho $! > '${browserPid}'\n`,
					{
						mode: 0o755,
					},
				);
				const evalSet = box.writeEvalSet([{ query: "stalled", should_trigger: true }]);
				const args = ["--eval-set", evalSet, "--skill-path", box.skill, "--model", "local/model"];
				const script = spawnProcess(
					[
						python ?? "python3",
						"-m",
						"scripts.run_loop",
						...args,
						"--holdout",
						"0",
						"--report",
						join(box.dir, "report.html"),
					],
					{ cwd: box.project, env: box.env({ FAKE_ATOMIC_SCENARIO: "stalled-child", BROWSER: `${opener} %s` }) },
				);
				const records = await box.waitForRecords(1, START_MS);
				const browser = Number(readFileSync(browserPid, "utf8"));
				try {
					script.kill("SIGTERM");
					await script.exited;
					assert.equal(script.signalCode, "SIGTERM");
					await waitUntilGone(startedPids(records), 5_000);
					assert.ok(processRuns(browser), "the report's browser still runs");
				} finally {
					process.kill(browser, "SIGKILL");
				}
			},
			STALLED_TEST_MS,
		);

		test.skipIf(process.platform !== "linux")(
			"kills a timed-out query's Atomic that does not act on SIGTERM and the processes it left running (#5625)",
			() => {
				const box = sandbox();
				const evalSet = box.writeEvalSet([{ query: "stalled", should_trigger: true }]);
				const args = ["--eval-set", evalSet, "--skill-path", box.skill, "--timeout", "1", "--runs-per-query", "1"];
				const result = spawnSyncCollect([python ?? "python3", "-m", "scripts.run_eval", ...args], {
					cwd: box.project,
					env: box.env({ FAKE_ATOMIC_SCENARIO: "stalled-child" }),
				});
				assert.equal(result.exitCode, 0, result.stderr.toString());
				assert.match(result.stderr.toString(), /query failed: Timed out after 1s/u);
				return waitUntilGone(startedPids(box.records()), 5_000).then(() => {
					assert.deepEqual(readdirSync(box.temp), []);
				});
			},
			STALLED_TEST_MS,
		);

		test("keeps an ignored SIGHUP ignored, so a nohup run finishes (#5625)", async () => {
			const box = sandbox();
			// nohup: the script starts with SIGHUP ignored.
			const nohup =
				"import os,signal,sys\nsignal.signal(signal.SIGHUP, signal.SIG_IGN)\nos.execv(sys.executable, [sys.executable] + sys.argv[1:])";
			const script = spawnProcess([python ?? "python3", "-c", nohup, ...evalArgs(box, ["slow"])], {
				cwd: box.project,
				env: box.env({ FAKE_ATOMIC_SCENARIO: "slow:1" }),
				stdout: "pipe",
			});
			await box.waitForRecords(1, START_MS);
			script.kill("SIGHUP");
			assert.equal(await script.exited, 0);
			const output = JSON.parse(await new Response(script.stdout).text()) as { summary: { passed: number } };
			assert.equal(output.summary.passed, 1);
		});

		test("a stop signal before anything started ends the script at once and starts nothing (#5625)", async () => {
			const box = sandbox();
			const fifo = join(box.dir, "eval-set.fifo");
			assert.equal(
				spawnSyncCollect([python ?? "python3", "-c", `import os; os.mkfifo(${JSON.stringify(fifo)})`]).exitCode,
				0,
			);
			const script = spawnProcess(
				[python ?? "python3", "-m", "scripts.run_eval", "--eval-set", fifo, "--skill-path", box.skill],
				{ cwd: box.project, env: box.env() },
			);
			// The script waits for its eval set, which never comes.
			await sleep(1_000);
			script.kill("SIGTERM");
			await script.exited;
			assert.equal(script.signalCode, "SIGTERM");
			assert.deepEqual(box.records(), []);
		});

		test("importing keeps the caller's signal handlers, and cancel() stops a running evaluation (#5625)", async () => {
			const box = sandbox();
			const program = `
import json, signal, sys, threading
from pathlib import Path
before = {name: signal.getsignal(getattr(signal, name)) for name in ("SIGINT", "SIGTERM", "SIGHUP")}
from scripts import atomic_cli
from scripts.run_eval import run_eval
outcome = {}
def evaluate():
    try:
        run_eval([{"query": "q1", "should_trigger": True}, {"query": "q2", "should_trigger": True}],
                 "sample", "sample skill", 2, 60, Path("."))
        outcome["result"] = "finished"
    except atomic_cli.Cancelled:
        outcome["result"] = "cancelled"
worker = threading.Thread(target=evaluate)
worker.start()
sys.stdin.readline()
atomic_cli.cancel()
worker.join(30)
after = {name: signal.getsignal(getattr(signal, name)) for name in ("SIGINT", "SIGTERM", "SIGHUP")}
print(json.dumps({"result": outcome.get("result"), "handlers_kept": before == after, "joined": not worker.is_alive()}))
`;
			const script = spawnProcess([python ?? "python3", "-c", program], {
				cwd: box.project,
				env: box.env({ FAKE_ATOMIC_SCENARIO: "hold-child" }),
				stdin: "pipe",
				stdout: "pipe",
			});
			const records = await box.waitForRecords(2, START_MS);
			script.stdin?.write("cancel\n");
			assert.equal(await script.exited, 0);
			assert.deepEqual(JSON.parse(await new Response(script.stdout).text()), {
				result: "cancelled",
				handlers_kept: true,
				joined: true,
			});
			await waitUntilGone(startedPids(records), 5_000);
			assert.deepEqual(readdirSync(box.temp), []);
		});

		test.skipIf(process.platform !== "linux")(
			"Ctrl+Z pauses the queries with the script, fg continues them and Ctrl+C then ends them all (#5625)",
			async () => {
				const box = sandbox();
				const args = evalArgs(box, ["one", "two"])
					.map((arg) => `'${arg}'`)
					.join(" ");
				const env = box.env({ FAKE_ATOMIC_SCENARIO: "hold-child", PS1: "PROMPT> ", HOME: box.dir, TERM: "xterm" });
				const shell = startPtyProgram({
					executable: "bash",
					args: ["--norc", "--noprofile", "-i"],
					cwd: box.project,
					env,
					timeoutMs: 60_000,
					cols: 200,
					rows: 40,
				});
				const state = (pid: number) => readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)?.[0];
				try {
					await shell.waitForScreen((screen) => screen.includes("PROMPT>"), START_MS, "the shell prompt");
					shell.write(`'${python}' ${args}\r`);
					const records = await box.waitForRecords(2, START_MS);
					const scriptPid = records[0]?.ppid ?? 0;
					// The helper runs in its own session, outside the job, as Atomic's credential commands do.
					const job = [scriptPid, ...records.map((record) => record.pid)];
					shell.write("\x1a");
					await shell.waitForScreen((screen) => /Stopped/u.test(screen), START_MS, "the stopped job");
					await waitFor(() => job.every((pid) => state(pid) === "T"), "every process of the job stopped");
					shell.write("fg\r");
					await waitFor(() => job.every((pid) => state(pid) !== "T"), "every process of the job continued");
					shell.write("\x03");
					// bash drops the rest of a command line whose command Ctrl+C ended, so ask for the status after it.
					await shell.waitForScreen(
						(screen) => (screen.match(/PROMPT>/gu) ?? []).length >= 3,
						START_MS,
						"the prompt after Ctrl+C",
					);
					shell.write('echo "STATUS:$?"\r');
					await shell.waitForScreen((screen) => screen.includes("STATUS:130"), START_MS, "the status of Ctrl+C");
					await waitUntilGone(startedPids(records), 5_000);
					assert.deepEqual(readdirSync(box.temp), []);
					assert.ok(!processRuns(scriptPid));
				} finally {
					shell.kill();
					await shell.exited;
				}
			},
			60_000,
		);
	},
);

async function waitFor(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + START_MS;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(25);
	}
}
