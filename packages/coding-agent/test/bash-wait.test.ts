import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { TaskId, WaitId, WaitPolicy } from "../src/core/tasks/contracts.js";
import { TaskSupervisor } from "../src/core/tasks/supervisor.js";
import { createBashToolDefinition, createLocalBashOperations } from "../src/core/tools/bash.ts";
import { executeNativePty } from "../src/core/tools/bash-pty-native.js";

test("bash exposes a provider-friendly wait object and forwards observation independently of timeout", async () => {
	const observed: Array<WaitPolicy | undefined> = [];
	const tool = createBashToolDefinition(process.cwd(), {
		operations: {
			exec: async (_command, _cwd, options) => {
				observed.push(options.wait);
				assert.equal(options.timeout, 300);
				return { exitCode: 0 };
			},
		},
	});
	const schema = JSON.parse(JSON.stringify(tool.parameters));
	assert.equal(schema.properties.wait.type, "object");
	assert.deepEqual(schema.properties.wait.properties.kind.enum, ["background", "foreground"]);
	for (const wait of [undefined, { kind: "background" }, { kind: "foreground", budgetMs: 0 }] satisfies Array<
		WaitPolicy | undefined
	>) {
		await tool.execute("wait", { command: "true", wait }, undefined, undefined, {} as never);
	}
	assert.deepEqual(observed, [undefined, { kind: "background" }, { kind: "foreground", budgetMs: 0 }]);
});

test("malformed wait is rejected before hooks or operations", async () => {
	let launched = false;
	const tool = createBashToolDefinition(process.cwd(), {
		spawnHook: (context) => {
			launched = true;
			return context;
		},
		operations: {
			exec: async () => {
				launched = true;
				return { exitCode: 0 };
			},
		},
	});
	for (const wait of [
		null,
		{},
		{ kind: "ignore" },
		{ kind: "background", budgetMs: 1 },
		{ kind: "foreground", budgetMs: -1 },
		{ kind: "foreground", budgetMs: Infinity },
		{ kind: "foreground", budgetMs: "1" },
		{ kind: "foreground", ignore: true },
	]) {
		await assert.rejects(
			tool.execute("invalid", { command: "true", wait: wait as WaitPolicy }, undefined, undefined, {} as never),
			/Invalid bash wait/,
		);
	}
	assert.equal(launched, false);
});

test("unbound background refuses before shell resolution or spawn, including PTY", async () => {
	for (const pty of [false, true]) {
		await assert.rejects(
			createLocalBashOperations({ shellPath: "/nonexistent-shell" }).exec("true", process.cwd(), {
				pty,
				wait: { kind: "background" },
				onData() {},
			}),
			/supported task owner/,
		);
	}
	await assert.rejects(
		executeNativePty("true", process.cwd(), { wait: { kind: "background" }, onData() {} }),
		/supported task owner/,
	);
	let hooked = false;
	const tool = createBashToolDefinition(process.cwd(), {
		spawnHook: (context) => {
			hooked = true;
			return context;
		},
	});
	await assert.rejects(
		tool.execute("unbound", { command: "true", wait: { kind: "background" } }, undefined, undefined, {} as never),
		/supported task owner/,
	);
	assert.equal(hooked, false);
});

test.runIf(process.platform !== "win32")(
	"bound bash forwards explicit waits and preserves owner defaults",
	async () => {
		const supervisor = new TaskSupervisor();
		const scope = { kind: "session" as const, sessionId: crypto.randomUUID() };
		const host = supervisor.bindHostSession({
			scope,
			tasks: { wait: { kind: "automatic", commandBudgetMs: 0 } },
			authorizeLaunch() {},
			createRunner() {
				throw new Error("not an agent");
			},
		});
		const opened = supervisor.openTaskOwner(host, scope);
		assert.ok(opened.ok);
		const owner = opened.value;
		const observation = vi.spyOn(supervisor, "initialObservation");
		try {
			for (const wait of [undefined, { kind: "background" }, { kind: "foreground", budgetMs: 0 }] satisfies Array<
				WaitPolicy | undefined
			>) {
				const result = await createLocalBashOperations({ taskOwner: { supervisor, owner } }).exec(
					"sleep 30",
					process.cwd(),
					{ wait, timeout: 60, onData() {} },
				);
				assert.equal(result.observation?.kind, "yielded");
				assert.deepEqual(observation.mock.lastCall?.[1], wait);
			}
		} finally {
			observation.mockRestore();
			assert.ok((await supervisor.closeTaskOwner(owner, "session-close")).ok);
		}
	},
);

test("a backgrounded command's receipt names the default execution timeout that will stop it (#4639)", async () => {
	const tool = createBashToolDefinition(process.cwd(), {
		operations: {
			exec: async () => ({
				exitCode: null,
				observation: {
					kind: "yielded",
					taskId: "task-9" as TaskId,
					waitId: "wait-9" as WaitId,
					reason: "explicit",
				},
			}),
		},
	});
	const result = await tool.execute(
		"launch",
		{ command: "npm test", wait: { kind: "background" } },
		undefined,
		undefined,
		{} as never,
	);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	assert.equal(
		text,
		"(no output)\n\nCommand is still running (task task-9). Its execution timeout stops it after 300 seconds; launch it with a larger timeout (up to 3600 seconds) for a longer run.",
	);
});

test("a backgrounded command at the longest timeout is told to split its run, not to ask for a larger timeout (#4639)", async () => {
	const tool = createBashToolDefinition(process.cwd(), {
		operations: {
			exec: async () => ({
				exitCode: null,
				observation: {
					kind: "yielded",
					taskId: "task-9" as TaskId,
					waitId: "wait-9" as WaitId,
					reason: "explicit",
				},
			}),
		},
	});
	const result = await tool.execute(
		"launch",
		{ command: "npm test", timeout: 3600, wait: { kind: "background" } },
		undefined,
		undefined,
		{} as never,
	);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	assert.equal(
		text,
		"(no output)\n\nCommand is still running (task task-9). Its execution timeout stops it after 3600 seconds; 3600 seconds is the longest timeout; split a longer run into shorter commands.",
	);
});
