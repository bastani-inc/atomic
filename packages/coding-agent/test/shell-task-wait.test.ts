import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { Value } from "typebox/value";
import { test, vi } from "vitest";
import type { AgentTaskHostBinding } from "../src/core/tasks/agent-adapter.js";
import { AgentTaskHost } from "../src/core/tasks/agent-adapter.js";
import type { OperationId, TaskId, WaitOutcome } from "../src/core/tasks/contracts.js";
import { createBashToolDefinition } from "../src/core/tools/bash.js";
import { executeSupervisedCommand } from "../src/core/tools/bash-pty-native.js";
import { createPowerShellToolDefinition } from "../src/core/tools/powershell.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function host(
	wait: NonNullable<NonNullable<AgentTaskHostBinding["tasks"]>["wait"]> = { kind: "automatic", commandBudgetMs: 0 },
) {
	return new AgentTaskHost({
		scope: { kind: "session", sessionId: crypto.randomUUID() },
		tasks: { wait },
		authorizeLaunch() {},
	});
}

function acceptsShellInput(tool: ReturnType<typeof createBashToolDefinition>, input: object): boolean {
	try {
		return Value.Check(tool.parameters, tool.prepareArguments?.(input) ?? input);
	} catch {
		return false;
	}
}

async function release(owner: AgentTaskHost, id: TaskId) {
	const task = owner.resolveTask(id);
	assert.ok(task.ok);
	const input = owner.ownerBinding.supervisor.taskStdin(task.value);
	assert.ok(input.ok);
	assert.ok(
		(
			await owner.ownerBinding.supervisor.writeTaskInput(input.value, crypto.randomUUID() as OperationId, {
				kind: "bytes",
				bytes: Buffer.from("ready\n"),
			})
		).ok,
	);
}

async function launch(owner: AgentTaskHost, command = "read value; printf 'hello'; exit 7", timeout = 10) {
	const result = await createBashToolDefinition(process.cwd(), { taskOwner: owner.ownerBinding }).execute("launch", {
		command,
		timeout,
		wait: { kind: "background" },
	});
	assert.equal(result.details?.observation?.kind, "yielded");
	return result.details!.observation!.taskId;
}

for (const factory of [createBashToolDefinition, createPowerShellToolDefinition]) {
	test.runIf(process.platform !== "win32")(
		`${factory.name} preserves trusted terminal failure identity and absent exit metadata`,
		async () => {
			const owner = host();
			try {
				const id = await launch(owner);
				const observation: WaitOutcome = {
					kind: "settled",
					taskId: id,
					result: { kind: "failed", code: "RunnerFailed", message: " raw failure\n" },
				};
				const tool = factory(process.cwd(), {
					taskOwner: {
						...owner.ownerBinding,
						waitForTask: async (taskId, budgetMs) => {
							assert.equal(taskId, id);
							assert.equal(budgetMs, 0);
							return { ok: true, value: observation };
						},
					},
				});
				const result = await tool.execute("wait", { action: "wait", id, budgetMs: 0 });
				assert.equal(result.details?.observation, observation);
				assert.equal(Object.hasOwn(result.details!, "exitCode"), false);
				assert.match(result.content[0].text, /RunnerFailed/);
			} finally {
				await owner.close("session-close");
			}
		},
	);
	test(`${factory.name} renders an existing-task wait rather than an empty command`, () => {
		initTheme("dark");
		const tool = factory(process.cwd());
		const rendered = tool
			.renderCall?.({ action: "wait", id: "task-123" }, {} as never, { state: {}, executionStarted: false } as never)
			.render(100)
			.join("\n");
		assert.match(stripVTControlCharacters(rendered ?? ""), /wait task-123/);
	});
	test(`${factory.name} rejects unbound existing-task waits without execution`, async () => {
		let executed = false;
		const tool = factory(process.cwd(), {
			operations: {
				exec: async () => {
					executed = true;
					return { exitCode: 0 };
				},
			},
		});
		await assert.rejects(
			tool.execute("wait", { action: "wait", id: "missing", budgetMs: 0 } as never),
			/supported task owner/,
		);
		assert.equal(executed, false);
	});
	test(`${factory.name} schema and dispatch reject invalid or mixed inputs before hooks`, async () => {
		const tool = factory(process.cwd(), {
			spawnHook() {
				throw new Error("hook reached");
			},
		});
		for (const input of [
			{},
			{ action: "other", id: "x" },
			{ action: "wait" },
			{ action: "wait", id: 1 },
			{ id: "x" },
			{ command: "true", budgetMs: 0 },
			...["command", "timeout", "wait", "env", "cwd", "pty"].map((key) => ({
				action: "wait",
				id: "x",
				[key]: key === "command" ? "true" : 1,
			})),
			...[-1, Infinity, NaN, "1", null].map((budgetMs) => ({ action: "wait", id: "x", budgetMs })),
		]) {
			assert.equal(acceptsShellInput(tool, input), false, JSON.stringify(input));
			await assert.rejects(tool.execute("invalid", input as never), /Invalid/);
		}
		for (const input of [
			{ command: "" },
			{ action: "wait", id: "" },
			{ action: "wait", id: " verbatim ", budgetMs: 0 },
			{ action: "wait", id: "x", budgetMs: 1 },
		])
			assert.equal(acceptsShellInput(tool, input), true, JSON.stringify(input));
	});
	test.runIf(process.platform !== "win32")(
		`${factory.name} observes one real task across yields and retains terminal output and exit metadata`,
		async () => {
			const owner = host();
			try {
				const id = await launch(owner);
				const tool = factory("/nonexistent-cwd", {
					taskOwner: owner.ownerBinding,
					spawnHook() {
						throw new Error("must not launch");
					},
					operations: {
						exec() {
							throw new Error("must not execute");
						},
					},
				});
				for (const budgetMs of [0, 1, undefined]) {
					const result = await tool.execute("wait", { action: "wait", id, budgetMs });
					assert.equal(result.details?.observation?.taskId, id);
					assert.equal(result.details?.observation?.kind, "yielded");
				}
				await release(owner, id);
				const result = await tool.execute("wait", { action: "wait", id, budgetMs: 5000 });
				assert.equal(result.details?.observation?.kind, "settled");
				assert.equal(result.details?.exitCode, 7);
				assert.match(result.content[0].text, /hello/);
				const again = await tool.execute("wait", { action: "wait", id, budgetMs: 0 });
				assert.deepEqual(again.details?.observation, result.details?.observation);
			} finally {
				await owner.close("session-close");
			}
		},
	);
	test.runIf(process.platform !== "win32")(
		`${factory.name} cancellation and messages release only observation`,
		async () => {
			const owner = host({ kind: "until-settled" });
			try {
				const id = await launch(owner, "read value; printf survived");
				const tool = factory(process.cwd(), { taskOwner: owner.ownerBinding });
				const controller = new AbortController();
				const waiting = tool.execute("wait", { action: "wait", id }, controller.signal);
				controller.abort();
				await assert.rejects(waiting, /aborted/);
				await assert.rejects(tool.execute("wait", { action: "wait", id }, controller.signal), /aborted/);
				const messageWait = tool.execute("wait", { action: "wait", id });
				owner.yieldTaskWaits("input-needed");
				assert.equal((await messageWait).details?.observation?.kind, "yielded");
				await release(owner, id);
				const result = await tool.execute("wait", { action: "wait", id });
				assert.equal(result.details?.observation?.kind, "settled");
				assert.match(result.content[0].text, /survived/);
			} finally {
				await owner.close("session-close");
			}
		},
	);
	test.runIf(process.platform !== "win32")(
		`${factory.name} rejects unknown and foreign IDs and preserves execution deadline`,
		async () => {
			const owner = host();
			const foreign = host();
			try {
				const id = await launch(owner, "sleep 30", 0.1);
				for (const taskOwner of [owner.ownerBinding, foreign.ownerBinding]) {
					const tool = factory(process.cwd(), { taskOwner });
					await assert.rejects(tool.execute("wait", { action: "wait", id: " missing " }), /UnknownTask/);
					if (taskOwner.owner !== owner.ownerBinding.owner)
						await assert.rejects(tool.execute("wait", { action: "wait", id }), /UnknownTask|ScopeMismatch/);
				}
				const tool = factory(process.cwd(), { taskOwner: owner.ownerBinding });
				const result = await tool.execute("wait", { action: "wait", id, budgetMs: 5000 });
				assert.equal(result.details?.observation?.kind, "settled");
				if (result.details?.observation?.kind === "settled") {
					assert.equal(result.details.observation.result.kind, "cancelled");
					if (result.details.observation.result.kind === "cancelled")
						assert.equal(result.details.observation.result.cause, "execution-timeout");
				}
			} finally {
				await owner.close("session-close");
				await foreign.close("session-close");
			}
		},
	);
	test.runIf(process.platform !== "win32")(
		`${factory.name} reports a background command's execution timeout as an error to the wait that sees it (#4639)`,
		async () => {
			const owner = host();
			try {
				const id = await launch(owner, "sleep 30", 1);
				const tool = factory(process.cwd(), { taskOwner: owner.ownerBinding });
				const result = await tool.execute("wait", { action: "wait", id, budgetMs: 10_000 });
				assert.equal(result.isError, true);
				const text = result.content[0].text;
				assert.ok(text.endsWith(`Task ${id} was cancelled (timed out after 1 second).`), text);
			} finally {
				await owner.close("session-close");
			}
		},
	);
	test.runIf(process.platform !== "win32")(
		`${factory.name} a wait on a command that exits non-zero stays a plain result`,
		async () => {
			const owner = host();
			try {
				const id = await launch(owner);
				await release(owner, id);
				const tool = factory(process.cwd(), { taskOwner: owner.ownerBinding });
				const result = await tool.execute("wait", { action: "wait", id, budgetMs: 10_000 });
				assert.equal(result.details?.exitCode, 7);
				assert.equal(result.isError, undefined);
			} finally {
				await owner.close("session-close");
			}
		},
	);
	test.runIf(process.platform !== "win32")(
		`${factory.name} owner closure does not wait for observation budget`,
		async () => {
			const owner = host({ kind: "until-settled" });
			const id = await launch(owner, "read value");
			const tool = factory(process.cwd(), { taskOwner: owner.ownerBinding });
			const waiting = tool.execute("wait", { action: "wait", id, budgetMs: 60000 });
			// Attach rejection handling before closure can dispose the native wait.
			const outcome = waiting.then(
				(result) => result.details?.observation,
				(error: Error) => error,
			);
			assert.ok((await owner.close("session-close")).ok);
			const result = await outcome;
			if (result instanceof Error) assert.match(result.message, /OwnerClosed|ObserverCancelled/);
			else {
				assert.equal(result?.kind, "settled");
				if (result?.kind === "settled") assert.equal(result.result.kind, "cancelled");
			}
			await assert.rejects(tool.execute("wait", { action: "wait", id }), /OwnerClosed/);
		},
	);
	// PR #2972: retained offsets count bytes, including split UTF-8 and control bytes.
	test.runIf(process.platform !== "win32")(
		`${factory.name} preserves UTF-8 and raw spill bytes across yielded output pages`,
		async () => {
			const owner = host();
			try {
				const id = await launch(
					owner,
					"read value; printf '\\377\\000'; printf 'a\\n%.0s' {1..4094}; printf 'a\\342\\202\\254\\033[31mred\\033[0m\\n'; read value",
				);
				await release(owner, id);
				const task = owner.resolveTask(id);
				assert.ok(task.ok);
				await vi.waitFor(
					async () => {
						const page = await owner.ownerBinding.supervisor.readTaskOutput(task.value, {
							start: "8191",
							maximumBytes: 32,
						});
						assert.ok(page.ok);
						assert.equal(
							Buffer.concat(page.value.chunks.map((chunk) => Buffer.from(chunk.bytes))).toString(),
							"€\x1b[31mred\x1b[0m\n",
						);
					},
					{ timeout: 5000 },
				);
				const first = await factory(process.cwd(), { taskOwner: owner.ownerBinding }).execute("first", {
					action: "wait",
					id,
					budgetMs: 0,
				});
				assert.equal(first.details?.observation?.kind, "yielded");
				assert.ok(first.details?.truncation?.truncated);
				assert.ok(first.details.fullOutputPath);
				assert.deepEqual(
					readFileSync(first.details.fullOutputPath),
					Buffer.concat([
						Buffer.from([255, 0]),
						Buffer.from(
							`${"a\n".repeat(4094)}a\n[Additional output not shown; wait again to retrieve retained output.]\n`,
						),
					]),
				);
				const second = await factory(process.cwd(), { taskOwner: owner.ownerBinding }).execute("next", {
					action: "wait",
					id,
					budgetMs: 0,
				});
				assert.equal(second.details?.observation?.kind, "yielded");
				assert.ok(second.content[0].text.startsWith("€\x1b[31mred\x1b[0m\n\n\n"));
			} finally {
				await owner.close("session-close");
			}
		},
	);
	test.runIf(process.platform !== "win32")(
		`${factory.name} SDK binding fallback retains large terminal output and omissions`,
		async () => {
			const owner = host();
			try {
				const id = await launch(owner, "read value; printf '%100000s' x; printf '\\nretained-end\\n'");
				const { supervisor, owner: lease } = owner.ownerBinding;
				const tool = factory(process.cwd(), { taskOwner: { supervisor, owner: lease } });
				await release(owner, id);
				const result = await tool.execute("wait", { action: "wait", id, budgetMs: 5000 });
				assert.equal(result.details?.observation?.kind, "settled");
				assert.match(result.content[0].text, /retained-end/);
				assert.ok(result.content[0].text.includes("Output omitted") || result.details?.truncation?.truncated);
			} finally {
				await owner.close("session-close");
			}
		},
	);
}

test.runIf(process.platform !== "win32")(
	"a background command's receipt names the execution timeout that will stop it (#4639)",
	async () => {
		const owner = host();
		try {
			const tool = createBashToolDefinition(process.cwd(), { taskOwner: owner.ownerBinding });
			const result = await tool.execute("launch", {
				command: "read value",
				timeout: 2,
				wait: { kind: "background" },
			});
			const id = result.details?.observation?.taskId;
			assert.ok(id);
			const text = result.content[0].text;
			assert.ok(
				text.endsWith(
					`Command is still running (task ${id}). Its execution timeout stops it after 2 seconds; launch it with a larger timeout (up to 3600 seconds) for a longer run.`,
				),
				text,
			);
		} finally {
			await owner.close("session-close");
		}
	},
);

test.runIf(process.platform === "win32" || !!process.env.ATOMIC_TEST_PWSH)(
	"real PowerShell task can yield and be waited without restarting",
	async () => {
		const owner = host();
		try {
			const taskOwner = owner.ownerBinding;
			// POSIX PowerShell is a test-only adapter: the shipped local factory remains Windows-only.
			const operations =
				process.platform === "win32"
					? undefined
					: {
							exec: (command: string, cwd: string, options: Parameters<typeof executeSupervisedCommand>[2]) =>
								executeSupervisedCommand(
									Buffer.from(command, "utf16le").toString("base64"),
									cwd,
									{
										...options,
										taskOwner,
										shellConfig: {
											shell: process.env.ATOMIC_TEST_PWSH!,
											args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"],
										},
									},
									false,
								),
						};
			const tool = createPowerShellToolDefinition(process.cwd(), { taskOwner, operations });
			const started = await tool.execute("launch", {
				command: "$value = [Console]::ReadLine(); Write-Output 'héllo €'; exit 7",
				wait: { kind: "background" },
				timeout: 20,
			});
			assert.equal(started.details?.observation?.kind, "yielded");
			const id = started.details!.observation!.taskId;
			assert.equal(
				(await tool.execute("wait", { action: "wait", id, budgetMs: 0 })).details?.observation?.taskId,
				id,
			);
			await release(owner, id);
			const result = await tool.execute("wait", { action: "wait", id, budgetMs: 10000 });
			assert.equal(result.details?.observation?.kind, "settled");
			assert.equal(result.details?.exitCode, 7);
			assert.match(result.content[0].text, /héllo €/);
		} finally {
			await owner.close("session-close");
		}
	},
);
