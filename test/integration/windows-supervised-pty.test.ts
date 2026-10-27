import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type CommandIntent,
	type InputData,
	type OwnerScope,
	type TaskFailure,
	type TaskLease,
	TaskSupervisor,
} from "@bastani/atomic-natives";
import { test } from "vitest";
import { readJson, sleep } from "../helpers/runtime.js";

function value<T>(result: { ok: true; value: T } | { ok: false; error: TaskFailure }): T {
	assert.equal(result.ok, true, JSON.stringify(result));
	return result.value;
}

function harness() {
	const supervisor = new TaskSupervisor();
	const scope: OwnerScope = { kind: "session", sessionId: randomUUID() };
	const host = supervisor.bindHostSession(scope);
	return { supervisor, owner: value(supervisor.openTaskOwner(host, scope)) };
}

async function settled(supervisor: TaskSupervisor, task: TaskLease) {
	const outcome = value(await supervisor.observeTaskWait(value(supervisor.waitForTask(task, 10000))));
	assert.equal(outcome.kind, "settled");
	return outcome;
}

async function output(supervisor: TaskSupervisor, task: TaskLease) {
	const page = value(await supervisor.readTaskOutput(task, { start: "0", maximumBytes: 1000000 }));
	return page.chunks.map((chunk) => chunk.bytes.toString("utf8")).join("");
}

async function eventuallyOutput(supervisor: TaskSupervisor, task: TaskLease, pattern: RegExp) {
	const deadline = Date.now() + 7000;
	let text: string;
	do {
		text = await output(supervisor, task);
		if (pattern.test(text)) return text;
		await sleep(10);
	} while (Date.now() < deadline);
	assert.match(text, pattern);
}

test.runIf(process.platform === "win32")(
	"Windows supervised PTY returns terminal output and confirms cleanup",
	async () => {
		const { supervisor, owner } = harness();
		try {
			const task = value(
				await supervisor.startCommandTask(
					owner,
					{
						kind: "command",
						command: "echo CONPTY_NATIVE_OK",
						terminal: { kind: "pty", columns: 80, rows: 24 },
					},
					randomUUID(),
				),
			);
			const outcome = await settled(supervisor, task);
			assert.equal(outcome.kind, "settled");
			assert.equal(outcome.result.kind, "completed");
			assert.equal(outcome.result.exitCode, 0);
			assert.match(await output(supervisor, task), /CONPTY_NATIVE_OK/);
			const receipt = value(await supervisor.closeTaskOwner(owner, "session-close"));
			assert.equal(receipt.tasks[0].cleanup.kind, "reaped");
		} finally {
			value(await supervisor.closeTaskOwner(owner, "session-close"));
		}
	},
);

test.runIf(process.platform === "win32")(
	"explicit executable receives lossless argv and a complete environment without cmd interpretation",
	async () => {
		const { supervisor, owner } = harness();
		const args = [
			"",
			"two words",
			'a"b',
			"tail\\",
			'slashes\\\\"quote',
			"tab\tline\nnext",
			"雪😀",
			"%PATH% & echo INJECTED | nope",
		];
		const command = 'final raw "command" \\ & | %COMSPEC%\nsecond line';
		const previousHostOnly = process.env.ATOMIC_NATIVE_HOST_ONLY;
		process.env.ATOMIC_NATIVE_HOST_ONLY = "must-not-inherit";
		try {
			const systemRoot = process.env.SystemRoot;
			assert.ok(systemRoot, "Node's OpenSSL initialization requires SystemRoot on Windows");
			const intent: CommandIntent = {
				kind: "command",
				command,
				shell: {
					program: process.env.ATOMIC_TEST_NODE ?? process.execPath,
					args: [fileURLToPath(new URL("../fixtures/windows-native-argv.mjs", import.meta.url)), ...args],
				},
				inheritEnv: false,
				env: { SystemRoot: systemRoot, ATOMIC_NATIVE_ONLY: "exact 雪 value" },
				terminal: { kind: "pipe" },
			};
			const op = randomUUID();
			const task = value(await supervisor.startCommandTask(owner, intent, op));
			const outcome = await settled(supervisor, task);
			assert.equal(outcome.result.kind, "completed");
			assert.equal(outcome.result.exitCode, 0, await output(supervisor, task));
			const actual: { args: string[]; env: Record<string, string | undefined> } = JSON.parse(
				await output(supervisor, task),
			);
			assert.deepEqual(actual.args, [...args, command]);
			assert.equal(actual.env.ATOMIC_NATIVE_ONLY, "exact 雪 value");
			assert.equal(actual.env.ATOMIC_NATIVE_HOST_ONLY, undefined);
			assert.equal(actual.env.PATH, undefined);
			assert.deepEqual(
				value(supervisor.taskReference(value(await supervisor.startCommandTask(owner, intent, op)))),
				value(supervisor.taskReference(task)),
			);
			assert.ok(intent.shell);
			for (const changed of [
				{ ...intent, inheritEnv: true },
				{ ...intent, shell: { ...intent.shell, args: [...intent.shell.args, ""] } },
				{ ...intent, shell: { ...intent.shell, program: "different.exe" } },
			]) {
				const replay = await supervisor.startCommandTask(owner, changed, op);
				assert.equal(replay.ok, false);
				assert.equal(replay.error.code, "OperationConflict");
			}
		} finally {
			if (previousHostOnly === undefined) delete process.env.ATOMIC_NATIVE_HOST_ONLY;
			else process.env.ATOMIC_NATIVE_HOST_ONLY = previousHostOnly;
			value(await supervisor.closeTaskOwner(owner, "session-close"));
		}
	},
);

test.runIf(process.platform === "win32")(
	"ConPTY input, resize and background observation preserve one real terminal execution",
	async () => {
		const { supervisor, owner } = harness();
		try {
			const task = value(
				await supervisor.startCommandTask(
					owner,
					{
						kind: "command",
						command: "fixture-argument",
						shell: {
							program: process.env.ATOMIC_TEST_NODE ?? process.execPath,
							args: [fileURLToPath(new URL("../fixtures/windows-native-terminal.mjs", import.meta.url))],
						},
						terminal: { kind: "pty", columns: 80, rows: 24 },
					},
					randomUUID(),
				),
			);
			await eventuallyOutput(supervisor, task, /READY:true:true:80x24/);
			const reference = value(supervisor.taskReference(task));
			const yielded = value(await supervisor.observeTaskWait(value(supervisor.waitForTask(task, 0))));
			assert.equal(yielded.kind, "yielded");
			assert.equal(yielded.reason, "elapsed");
			const input = value(supervisor.taskStdin(task));
			const op = randomUUID();
			const data: InputData = { kind: "bytes", bytes: Buffer.from("hello\r") };
			const first = value(await supervisor.writeTaskInput(input, op, data));
			assert.equal(first.acceptedBytes, 6);
			assert.deepEqual(value(await supervisor.writeTaskInput(input, op, data)), first);
			await eventuallyOutput(supervisor, task, /INPUT:hello/);
			for (const [columns, rows] of [
				[0, 24],
				[80, 0],
				[32768, 24],
				[80, 65535],
			]) {
				const invalid = supervisor.resizeTaskTerminal(task, columns, rows);
				assert.equal(invalid.ok, false, "invalid COORD must not be queued or kill the task");
			}
			value(supervisor.resizeTaskTerminal(task, 101, 37));
			await sleep(50);
			value(await supervisor.writeTaskInput(input, randomUUID(), { kind: "bytes", bytes: Buffer.from("size\r") }));
			await eventuallyOutput(supervisor, task, /SIZE:101x37/);
			value(await supervisor.writeTaskInput(input, randomUUID(), { kind: "bytes", bytes: Buffer.from("done\r") }));
			const outcome = await settled(supervisor, task);
			assert.equal(outcome.kind, "settled");
			assert.equal(outcome.result.kind, "completed");
			assert.equal(outcome.result.exitCode, 7);
			assert.match(await output(supervisor, task), /TERMINAL_DONE/);
			assert.deepEqual(value(supervisor.taskReference(task)), reference);
			assert.equal(value(await supervisor.closeTaskOwner(owner, "session-close")).tasks[0].cleanup.kind, "reaped");
		} finally {
			value(await supervisor.closeTaskOwner(owner, "session-close"));
		}
	},
);

for (const mode of ["cancel", "natural"]) {
	test.runIf(process.platform === "win32")(
		`ConPTY ${mode} leader cleanup confirms the entire owned process tree`,
		async () => {
			const { supervisor, owner } = harness();
			const directory = mkdtempSync(join(tmpdir(), "atomic-conpty-tree-"));
			const identities = join(directory, "pids.json");
			try {
				const task = value(
					await supervisor.startCommandTask(
						owner,
						{
							kind: "command",
							command: mode,
							shell: {
								program: process.env.ATOMIC_TEST_NODE ?? process.execPath,
								args: [
									fileURLToPath(new URL("../fixtures/windows-native-tree.mjs", import.meta.url)),
									identities,
								],
							},
							terminal: { kind: "pty", columns: 100, rows: 30 },
						},
						randomUUID(),
						{ background: true },
					),
				);
				await eventuallyOutput(supervisor, task, /TREE_READY/);
				const pids = await readJson<Record<string, number>>(identities);
				const observing = settled(supervisor, task);
				if (mode === "cancel") {
					for (const pid of Object.values(pids)) assert.doesNotThrow(() => process.kill(pid, 0));
					// Race cleanup against a full input credit. It must not strand a blocked writer.
					const input = value(supervisor.taskStdin(task));
					const writing = supervisor.writeTaskInput(input, randomUUID(), {
						kind: "bytes",
						bytes: Buffer.alloc(65536, 120),
					});
					const receipt = value(await supervisor.closeTaskOwner(owner, "session-close"));
					assert.equal(receipt.tasks[0].cleanup.kind, "reaped");
					const write = await writing;
					assert.ok(
						write.ok || ["InputDeliveryUnknown", "TaskTerminal"].includes(write.error.code),
						JSON.stringify(write),
					);
				}
				const outcome = await observing;
				assert.equal(outcome.kind, "settled");
				assert.equal(outcome.result.kind, mode === "cancel" ? "cancelled" : "completed");
				if (mode === "natural") {
					assert.equal(outcome.result.kind, "completed");
					assert.equal(outcome.result.exitCode, 0);
				}
				for (const pid of Object.values(pids)) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
				assert.equal(
					value(await supervisor.closeTaskOwner(owner, "session-close")).tasks[0].cleanup.kind,
					"reaped",
				);
			} finally {
				value(await supervisor.closeTaskOwner(owner, "session-close"));
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
}

test.runIf(process.platform === "win32")(
	"ConPTY drains saturated output through ClosePseudoConsole and preserves its bounded tail",
	async () => {
		const { supervisor, owner } = harness();
		try {
			const task = value(
				await supervisor.startCommandTask(
					owner,
					{
						kind: "command",
						command:
							'process.stdout.write(("X".repeat(199)+"\\r\\n").repeat(2000)+"FINAL_CONPTY_FRAME\\r\\n", () => process.exit(0))',
						shell: { program: process.env.ATOMIC_TEST_NODE ?? process.execPath, args: ["-e"] },
						terminal: { kind: "pty", columns: 200, rows: 60 },
					},
					randomUUID(),
					{ background: true, diskCapBytes: 32768, livePreviewBytes: 16384 },
				),
			);
			const outcome = await settled(supervisor, task);
			assert.equal(outcome.kind, "settled");
			assert.equal(outcome.result.kind, "completed");
			assert.equal(outcome.result.exitCode, 0);
			const count = Number(outcome.result.output.byteCount);
			assert.ok(count > 65536, `fixture must saturate the 64KiB channel: ${count}`);
			assert.ok(outcome.result.output.omittedRanges.length > 0);
			const page = value(await supervisor.readTaskOutput(task, { start: String(count - 8192), maximumBytes: 8192 }));
			assert.match(page.chunks.map((chunk) => chunk.bytes.toString("utf8")).join(""), /FINAL_CONPTY_FRAME/);
			assert.equal(value(await supervisor.closeTaskOwner(owner, "session-close")).tasks[0].cleanup.kind, "reaped");
		} finally {
			value(await supervisor.closeTaskOwner(owner, "session-close"));
		}
	},
);
