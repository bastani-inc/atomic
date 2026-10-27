import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, test, vi } from "vitest";
import { AgentTaskHost } from "../src/core/tasks/agent-adapter.js";
import type { CancelReceipt, OperationId, TaskId, WaitOutcome } from "../src/core/tasks/contracts.js";
import type { BashToolDetails } from "../src/core/tools/bash.js";
import { createBashToolDefinition } from "../src/core/tools/bash.js";
import { createKillToolDefinition } from "../src/core/tools/kill.js";
import { createPowerShellToolDefinition } from "../src/core/tools/powershell.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

const WIDTH = 120;
const FORBIDDEN_IN_UI = /"kind"|ownerId|artifactId|byteCount|omittedRanges|waitId|UnknownTask: UnknownTask/;

type ShellDefinition = ReturnType<typeof createBashToolDefinition>;
type ShellResult = Awaited<ReturnType<ShellDefinition["execute"]>>;
type RenderResult = { content: { type: "text"; text: string }[]; details?: unknown };
type Renderer = {
	renderCall?: (args: never, theme: never, context: never) => Component;
	renderResult?: (result: never, options: never, theme: never, context: never) => Component;
};

function host() {
	return new AgentTaskHost({
		scope: { kind: "session", sessionId: crypto.randomUUID() },
		tasks: { wait: { kind: "automatic", commandBudgetMs: 0 } },
		authorizeLaunch() {},
	});
}

async function launch(owner: AgentTaskHost, command: string): Promise<TaskId> {
	const result = await createBashToolDefinition(process.cwd(), { taskOwner: owner.ownerBinding }).execute("launch", {
		command,
		timeout: 30,
		wait: { kind: "background" },
	});
	assert.equal(result.details?.observation?.kind, "yielded");
	return result.details!.observation!.taskId;
}

async function outputContains(owner: AgentTaskHost, id: TaskId, text: string) {
	const task = owner.resolveTask(id);
	assert.ok(task.ok);
	await vi.waitFor(
		async () => {
			const page = await owner.ownerBinding.supervisor.readTaskOutput(task.value, {
				start: "0",
				maximumBytes: 8192,
			});
			assert.ok(page.ok);
			assert.ok(
				Buffer.concat(page.value.chunks.map((chunk) => Buffer.from(chunk.bytes)))
					.toString()
					.includes(text),
			);
		},
		{ timeout: 5000 },
	);
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

/** What the agent loop does with a tool that throws: the message becomes the result text. */
async function settleLikeAgentLoop(
	run: () => Promise<ShellResult>,
): Promise<{ result: RenderResult; isError: boolean }> {
	try {
		const result = await run();
		return { result: result as RenderResult, isError: (result as { isError?: boolean }).isError === true };
	} catch (error) {
		return { result: { content: [{ type: "text", text: (error as Error).message }], details: {} }, isError: true };
	}
}

function row(
	definition: Renderer,
	args: object,
	{ result, isError }: { result: RenderResult; isError: boolean },
	options: { expanded?: boolean; width?: number; raw?: boolean } = {},
): string[] {
	const width = options.width ?? WIDTH;
	const context = {
		args,
		toolCallId: "tool-call",
		invalidate() {},
		lastComponent: undefined,
		state: {},
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: options.expanded ?? false,
		showImages: false,
		isError,
		durationMs: 200,
	} as never;
	const lines = [
		...definition.renderCall!(args as never, theme as never, context).render(width),
		...definition.renderResult!(
			result as never,
			{ expanded: options.expanded ?? false, isPartial: false } as never,
			theme as never,
			context,
		).render(width),
	];
	return options.raw ? lines : lines.map((line) => stripVTControlCharacters(line).trimEnd());
}

const waitText = (result: ShellResult) =>
	result.content.map((part) => (part.type === "text" ? part.text : "")).join("");

describe("shell task results are friendly (#3828)", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => vi.unstubAllEnvs());

	for (const factory of [createBashToolDefinition, createPowerShellToolDefinition]) {
		const prompt = factory === createBashToolDefinition ? "$" : "PS>";
		test.runIf(process.platform !== "win32")(
			`${factory.name} renders a completed wait as a status line above its output (#3828)`,
			async () => {
				const owner = host();
				try {
					const id = await launch(owner, "printf 'hello\\n'");
					const tool = factory(process.cwd(), { taskOwner: owner.ownerBinding });
					const args = { action: "wait", id, budgetMs: 5000 } as const;
					const outcome = await settleLikeAgentLoop(() => tool.execute("wait", args));
					assert.equal(outcome.isError, false);
					const text = waitText(outcome.result as ShellResult);
					assert.equal(text, `hello\n\n\nTask ${id} completed with exit code 0.`);
					assert.equal((outcome.result.details as BashToolDetails).exitCode, 0);
					assert.equal((outcome.result.details as BashToolDetails).observation?.kind, "settled");
					const lines = row(tool, args, outcome);
					assert.deepEqual(lines, [`${prompt} wait ${id}`, "✓ completed · exit 0", "", "hello", "", "Took 0.2s"]);
					for (const line of lines) assert.doesNotMatch(line, FORBIDDEN_IN_UI);
				} finally {
					await owner.close("session-close");
				}
			},
		);

		test.runIf(process.platform !== "win32")(
			`${factory.name} renders a nonzero exit as a failure (#3828)`,
			async () => {
				const owner = host();
				try {
					const id = await launch(owner, "printf 'FAIL src/parser.test.ts\\n'; exit 1");
					const tool = factory(process.cwd(), { taskOwner: owner.ownerBinding });
					const args = { action: "wait", id, budgetMs: 5000 } as const;
					const outcome = await settleLikeAgentLoop(() => tool.execute("wait", args));
					assert.equal(
						waitText(outcome.result as ShellResult),
						`FAIL src/parser.test.ts\n\n\nTask ${id} exited with code 1.`,
					);
					assert.deepEqual(row(tool, args, outcome), [
						`${prompt} wait ${id}`,
						"✗ exited 1",
						"",
						"FAIL src/parser.test.ts",
						"",
						"Took 0.2s",
					]);
				} finally {
					await owner.close("session-close");
				}
			},
		);

		test.runIf(process.platform !== "win32")(
			`${factory.name} renders a still-running wait with its output so far (#3828)`,
			async () => {
				const owner = host();
				try {
					const id = await launch(owner, "printf 'compiling\\n'; read value");
					await outputContains(owner, id, "compiling");
					const tool = factory(process.cwd(), { taskOwner: owner.ownerBinding });
					const args = { action: "wait", id, budgetMs: 0 } as const;
					const outcome = await settleLikeAgentLoop(() => tool.execute("wait", args));
					assert.equal(
						waitText(outcome.result as ShellResult),
						`compiling\n\n\nTask ${id} is still running (yielded: elapsed).`,
					);
					assert.equal((outcome.result.details as BashToolDetails).observation?.kind, "yielded");
					assert.deepEqual(row(tool, args, outcome), [
						`${prompt} wait ${id}`,
						"● still running · showing output so far",
						"",
						"compiling",
						"",
						"Observed for 0.2s",
					]);
					await release(owner, id);
				} finally {
					await owner.close("session-close");
				}
			},
		);

		test.runIf(process.platform !== "win32")(`${factory.name} renders a cancelled task (#3828)`, async () => {
			const owner = host();
			try {
				const id = await launch(owner, "printf 'started\\n'; read value");
				await outputContains(owner, id, "started");
				const kill = createKillToolDefinition({ taskOwner: () => owner.ownerBinding });
				await kill.execute("stop", { id });
				const tool = factory(process.cwd(), { taskOwner: owner.ownerBinding });
				const args = { action: "wait", id, budgetMs: 5000 } as const;
				const outcome = await settleLikeAgentLoop(() => tool.execute("wait", args));
				assert.equal(
					waitText(outcome.result as ShellResult),
					`started\n\n\nTask ${id} was cancelled (stop requested).`,
				);
				assert.deepEqual(row(tool, args, outcome), [
					`${prompt} wait ${id}`,
					"○ cancelled",
					"",
					"started",
					"",
					"Took 0.2s",
				]);
			} finally {
				await owner.close("session-close");
			}
		});

		test.runIf(process.platform !== "win32")(
			`${factory.name} explains an unknown task id and keeps its error code (#3828)`,
			async () => {
				const owner = host();
				try {
					const tool = factory(process.cwd(), { taskOwner: owner.ownerBinding });
					const args = { action: "wait", id: "task-1-0-1010" } as const;
					const error = await tool.execute("wait", args).then(
						() => undefined,
						(reason: Error & { code?: string; taskId?: string }) => reason,
					);
					assert.ok(error, "an unknown task id must still be rejected");
					assert.equal(error.code, "UnknownTask");
					assert.equal(error.taskId, "task-1-0-1010");
					assert.equal(error.message, 'UnknownTask: No background task "task-1-0-1010" in this session');
					const outcome = await settleLikeAgentLoop(() => tool.execute("wait", args));
					assert.deepEqual(row(tool, args, outcome), [
						`${prompt} wait task-1-0-1010`,
						'✗ No background task "task-1-0-1010" in this session',
						"It may have finished and been cleaned up, or belong to another session. Run /tasks to see current tasks.",
						"",
						"Took 0.2s",
					]);
				} finally {
					await owner.close("session-close");
				}
			},
		);

		test.runIf(process.platform !== "win32")(
			`${factory.name} renders a failed task with its reason and no raw envelope (#3828)`,
			async () => {
				const owner = host();
				try {
					const id = await launch(owner, "printf 'x\\n'; read value");
					const observation: WaitOutcome = {
						kind: "settled",
						taskId: id,
						result: { kind: "failed", code: "SpawnFailed", message: " could not execute shell\nstack line " },
					};
					const tool = factory(process.cwd(), {
						taskOwner: { ...owner.ownerBinding, waitForTask: async () => ({ ok: true, value: observation }) },
					});
					const args = { action: "wait", id, budgetMs: 0 } as const;
					const outcome = await settleLikeAgentLoop(() => tool.execute("wait", args));
					assert.match(
						waitText(outcome.result as ShellResult),
						new RegExp(`\\n\\nTask ${id} failed \\(SpawnFailed\\): could not execute shell\\.$`),
					);
					assert.equal((outcome.result.details as BashToolDetails).observation, observation);
					const lines = row(tool, args, outcome);
					assert.equal(lines[1], "✗ failed · could not execute shell");
					for (const line of lines) assert.doesNotMatch(line, FORBIDDEN_IN_UI);
					await release(owner, id);
				} finally {
					await owner.close("session-close");
				}
			},
		);
	}

	test.runIf(process.platform !== "win32")(
		"a wait with no output dims (no output) under the status line (#3828)",
		async () => {
			const owner = host();
			try {
				const id = await launch(owner, "exit 0");
				const tool = createBashToolDefinition(process.cwd(), { taskOwner: owner.ownerBinding });
				const args = { action: "wait", id, budgetMs: 5000 } as const;
				const outcome = await settleLikeAgentLoop(() => tool.execute("wait", args));
				assert.equal(
					waitText(outcome.result as ShellResult),
					`(no output)\n\nTask ${id} completed with exit code 0.`,
				);
				const plain = row(tool, args, outcome);
				assert.deepEqual(plain, [`$ wait ${id}`, "✓ completed · exit 0", "(no output)", "", "Took 0.2s"]);
				const raw = row(tool, args, outcome, { raw: true });
				assert.ok(raw.some((line) => line.includes(theme.fg("dim", "(no output)"))));
			} finally {
				await owner.close("session-close");
			}
		},
	);

	test.runIf(process.platform !== "win32")(
		"a truncated wait keeps the full-output path intact on its own dim line, however long the temp path (#3828)",
		async () => {
			// A long temp directory with spaces (a deep TMPDIR, C:\Users\Jane Doe\AppData\Local\Temp) must not split the path mid-way.
			const longTemp = mkdtempSync(join(tmpdir(), "long temp directory with spaces ".repeat(3)));
			vi.stubEnv("TMPDIR", longTemp);
			const owner = host();
			try {
				const id = await launch(owner, "seq 1 5000");
				const tool = createBashToolDefinition(process.cwd(), { taskOwner: owner.ownerBinding });
				const args = { action: "wait", id, budgetMs: 5000 } as const;
				const outcome = await settleLikeAgentLoop(() => tool.execute("wait", args));
				const details = outcome.result.details as BashToolDetails;
				assert.ok(details.truncation?.truncated);
				const fullOutputPath = details.fullOutputPath;
				assert.ok(fullOutputPath?.startsWith(longTemp), fullOutputPath);
				const text = waitText(outcome.result as ShellResult);
				assert.ok(
					text.endsWith(
						`\n[Output truncated.]\n\nTask ${id} completed with exit code 0.\nFull output: ${fullOutputPath}`,
					),
					text.slice(-300),
				);
				// Wide enough for the path alone, too narrow for the path beside its label.
				const width = fullOutputPath.length + 2;
				const plain = row(tool, args, outcome, { width });
				assert.equal(plain[1], "✓ completed · exit 0");
				assert.ok(plain.some((line) => line.includes("earlier lines")));
				const truncation = plain.findIndex((line) => line.startsWith("Truncated:"));
				assert.ok(truncation !== -1, plain.join("\n"));
				assert.match(plain[truncation]!, /^Truncated: showing \d+ of 5000 lines · Full output:$/);
				assert.equal(plain[truncation + 1], fullOutputPath, plain.join("\n"));
				const raw = row(tool, args, outcome, { width, raw: true });
				assert.ok(raw[truncation]!.includes(theme.fg("dim", plain[truncation]!)));
				assert.ok(raw[truncation + 1]!.startsWith(theme.getFgAnsi("dim")), JSON.stringify(raw[truncation + 1]));
				assert.doesNotMatch(plain.join("\n"), /\[Full output|\[Output truncated/);
				const expanded = row(tool, args, outcome, { expanded: true });
				assert.equal(expanded[1], "✓ completed · exit 0");
				assert.ok(!expanded.some((line) => line.includes("earlier lines")));
				assert.ok(expanded.includes("3500"));
			} finally {
				await owner.close("session-close");
				rmSync(longTemp, { recursive: true, force: true });
			}
		},
	);

	test.runIf(process.platform !== "win32")(
		"status colors follow the role of the state and NO_COLOR keeps them readable (#3828)",
		async () => {
			const owner = host();
			try {
				const ok = await launch(owner, "printf 'ok\\n'");
				const bad = await launch(owner, "exit 3");
				const tool = createBashToolDefinition(process.cwd(), { taskOwner: owner.ownerBinding });
				const done = await settleLikeAgentLoop(() =>
					tool.execute("wait", { action: "wait", id: ok, budgetMs: 5000 }),
				);
				const failed = await settleLikeAgentLoop(() =>
					tool.execute("wait", { action: "wait", id: bad, budgetMs: 5000 }),
				);
				const statusLine = (outcome: typeof done, id: string, raw = true) =>
					row(tool, { action: "wait", id }, outcome, { raw }).find((line) =>
						/[✓✗]/.test(stripVTControlCharacters(line)),
					)!;
				assert.ok(statusLine(done, ok).startsWith(theme.fg("success", "✓ completed")));
				assert.ok(statusLine(failed, bad).startsWith(theme.fg("error", "✗ exited 3")));
				vi.stubEnv("NO_COLOR", "1");
				for (const [outcome, id, text] of [
					[done, ok, "✓ completed · exit 0"],
					[failed, bad, "✗ exited 3"],
				] as const) {
					const line = statusLine(outcome, id);
					assert.equal(stripVTControlCharacters(line).trimEnd(), text);
					assert.doesNotMatch(
						line,
						/\x1b\[(?:3[0-79]|38|9[0-7])/,
						"NO_COLOR must leave no foreground color on the status line",
					);
				}
			} finally {
				await owner.close("session-close");
			}
		},
	);

	test("an error saved by an earlier version still renders as a friendly message (#3828)", () => {
		initTheme("dark");
		const tool = createBashToolDefinition(process.cwd());
		const lines = row(
			tool,
			{ action: "wait", id: "task-1-0-1010" },
			{ result: { content: [{ type: "text", text: "UnknownTask: UnknownTask" }], details: {} }, isError: true },
		);
		assert.deepEqual(lines.slice(0, 3), [
			"$ wait task-1-0-1010",
			'✗ No background task "task-1-0-1010" in this session',
			"It may have finished and been cleaned up, or belong to another session. Run /tasks to see current tasks.",
		]);
	});

	test("a long hint wraps at 80 columns without breaking words (#3828)", () => {
		const tool = createBashToolDefinition(process.cwd());
		const lines = row(
			tool,
			{ action: "wait", id: "task-1-0-1010" },
			{
				result: {
					content: [{ type: "text", text: 'UnknownTask: No background task "task-1-0-1010" in this session' }],
					details: {},
				},
				isError: true,
			},
			{ width: 80 },
		);
		for (const line of lines) assert.ok(line.length <= 80, line);
		assert.equal(
			lines.slice(2, 4).join(" "),
			"It may have finished and been cleaned up, or belong to another session. Run /tasks to see current tasks.",
		);
	});

	test("other errors on a wait call keep their plain text (#3828)", () => {
		const tool = createBashToolDefinition(process.cwd());
		const lines = row(
			tool,
			{ action: "wait", id: "task-1-0-1" },
			{ result: { content: [{ type: "text", text: "aborted" }], details: {} }, isError: true },
		);
		assert.deepEqual(lines.slice(0, 3), ["$ wait task-1-0-1", "", "aborted"]);
	});
});

describe("kill results are friendly (#3828)", () => {
	beforeAll(() => initTheme("dark"));

	type Receipt = (id: TaskId) => CancelReceipt;
	const receipt =
		(
			execution: CancelReceipt["execution"],
			decision: CancelReceipt["decision"],
			cleanup: CancelReceipt["cleanup"] = { kind: "reaped" },
		): Receipt =>
		(taskId) => ({ taskId, decision, execution, cleanup });
	const output = { ownerId: "o", taskId: "t", artifactId: "a", byteCount: "0", omittedRanges: [] } as never;

	async function killWith(build: Receipt) {
		const owner = host();
		try {
			const id = await launch(owner, "printf 'x'; read value");
			const cancel = vi
				.spyOn(owner.ownerBinding.supervisor, "cancelTask")
				.mockResolvedValue({ ok: true, value: build(id) });
			const kill = createKillToolDefinition({ taskOwner: () => owner.ownerBinding });
			const outcome = await settleLikeAgentLoop(() => kill.execute("stop", { id }) as Promise<ShellResult>);
			cancel.mockRestore();
			return { kill, outcome, id, expected: build(id) };
		} finally {
			await owner.close("session-close");
		}
	}

	const cases: [string, Receipt, (id: string) => string, string[]][] = [
		[
			"cancellation requested",
			receipt({ kind: "cancelling", cause: "user" }, "cancellation-requested", { kind: "active" }),
			(id) => `Cancellation requested for task ${id}; it has not stopped yet. Cleanup: active.`,
			["● stopping · cancellation requested"],
		],
		[
			"already completed",
			receipt({ kind: "settled", result: { kind: "completed", output, exitCode: 0 } }, "already-settled"),
			(id) => `Task ${id} had already finished; nothing to stop. It completed with exit code 0. Cleanup: reaped.`,
			["✓ already completed · exit 0"],
		],
		[
			"already exited",
			receipt({ kind: "settled", result: { kind: "completed", output, exitCode: 2 } }, "already-settled"),
			(id) => `Task ${id} had already finished; nothing to stop. It exited with code 2. Cleanup: reaped.`,
			["✗ already exited 2"],
		],
		[
			"stopped",
			receipt({ kind: "settled", result: { kind: "cancelled", cause: "user", output } }, "cancellation-requested"),
			(id) => `Task ${id} was cancelled (stop requested). Cleanup: reaped.`,
			["○ cancelled"],
		],
	];

	for (const [name, build, model, ui] of cases) {
		test.runIf(process.platform !== "win32")(
			`kill ${name} reads as a sentence and a status line (#3828)`,
			async () => {
				const { kill, outcome, id, expected } = await killWith(build);
				assert.equal(waitText(outcome.result as ShellResult), model(id));
				assert.deepEqual(outcome.result.details, expected);
				const lines = row(kill, { id }, outcome);
				assert.deepEqual(lines, [`kill ${id}`, ...ui]);
				for (const line of lines) assert.doesNotMatch(line, FORBIDDEN_IN_UI);
			},
		);
	}

	test.runIf(process.platform !== "win32")(
		"kill shows a cleanup failure as an error and keeps structured details (#3828)",
		async () => {
			const { kill, outcome, id, expected } = await killWith(
				receipt({ kind: "cancelling", cause: "user" }, "cancellation-requested", {
					kind: "failed",
					resources: [{ resource: "process-group:77", code: "CleanupFailed", message: "cleanup denied" }],
				}),
			);
			assert.equal(outcome.isError, true);
			assert.deepEqual(outcome.result.details, expected);
			assert.equal(
				waitText(outcome.result as ShellResult),
				`Cancellation requested for task ${id}; it has not stopped yet. Cleanup failed: process-group:77 (CleanupFailed): cleanup denied.`,
			);
			assert.deepEqual(row(kill, { id }, outcome), [
				`kill ${id}`,
				"● stopping · cancellation requested",
				"✗ cleanup failed · process-group:77: cleanup denied",
			]);
		},
	);

	test.runIf(process.platform !== "win32")(
		"kill explains an unknown task id and keeps its error code (#3828)",
		async () => {
			const owner = host();
			try {
				const kill = createKillToolDefinition({ taskOwner: () => owner.ownerBinding });
				const error = await kill.execute("stop", { id: "task-1-0-1010" }).then(
					() => undefined,
					(reason: Error & { code?: string }) => reason,
				);
				assert.ok(error);
				assert.equal(error.code, "UnknownTask");
				assert.equal(error.message, 'UnknownTask: No background task "task-1-0-1010" in this session');
				const outcome = await settleLikeAgentLoop(
					() => kill.execute("stop", { id: "task-1-0-1010" }) as Promise<ShellResult>,
				);
				assert.deepEqual(row(kill, { id: "task-1-0-1010" }, outcome), [
					"kill task-1-0-1010",
					'✗ No background task "task-1-0-1010" in this session',
					"It may have finished and been cleaned up, or belong to another session. Run /tasks to see current tasks.",
				]);
			} finally {
				await owner.close("session-close");
			}
		},
	);

	test.runIf(process.platform !== "win32")(
		"kill reports a refused cancellation in plain language and keeps its error code (#3828)",
		async () => {
			const owner = host();
			try {
				const id = await launch(owner, "printf 'x'; read value");
				const cancel = vi
					.spyOn(owner.ownerBinding.supervisor, "cancelTask")
					.mockResolvedValue({ ok: false, error: { code: "CleanupFailed", message: "termination denied" } });
				const kill = createKillToolDefinition({ taskOwner: () => owner.ownerBinding });
				const error = await kill.execute("stop", { id }).then(
					() => undefined,
					(reason: Error & { code?: string }) => reason,
				);
				cancel.mockRestore();
				assert.ok(error);
				assert.equal(error.code, "CleanupFailed");
				assert.equal(error.message, `CleanupFailed: Could not stop task "${id}": termination denied`);
			} finally {
				await owner.close("session-close");
			}
		},
	);
});
