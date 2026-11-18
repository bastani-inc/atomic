import assert from "node:assert/strict";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, test } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import type { ToolDefinition } from "../../packages/coding-agent/src/core/extensions/types.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import {
	DEFAULT_TOOL_ABORT_GRACE_MS,
	toolAbortGraceMs,
} from "../../packages/coding-agent/src/core/tools/tool-abort-grace.js";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import { sleep } from "../helpers/runtime.js";

/** How long these tests let a call run on after its turn is interrupted. */
const TEST_GRACE_MS = 200;
/** An interrupted turn must end well within this, grace included. */
const TURN_END_BUDGET_MS = 5_000;

const spec = {
	id: "m",
	name: "m",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 1000,
};

function reply(
	model: { api: AssistantMessage["api"]; provider: string; id: string },
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: stopReason === "toolUse" ? "toolUse" : "stop", message });
	stream.end(message);
	return stream;
}

const disposals: Array<() => void> = [];
let previousGrace: string | undefined;
beforeEach(() => {
	previousGrace = process.env.ATOMIC_TOOL_ABORT_GRACE_MS;
	process.env.ATOMIC_TOOL_ABORT_GRACE_MS = String(TEST_GRACE_MS);
});
afterEach(() => {
	for (const dispose of disposals.splice(0)) dispose();
	if (previousGrace === undefined) delete process.env.ATOMIC_TOOL_ABORT_GRACE_MS;
	else process.env.ATOMIC_TOOL_ABORT_GRACE_MS = previousGrace;
});

interface StuckTool {
	/** Model requests so far. */
	calls: number;
	/** The ids of the tool calls that started running, in order. */
	readonly ran: string[];
	/** Settles once the stuck call has started. */
	readonly started: PromiseWithResolvers<void>;
	/** The stuck call returns this text once resolved; it never looks at its abort signal. */
	readonly release: PromiseWithResolvers<string>;
	/** When set, the call stops on its abort after all, answering this. */
	stopsWith?: string;
}

type SessionKind = "main" | "subagent" | "workflow stage";
type ToolName = "stuck" | "quick";

/**
 * A session of `kind` whose model calls `stuck` for the prompt "go" (or the calls of `options.go`, in one assistant
 * message) and `quick` for any other prompt, then answers. `stuck` ignores the turn's abort until released; both are
 * exclusive, so a later call waits for every earlier one. Call ids are the tool's name and the call's place, `stuck-1`.
 */
async function sessionWithStuckTool(
	kind: SessionKind = "main",
	options: { detachable?: true; go?: readonly ToolName[] } = {},
): Promise<{ session: AgentSession; tool: StuckTool }> {
	const tool: StuckTool = { calls: 0, ran: [], started: Promise.withResolvers(), release: Promise.withResolvers() };
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory({ p: { type: "api_key", key: "x" } }),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerProvider("p", {
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		apiKey: "x",
		models: [spec],
		streamSimple: (model, context) => {
			tool.calls += 1;
			const lastUser = context.messages.findLastIndex((message) => message.role === "user");
			if (context.messages.slice(lastUser).some((message) => message.role === "toolResult"))
				return reply(model, [{ type: "text", text: "done" }], "stop");
			const prompt = textOf(context.messages[lastUser]?.content ?? "");
			const names: readonly ToolName[] = prompt === "go" ? (options.go ?? ["stuck"]) : ["quick"];
			return reply(
				model,
				names.map((name, index) => ({ type: "toolCall", id: `${name}-${index + 1}`, name, arguments: {} })),
				"toolUse",
			);
		},
	});
	const stuck: ToolDefinition = {
		name: "stuck",
		label: "stuck",
		description: "A call that does not stop when its turn is interrupted",
		parameters: Type.Object({}),
		concurrency: "exclusive",
		...(options.detachable ? { detachable: true } : {}),
		async execute(toolCallId, _params, signal) {
			tool.ran.push(toolCallId);
			tool.started.resolve();
			const stopped = new Promise<string>((resolve) => {
				const { stopsWith } = tool;
				if (stopsWith !== undefined) signal?.addEventListener("abort", () => resolve(stopsWith), { once: true });
			});
			const text = await Promise.race([tool.release.promise, stopped]);
			return { content: [{ type: "text", text }], details: undefined };
		},
	};
	const quick: ToolDefinition = {
		name: "quick",
		label: "quick",
		description: "A call that answers at once",
		parameters: Type.Object({}),
		concurrency: "exclusive",
		async execute(toolCallId) {
			tool.ran.push(toolCallId);
			return { content: [{ type: "text", text: "quick answer" }], details: undefined };
		},
	};
	const boundary = new WorkflowStageAdmissionBoundary();
	const executionEnded = new AbortController();
	const { session } = await createAgentSession({
		cwd: process.cwd(),
		agentDir: process.cwd(),
		builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
		modelRuntime,
		model: modelRuntime.getModel("p", "m")!,
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
		sessionManager: SessionManager.inMemory(),
		resourceLoader: createTestResourceLoader(),
		customTools: [stuck, quick],
		...(kind === "subagent"
			? {
					subagentPolicy: {
						managementActions: "full" as const,
						fanoutAuthorized: false,
						inheritProjectContext: false,
						inheritSkills: false,
						executionEnded: executionEnded.signal,
					},
				}
			: {}),
		...(kind === "workflow stage"
			? {
					orchestrationContext: {
						kind: "workflow-stage" as const,
						workflowRunId: "run",
						workflowStageId: "stage",
						workflowStageName: "stage",
						constraints: { disableWorkflowTool: true },
						messageAdmission: { boundary, extensionState: new Map(), isOpen: () => boundary.isOpen() },
					},
				}
			: {}),
	});
	disposals.push(() => {
		tool.release.resolve("released at cleanup");
		executionEnded.abort();
		void boundary.close();
		session.dispose();
	});
	return { session, tool };
}

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then(
				() => true,
				() => true,
			),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function textOf(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
	return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("\n");
}

async function until(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + TURN_END_BUDGET_MS;
	while (!condition()) {
		assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
		await sleep(10);
	}
}

describe("a tool call that ignores the interrupt (#5486)", () => {
	for (const kind of ["main", "subagent", "workflow stage"] as const) {
		test(`Esc ends a ${kind} session's turn, and the call's late result joins the conversation without starting a turn (#5486)`, async () => {
			const { session, tool } = await sessionWithStuckTool(kind);
			const prompt = session.prompt("go");
			await tool.started.promise;

			// Esc in a subagent's own chat interrupts its turn and leaves it open for the next message.
			const interrupted = kind === "subagent" ? session.interruptTurn() : session.abort();
			assert.ok(await settlesWithin(interrupted, TURN_END_BUDGET_MS), "the interrupted turn ends");
			await prompt.catch(() => {});
			assert.equal(session.isStreaming, false);
			const result = session.messages.find((message) => message.role === "toolResult");
			assert.ok(result?.role === "toolResult");
			assert.equal(result.isError, true);
			assert.match(
				textOf(result.content),
				/^Operation aborted: stuck did not stop within 0\.2 seconds after the turn was interrupted\./,
			);

			const requests = tool.calls;
			tool.release.resolve("CI is green");
			await until(
				() => session.messages.some((message) => message.role === "custom"),
				"the late result to be recorded",
			);
			const late = session.messages.find((message) => message.role === "custom");
			assert.ok(late?.role === "custom");
			assert.equal(
				textOf(late.content),
				"The stuck call stuck-1 that was interrupted finished after its turn ended:\nCI is green",
			);
			await sleep(50);
			assert.equal(tool.calls, requests, "the late result starts no turn");
			assert.equal(session.isStreaming, false);
		});
	}

	test("a call its interrupted turn stopped waiting for no longer holds back the next turn's calls (#5486)", async () => {
		const { session, tool } = await sessionWithStuckTool();
		const prompt = session.prompt("go");
		await tool.started.promise;
		assert.ok(await settlesWithin(session.abort(), TURN_END_BUDGET_MS), "the interrupted turn ends");
		await prompt.catch(() => {});

		assert.ok(
			await settlesWithin(session.prompt("next"), TURN_END_BUDGET_MS),
			"the next turn's exclusive call runs while the stuck call still runs",
		);
		const quick = session.messages.findLast((message) => message.role === "toolResult");
		assert.ok(quick?.role === "toolResult");
		assert.equal(textOf(quick.content), "quick answer");
	});

	test("a call that fails after its turn stopped waiting for it is recorded as failed (#5486)", async () => {
		const { session, tool } = await sessionWithStuckTool();
		const prompt = session.prompt("go");
		await tool.started.promise;
		assert.ok(await settlesWithin(session.abort(), TURN_END_BUDGET_MS), "the interrupted turn ends");
		await prompt.catch(() => {});

		tool.release.reject(new Error("deploy failed"));
		await until(() => session.messages.some((message) => message.role === "custom"), "the late failure");
		const late = session.messages.find((message) => message.role === "custom");
		assert.ok(late?.role === "custom");
		assert.equal(
			textOf(late.content),
			"The stuck call stuck-1 that was interrupted failed after its turn ended:\ndeploy failed",
		);
		assert.deepEqual(late.details, { toolCallId: "stuck-1", toolName: "stuck", isError: true });
	});

	test("a call that stops when its turn is interrupted keeps its own result, and nothing is recorded later (#5486)", async () => {
		const { session, tool } = await sessionWithStuckTool();
		tool.stopsWith = "stopped cleanly";
		const prompt = session.prompt("go");
		await tool.started.promise;
		assert.ok(await settlesWithin(session.abort(), TURN_END_BUDGET_MS), "the interrupted turn ends");
		await prompt.catch(() => {});

		const result = session.messages.find((message) => message.role === "toolResult");
		assert.ok(result?.role === "toolResult");
		assert.equal(textOf(result.content), "stopped cleanly");
		await sleep(TEST_GRACE_MS * 2);
		assert.equal(
			session.messages.some((message) => message.role === "custom"),
			false,
		);
	});

	test("a detachable call in a session that releases long waits stops holding its turn, and later calls, after the grace (#5486)", async () => {
		const { session, tool } = await sessionWithStuckTool("main", { detachable: true });
		// A session released when idle, like a background subagent, lets a call that waits a minute go on without it;
		// an interrupt must not wait that long.
		session.setToolDetachment({ afterMs: 60_000 });
		const prompt = session.prompt("go");
		await tool.started.promise;

		assert.ok(await settlesWithin(session.abort(), TURN_END_BUDGET_MS), "the interrupted turn ends");
		await prompt.catch(() => {});
		const result = session.messages.find((message) => message.role === "toolResult");
		assert.ok(result?.role === "toolResult");
		assert.match(textOf(result.content), /^Operation aborted: stuck did not stop within 0\.2 seconds/);
		assert.ok(
			await settlesWithin(session.prompt("next"), TURN_END_BUDGET_MS),
			"the next turn's exclusive call runs while the stuck call still runs",
		);

		tool.release.resolve("CI is green");
		await until(() => session.messages.some((message) => message.role === "custom"), "the late result");
		const late = session.messages.find((message) => message.role === "custom");
		assert.ok(late?.role === "custom");
		assert.equal(
			textOf(late.content),
			"The stuck call stuck-1 that was interrupted finished after its turn ended:\nCI is green",
		);
	});

	test("Esc wins over a detachment deadline that falls within the grace: the call ends aborted and gives its place back (#5486)", async () => {
		const { session, tool } = await sessionWithStuckTool("main", { detachable: true });
		// The call would detach 100 ms after it starts, inside the 200 ms the interrupted turn waits for it.
		session.setToolDetachment({ afterMs: TEST_GRACE_MS / 2 });
		const prompt = session.prompt("go");
		await tool.started.promise;

		assert.ok(await settlesWithin(session.abort(), TURN_END_BUDGET_MS), "the interrupted turn ends");
		await prompt.catch(() => {});
		const result = session.messages.find((message) => message.role === "toolResult");
		assert.ok(result?.role === "toolResult", "the interrupted call has its own result, not a detached placeholder");
		assert.equal(result.isError, true);
		assert.match(textOf(result.content), /^Operation aborted: stuck did not stop within 0\.2 seconds/);
		assert.deepEqual(session.takeDetachedToolCalls(), [], "the interrupted call did not detach");
		assert.ok(
			await settlesWithin(session.prompt("next"), TURN_END_BUDGET_MS),
			"the next turn's exclusive call runs while the stuck call still runs",
		);

		tool.release.resolve("CI is green");
		await until(() => session.messages.some((message) => message.role === "custom"), "the late result");
		await sleep(50);
		const late = session.messages.filter((message) => message.role === "custom");
		assert.equal(late.length, 1, "the call's late outcome is recorded once");
		assert.ok(late[0]?.role === "custom");
		assert.equal(
			textOf(late[0].content),
			"The stuck call stuck-1 that was interrupted finished after its turn ended:\nCI is green",
		);
	});

	test("Esc ends a turn whose later call waits for its place behind a call that already detached (#5486)", async () => {
		const { session, tool } = await sessionWithStuckTool("main", { detachable: true, go: ["stuck", "stuck"] });
		session.setToolDetachment({ afterMs: 50 });
		const prompt = session.prompt("go");
		await tool.started.promise;
		// The first call's 50 ms deadline was set before it started, so it passes before this wait ends: the call detaches
		// and keeps its exclusive place while it runs on, and the second call waits for that place.
		await sleep(100);

		assert.ok(await settlesWithin(session.abort(), TURN_END_BUDGET_MS), "the interrupted turn ends");
		await prompt.catch(() => {});
		const results = session.messages.filter((message) => message.role === "toolResult");
		assert.deepEqual(
			results.map((result) => [result.toolCallId, textOf(result.content), result.isError]),
			[["stuck-2", "Operation aborted", true]],
		);
		const detached = session.takeDetachedToolCalls();
		assert.deepEqual(
			detached.map((call) => call.toolCallId),
			["stuck-1"],
			"the call that detached before the interrupt is still the host's",
		);

		tool.release.resolve("CI is green");
		await detached[0]?.result;
		await sleep(50);
		assert.deepEqual(
			tool.ran,
			["stuck-1"],
			"the interrupted call never runs, also once the place it waited for frees",
		);
	});

	test("Esc ends a turn whose later call of a tool that never detaches waits behind a call that already detached (#5486)", async () => {
		const { session, tool } = await sessionWithStuckTool("main", { detachable: true, go: ["stuck", "quick"] });
		session.setToolDetachment({ afterMs: 50 });
		const prompt = session.prompt("go");
		await tool.started.promise;
		// As above: the first call detaches before this wait ends, and the quick call waits for its exclusive place.
		await sleep(100);

		assert.ok(await settlesWithin(session.abort(), TURN_END_BUDGET_MS), "the interrupted turn ends");
		await prompt.catch(() => {});
		const results = session.messages.filter((message) => message.role === "toolResult");
		assert.deepEqual(
			results.map((result) => [result.toolCallId, textOf(result.content), result.isError]),
			[["quick-2", "Operation aborted", true]],
		);
		const detached = session.takeDetachedToolCalls();
		tool.release.resolve("CI is green");
		await detached[0]?.result;
		await sleep(50);
		assert.deepEqual(
			tool.ran,
			["stuck-1"],
			"the interrupted call never runs, also once the place it waited for frees",
		);
	});

	test("a detachable call still waiting for its place when Esc is pressed ends aborted at once and never runs (#5486)", async () => {
		const { session, tool } = await sessionWithStuckTool("main", { detachable: true, go: ["stuck", "stuck"] });
		session.setToolDetachment({ afterMs: 60_000 });
		const prompt = session.prompt("go");
		await tool.started.promise;

		assert.ok(await settlesWithin(session.abort(), TURN_END_BUDGET_MS), "the interrupted turn ends");
		await prompt.catch(() => {});
		const [first, second, ...rest] = session.messages.filter((message) => message.role === "toolResult");
		assert.ok(first?.role === "toolResult" && second?.role === "toolResult");
		assert.equal(rest.length, 0);
		assert.equal(first.toolCallId, "stuck-1");
		assert.match(textOf(first.content), /^Operation aborted: stuck did not stop within 0\.2 seconds/);
		assert.equal(second.toolCallId, "stuck-2");
		assert.equal(textOf(second.content), "Operation aborted");
		assert.equal(second.isError, true);
		assert.ok(
			await settlesWithin(session.prompt("next"), TURN_END_BUDGET_MS),
			"the next turn's exclusive call runs while the stuck call still runs",
		);

		tool.release.resolve("CI is green");
		await until(() => session.messages.some((message) => message.role === "custom"), "the late result");
		await sleep(50);
		assert.deepEqual(tool.ran, ["stuck-1", "quick-1"], "the call aborted while it waited never runs");
		assert.deepEqual(
			session.messages.filter((message) => message.role === "custom").map((message) => message.details),
			[{ toolCallId: "stuck-1", toolName: "stuck", isError: false }],
			"only the call that ran has a late outcome",
		);
	});
});

describe("ATOMIC_TOOL_ABORT_GRACE_MS (#5486)", () => {
	test("takes a whole number of milliseconds; anything else keeps the 10-second default", () => {
		assert.equal(DEFAULT_TOOL_ABORT_GRACE_MS, 10_000);
		assert.equal(toolAbortGraceMs({}), 10_000);
		assert.equal(toolAbortGraceMs({ ATOMIC_TOOL_ABORT_GRACE_MS: "2500" }), 2_500);
		assert.equal(toolAbortGraceMs({ ATOMIC_TOOL_ABORT_GRACE_MS: " 0 " }), 0);
		for (const value of ["", "-1", "1.5", "10s", "abc"])
			assert.equal(toolAbortGraceMs({ ATOMIC_TOOL_ABORT_GRACE_MS: value }), 10_000, value);
		assert.equal(toolAbortGraceMs({ ATOMIC_TOOL_ABORT_GRACE_MS: "99999999999" }), 2_147_483_647);
	});
});
