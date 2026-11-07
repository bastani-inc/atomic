import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import type { OperationId, Result } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { TaskSupervisor } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { fileExists, readJson, readText, sleep } from "../helpers/runtime.js";

function value<T, E>(result: Result<T, E>): T {
	assert.equal(result.ok, true, result.ok ? "accepted" : JSON.stringify(result.error));
	return result.value;
}
function setup(terminationGraceMs?: number) {
	const supervisor = new TaskSupervisor();
	const scope = { kind: "session" as const, sessionId: crypto.randomUUID() };
	const host = supervisor.bindHostSession({
		scope,
		commandResources: terminationGraceMs === undefined ? undefined : { terminationGraceMs },
		authorizeLaunch() {},
		createRunner() {
			throw new Error("Command must not dispatch an agent");
		},
	});
	return { supervisor, owner: value(supervisor.openTaskOwner(host, scope)) };
}
async function until(predicate: () => Promise<boolean>) {
	const deadline = Date.now() + 5000;
	while (!(await predicate())) {
		assert.ok(Date.now() < deadline, "lifecycle barrier deadline");
		await sleep(10);
	}
}
function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
// RFC #2884: ordinary observation expiry never kills the owned process tree.
test.runIf(process.platform !== "win32")(
	"command wait yields while parent and grandchild live, then owner close reaps both",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "task-tree-"));
		const identitiesPath = join(directory, "identities.json");
		const { supervisor, owner } = setup();
		try {
			const task = value(
				await supervisor.startCommandTask(
					owner,
					{
						kind: "command",
						command: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolve("test/fixtures/task-process-tree.mjs"))} ${JSON.stringify(identitiesPath)}`,
						terminal: { kind: "pipe" },
					},
					"tree" as OperationId,
				),
			);
			await until(() => fileExists(identitiesPath));
			const identities = await readJson<{ parent: { pid: number }; grandchild: { pid: number } }>(identitiesPath);
			assert.equal(value(await supervisor.waitForTask(task, 0)).kind, "yielded");
			assert.ok(alive(identities.parent.pid));
			assert.ok(alive(identities.grandchild.pid));
			await until(async () =>
				value(await supervisor.readTaskOutput(task, { start: "0", maximumBytes: 8192 })).chunks.some((chunk) =>
					new TextDecoder().decode(chunk.bytes).includes("parent output"),
				),
			);
			const closed = value(await supervisor.closeTaskOwner(owner, "session-close"));
			assert.equal(closed.tasks[0].cleanup.kind, "reaped");
			assert.equal(alive(identities.parent.pid), false);
			assert.equal(alive(identities.grandchild.pid), false);
			const again = value(await supervisor.cancelTask(task, "user"));
			assert.equal(again.cleanup.kind, "reaped");
		} finally {
			await supervisor.closeTaskOwner(owner, "session-close");
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test.runIf(process.platform !== "win32")(
	"execution timeout kills separately and spawn failures are refused",
	async () => {
		const { supervisor, owner } = setup();
		try {
			const task = value(
				await supervisor.startCommandTask(
					owner,
					{ kind: "command", command: "sleep 30", terminal: { kind: "pipe" }, executionTimeoutMs: 40 },
					"timeout" as OperationId,
				),
			);
			assert.equal(value(await supervisor.waitForTask(task, 0)).kind, "yielded");
			const outcome = value(await supervisor.waitForTask(task, 5000));
			assert.equal(outcome.kind, "settled");
			if (outcome.kind === "settled")
				assert.deepEqual(outcome.result.kind === "cancelled" && outcome.result.cause, "execution-timeout");
			const failed = await supervisor.startCommandTask(
				owner,
				{ kind: "command", command: "true", cwd: "/atomic-path-that-does-not-exist", terminal: { kind: "pipe" } },
				"spawn-failed" as OperationId,
			);
			assert.equal(failed.ok, false);
			if (!failed.ok) assert.equal(failed.error.code, "SpawnFailed");
		} finally {
			value(await supervisor.closeTaskOwner(owner, "session-close"));
		}
	},
);

// RFC #2884: a naturally exited shell does not release its descendant resource.
test.runIf(process.platform !== "win32")("shell-first exit still confirms the grandchild stopped", async () => {
	const directory = await mkdtemp(join(tmpdir(), "task-shell-first-"));
	const identitiesPath = join(directory, "identities.json");
	const { supervisor, owner } = setup();
	try {
		const task = value(
			await supervisor.startCommandTask(
				owner,
				{
					kind: "command",
					command: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolve("test/fixtures/task-process-tree.mjs"))} ${JSON.stringify(identitiesPath)} --shell-first`,
					terminal: { kind: "pipe" },
				},
				"shell-first" as OperationId,
			),
		);
		await until(() => fileExists(identitiesPath));
		const identities = await readJson<{ parent: { pid: number }; grandchild: { pid: number } }>(identitiesPath);
		const result = value(await supervisor.waitForTask(task, 5000));
		assert.equal(result.kind, "settled");
		assert.equal(value(await supervisor.closeTaskOwner(owner, "session-close")).tasks[0].cleanup.kind, "reaped");
		assert.equal(alive(identities.parent.pid), false);
		assert.equal(alive(identities.grandchild.pid), false);
	} finally {
		await supervisor.closeTaskOwner(owner, "session-close");
		await rm(directory, { recursive: true, force: true });
	}
});

test.runIf(process.platform !== "win32")(
	"command completion/output/cancellation races keep one terminal decision and replay",
	async () => {
		const { supervisor, owner } = setup();
		try {
			for (let index = 0; index < 4; index++) {
				const intent = {
					kind: "command" as const,
					command: "printf ' raw output '; exit 0",
					terminal: { kind: "pipe" as const },
					description: "",
				};
				const operation = `race-${index}` as OperationId;
				const task = value(await supervisor.startCommandTask(owner, intent, operation));
				assert.equal(value(await supervisor.startCommandTask(owner, intent, operation)), task);
				const read = supervisor.readTaskOutput(task, { start: "0000", maximumBytes: 0 });
				const cancel = await supervisor.cancelTask(task, "user");
				assert.ok(cancel.ok);
				const terminal = value(await supervisor.waitForTask(task, 5000));
				assert.equal(terminal.kind, "settled");
				if (terminal.kind === "settled")
					assert.ok(
						terminal.result.kind === "completed" ||
							(terminal.result.kind === "cancelled" && terminal.result.cause === "user"),
					);
				assert.deepEqual(value(await read).chunks, []);
				assert.equal(value(await read).requested.start, "0000");
				const receipt = value(await supervisor.cancelTask(task, "execution-timeout"));
				assert.deepEqual(value(await supervisor.cancelTask(task, "output-limit")), receipt);
				const conflicting = await supervisor.startCommandTask(
					owner,
					{ ...intent, command: `${intent.command} ` },
					operation,
				);
				assert.equal(!conflicting.ok && conflicting.error.code, "OperationConflict");
			}
			const completed = value(
				await supervisor.startCommandTask(
					owner,
					{ kind: "command", command: "exit 0", terminal: { kind: "pipe" } },
					"zero-exit" as OperationId,
				),
			);
			const terminal = value(await supervisor.waitForTask(completed, 5000));
			assert.ok(terminal.kind === "settled" && terminal.result.kind === "completed");
			assert.equal(terminal.result.exitCode, 0);
			assert.ok(Object.hasOwn(terminal.result, "exitCode"));
		} finally {
			value(await supervisor.closeTaskOwner(owner, "session-close"));
		}
	},
);

test("command admission refuses an invalid internal termination grace (#4540)", async () => {
	for (const grace of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 60_001]) {
		const { supervisor, owner } = setup(grace);
		try {
			const result = await supervisor.startCommandTask(
				owner,
				{ kind: "command", command: "exit 0", terminal: { kind: "pipe" } },
				crypto.randomUUID() as OperationId,
			);
			assert.equal(result.ok, false, `accepted termination grace ${grace}`);
			if (!result.ok) assert.equal(result.error.code, "SpawnFailed");
		} finally {
			value(await supervisor.closeTaskOwner(owner, "session-close"));
		}
	}
});

const terminals = [
	["pipe", { kind: "pipe" }],
	["pty", { kind: "pty", columns: 80, rows: 24 }],
] as const;
// Separate process/pipe teardown from a real grace wait by several seconds, even on a loaded runner.
const TERM_GRACE_MS = 15_000;
const PROMPT_SETTLEMENT_MS = TERM_GRACE_MS / 3;
/** Milliseconds from launch to settlement, and the settled result. */
async function settle(command: string, terminal: (typeof terminals)[number][1]) {
	const { supervisor, owner } = setup(TERM_GRACE_MS);
	try {
		const started = performance.now();
		const task = value(
			await supervisor.startCommandTask(
				owner,
				{ kind: "command", command, terminal },
				crypto.randomUUID() as OperationId,
			),
		);
		const outcome = value(await supervisor.waitForTask(task, TERM_GRACE_MS + PROMPT_SETTLEMENT_MS));
		const elapsed = performance.now() - started;
		assert.ok(outcome.kind === "settled", JSON.stringify(outcome));
		return { elapsed, result: outcome.result };
	} finally {
		value(await supervisor.closeTaskOwner(owner, "session-close"));
	}
}

test.each(terminals)(
	"a command whose group is empty settles without the termination grace (%s) (#4268, #4540)",
	async (_, terminal) => {
		// Windows terminates its Job immediately, without a TERM grace; Unix must bypass the configured grace.
		const { elapsed, result } = await settle("exit 0", terminal);
		assert.deepEqual(result, { ...result, kind: "completed", exitCode: 0 });
		assert.ok(elapsed < PROMPT_SETTLEMENT_MS, `settled after ${elapsed.toFixed(1)} ms, waited for the grace`);
	},
);

test.runIf(process.platform !== "win32").each(terminals)(
	"a member left behind ends on TERM at once, or on KILL after the grace, and never outlives settlement (%s) (#4268, #4540)",
	async (_, terminal) => {
		const directory = await mkdtemp(join(tmpdir(), "task-straggler-"));
		try {
			// One member exits on TERM; the other ignores TERM (and the terminal's hangup) until KILL.
			for (const [ignores, trap] of [
				[false, ""],
				[true, `trap "" TERM HUP; `],
			] as const) {
				const pidPath = join(directory, ignores ? "ignores" : "exits");
				const { elapsed, result } = await settle(
					`/bin/sh -c '${trap}echo $$ > "$1"; exec sleep 30' sh '${pidPath}' </dev/null >/dev/null 2>&1 & while [ ! -s '${pidPath}' ]; do sleep 0.01; done`,
					terminal,
				);
				const straggler = Number((await readText(pidPath)).trim());
				assert.deepEqual(result, { ...result, kind: "completed", exitCode: 0 });
				assert.equal(alive(straggler), false, `straggler ${straggler} outlived settlement`);
				if (ignores)
					assert.ok(elapsed >= TERM_GRACE_MS, `settled after ${elapsed.toFixed(1)} ms, before the grace`);
				else
					assert.ok(
						elapsed < PROMPT_SETTLEMENT_MS,
						`settled after ${elapsed.toFixed(1)} ms, waited for the grace`,
					);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);
