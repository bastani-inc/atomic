import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { fileExists, readText, spawnSyncCollect } from "../helpers/runtime.js";

// The scenario drives a real tmux session. Windows runners have no tmux (the RFC names psmux or
// native PTY automation as the separate Windows proof), so the platform gate is the presence of the
// binary itself, checked once, not a soft guard around a failing assertion.
const TMUX_AVAILABLE = (() => {
	try {
		return spawnSyncCollect(["tmux", "-V"]).exitCode === 0;
	} catch {
		return false; // spawnSync raises ENOENT when the binary is absent.
	}
})();

const REAL_TASK_TERMINAL_SCENARIO_TIMEOUT_MS = 120_000;
// RFC #2884: actual tmux/native/session scenarios, not static mockup string tests.
const chat = "main";
test.skipIf(!TMUX_AVAILABLE)(
	`${chat} terminal retains task identity through yield, settlement and process cleanup`,
	async () => {
		const root = await mkdtemp(join(tmpdir(), `atomic-task-${chat}-`));
		try {
			const result = spawnSyncCollect(
				[
					process.execPath,
					"test/fixtures/task-experience-driver.mjs",
					"run",
					"--chat",
					chat,
					"--evidence-root",
					root,
					"--columns",
					"100",
					"--rows",
					"30",
				],
				{ timeout: REAL_TASK_TERMINAL_SCENARIO_TIMEOUT_MS },
			);
			assert.equal(result.exitCode, 0, result.stderr.toString());
			const directory = result.stdout.toString().trim().split("\n").at(-1)?.replace(`PASS ${chat} `, "");
			assert.ok(directory);
			assert.ok(directory.startsWith(root));
			assert.match(await readText(join(directory, "live.txt")), /◯ worker {2}.*Inspect deterministic fixture/);
			assert.match(await readText(join(directory, "live-inspector.txt")), /t17 Inspect deterministic fixture/);
			assert.match(await readText(join(directory, "settled-inspector.txt")), /t17 Inspect deterministic fixture/);
			assert.match(await readText(join(directory, "settled.txt")), /● \S+ finished/);
			const lines = (await readText(join(directory, "barriers.jsonl"))).trim().split("\n");
			const barriers = lines.map(
				(line) =>
					JSON.parse(line) as {
						barrier: string;
						taskId?: string;
						evidence: {
							startCount?: number;
							genuineMessageCount?: number;
							anchorCount?: number;
							completionCount?: number;
							receipt?: { tasks: Array<{ cleanup: { kind: string } }> };
						};
					},
			);
			const live = barriers.find((item) => item.barrier === "intercom-live");
			const terminal = barriers.find((item) => item.barrier === "terminal");
			assert.ok(live?.taskId);
			assert.equal(terminal?.taskId, live.taskId);
			assert.equal(live.evidence.startCount, 1);
			assert.equal(live.evidence.genuineMessageCount, 1);
			assert.ok(
				barriers.some(
					(item) =>
						item.barrier === "rendered" && item.evidence.anchorCount === 0 && item.evidence.completionCount === 1,
				),
			);
			const cleanupIndex = barriers.findIndex((item) => item.barrier === "cleanup");
			assert.ok(cleanupIndex >= 0 && cleanupIndex < barriers.findIndex((item) => item.barrier === "stopped"));
			assert.ok(barriers[cleanupIndex].evidence.receipt?.tasks.every((item) => item.cleanup.kind === "reaped"));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
	REAL_TASK_TERMINAL_SCENARIO_TIMEOUT_MS,
);

test.skipIf(!TMUX_AVAILABLE)(
	`${chat} terminal assertion failure preserves its error and reaps owned shell processes`,
	async () => {
		const root = await mkdtemp(join(tmpdir(), `atomic-task-failure-${chat}-`));
		try {
			const result = spawnSyncCollect(
				[
					process.execPath,
					"test/fixtures/task-experience-driver.mjs",
					"run",
					"--chat",
					chat,
					"--evidence-root",
					root,
					"--fail-after-shell",
				],
				{ timeout: REAL_TASK_TERMINAL_SCENARIO_TIMEOUT_MS },
			);
			assert.equal(result.exitCode, 1);
			assert.match(result.stderr.toString(), /Fixture assertion after shell admission/);
			assert.doesNotMatch(result.stderr.toString(), /Fixture did not exit|survived cleanup/);
			const directories = (await readdir(root, { withFileTypes: true })).filter(
				(entry) => entry.isDirectory() && !entry.name.endsWith("-home"),
			);
			assert.equal(directories.length, 1);
			const directory = join(root, directories[0]!.name);
			assert.equal(await fileExists(join(directory, "failure.log")), false);
			const barriers = (await readText(join(directory, "barriers.jsonl")))
				.trim()
				.split("\n")
				.map(
					(line) =>
						JSON.parse(line) as {
							barrier: string;
							evidence: { receipt?: { tasks: Array<{ cleanup: { kind: string } }> } };
						},
				);
			assert.ok(barriers.some((item) => item.barrier === "shell-ready"));
			const stopped = barriers.filter((item) => item.barrier === "stopped");
			assert.equal(stopped.length, 1);
			assert.equal(stopped[0]!.evidence.receipt?.tasks.length, 2);
			assert.ok(stopped[0]!.evidence.receipt?.tasks.every((task) => task.cleanup.kind === "reaped"));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
	REAL_TASK_TERMINAL_SCENARIO_TIMEOUT_MS,
);
