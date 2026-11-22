import assert from "node:assert/strict";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, test } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import { markToolCallReadyForDetachment } from "../../packages/coding-agent/src/core/agent-session-detached-tools.js";
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
	/** Messages actually received by the provider for each request. */
	readonly requests: string[][];
	/** The ids of the tool calls that started running, in order. */
	readonly ran: string[];
	/** Settles once the stuck call has started. */
	readonly started: PromiseWithResolvers<void>;
	/** The stuck call returns this text once resolved; it never looks at its abort signal. */
	readonly release: PromiseWithResolvers<string>;
	/** When set, the call stops on its abort after all, answering this. */
	stopsWith?: string;
	/** The abort signal the last stuck call received. */
	signal?: AbortSignal;
}

type SessionKind = "main" | "subagent";
type ToolName = "stuck" | "quick";

/**
 * A session of `kind` whose model calls `stuck` for the prompt "go" (or the calls of `options.go`, in one assistant
 * message) and `quick` for any other prompt, then answers. `stuck` ignores the turn's abort until released; both are
 * exclusive, so a later call waits for every earlier one. Call ids are the tool's name and the call's place, `stuck-1`.
 */
async function sessionWithStuckTool(
	kind: SessionKind = "main",
	options: { detachable?: true; requiresReady?: true; go?: readonly ToolName[] } = {},
): Promise<{ session: AgentSession; tool: StuckTool }> {
	const tool: StuckTool = {
		requests: [],
		ran: [],
		started: Promise.withResolvers(),
		release: Promise.withResolvers(),
	};
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
			tool.requests.push(context.messages.map((message) => textOf(message.content)));
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
		...(options.requiresReady ? { detachmentRequiresReady: true } : {}),
		async execute(toolCallId, _params, signal) {
			tool.signal = signal;
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
	const executionEnded = new AbortController();
	const { session } = await createAgentSession({
		cwd: process.cwd(),
		agentDir: process.cwd(),
		builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
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
	});
	disposals.push(() => {
		tool.release.resolve("released at cleanup");
		executionEnded.abort();
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

/**
 * For the tests whose first call must have detached before Esc: the agent's tool events and the test's own steps, in
 * milliseconds from when the timeline started, reported with a failure so it shows how far the call had come.
 * Also lets the test wait directly for a call's `tool_execution_end` instead of racing a fixed sleep against another
 * timer bucket.
 */
function detachTimeline(session: AgentSession): {
	note(step: string): void;
	waitForToolEnd(toolCallId: string): Promise<void>;
	report(): string;
} {
	const origin = performance.now();
	const steps: string[] = [];
	const ended = new Set<string>();
	const waiters = new Map<string, PromiseWithResolvers<void>>();
	const at = () => Math.round(performance.now() - origin);
	const unsubscribe = session.agent.subscribe((event) => {
		if (event.type === "tool_execution_start" || event.type === "tool_execution_end")
			steps.push(`${at()} ms ${event.type} ${event.toolCallId}`);
		if (event.type === "tool_execution_end") {
			ended.add(event.toolCallId);
			waiters.get(event.toolCallId)?.resolve();
		}
	});
	disposals.push(unsubscribe);
	return {
		note: (step) => steps.push(`${at()} ms ${step}`),
		waitForToolEnd: (toolCallId) => {
			if (ended.has(toolCallId)) return Promise.resolve();
			let waiter = waiters.get(toolCallId);
			if (waiter === undefined) {
				waiter = Promise.withResolvers<void>();
				waiters.set(toolCallId, waiter);
			}
			return waiter.promise;
		},
		report: () => steps.join("; "),
	};
}

function textOf(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
	return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("\n");
}

async function assertLateSettlementIsSilent(
	session: AgentSession,
	tool: StuckTool,
	outcome: string | Error,
): Promise<void> {
	const before = [...session.messages];
	const requests = tool.requests.length;
	if (outcome instanceof Error) tool.release.reject(outcome);
	else tool.release.resolve(outcome);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(session.messages, before, "the late outcome does not change the conversation");
	assert.equal(tool.requests.length, requests, "the late outcome starts no turn");
}

describe("a tool call that ignores the interrupt (#5486)", () => {
	for (const kind of ["main", "subagent"] as const) {
		test.each([false, true])(
			`Esc ends a ${kind} session's turn without sending late output to its next model request (detachable=%s, #5486)`,
			async (detachable) => {
				const { session, tool } = await sessionWithStuckTool(kind, detachable ? { detachable: true } : {});
				if (detachable) session.setToolDetachment({ afterMs: 60_000 });
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

				const requests = tool.requests.length;
				const transcript = [...session.messages];
				const late = "CI finished after the turn was interrupted";
				tool.release.resolve(late);
				await new Promise<void>((resolve) => setImmediate(resolve));
				assert.equal(tool.requests.length, requests, "the late result starts no turn");
				assert.equal(session.isStreaming, false);
				const afterLate = [...session.messages];
				await session.prompt("next");
				const nextRequests = tool.requests.slice(requests);
				assert.ok(nextRequests.length > 0);
				assert.ok(!nextRequests.flat().some((text) => text.includes(late)), "late output reached the provider");
				assert.deepEqual(afterLate, transcript, "late settlement must not append a message");
			},
		);
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

	test.each([false, true])("a failure after abort grace is discarded (detachable=%s, #5486)", async (detachable) => {
		const { session, tool } = await sessionWithStuckTool("main", detachable ? { detachable: true } : {});
		if (detachable) session.setToolDetachment({ afterMs: 60_000 });
		const prompt = session.prompt("go");
		await tool.started.promise;
		assert.ok(await settlesWithin(session.abort(), TURN_END_BUDGET_MS), "the interrupted turn ends");
		await prompt.catch(() => {});

		await assertLateSettlementIsSilent(session, tool, new Error("deploy failed"));
	});

	test("discarding a late rejection does not format the abandoned call's reason (#5486)", async () => {
		const { session, tool } = await sessionWithStuckTool("main", { detachable: true });
		session.setToolDetachment({ afterMs: 60_000 });
		const prompt = session.prompt("go");
		await tool.started.promise;
		await session.abort();
		await prompt;
		const before = [...session.messages];
		let conversions = 0;
		tool.release.reject({
			[Symbol.toPrimitive]() {
				conversions++;
				throw new Error("cannot stringify");
			},
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(conversions, 0, "nobody consumes the abandoned result");
		assert.deepEqual(session.messages, before);
	});

	test("a detached handle returns an error result even for an unprintable rejection reason (#5486)", async () => {
		const revoked = Proxy.revocable({}, {});
		revoked.revoke();
		for (const reason of [
			Object.create(null),
			{
				toString() {
					throw new Error("unprintable");
				},
			},
			revoked.proxy,
			Symbol("stopped"),
		]) {
			const { session, tool } = await sessionWithStuckTool("main", { detachable: true });
			session.setToolDetachment({ afterMs: 0 });
			await session.prompt("go");
			const [call] = session.takeDetachedToolCalls();
			assert.ok(call);
			tool.release.reject(reason);
			const outcome = await call.result;
			assert.equal(outcome.isError, true);
			assert.ok(textOf(outcome.result.content).length > 0);
		}
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

		await assertLateSettlementIsSilent(session, tool, "CI is green");
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

		await assertLateSettlementIsSilent(session, tool, "CI is green");
	});

	for (const order of ["ready, then Esc", "Esc, then ready"] as const)
		test(`Esc in the same tick a call becomes ready to detach wins (${order}): a call that ignores it ends aborted after the grace, gives its place back, and its late result is discarded (#5486)`, async () => {
			const { session, tool } = await sessionWithStuckTool("main", { detachable: true, requiresReady: true });
			session.setToolDetachment({ afterMs: 0 });
			const prompt = session.prompt("go");
			await tool.started.promise;
			// The deadline has passed, so the call detaches as soon as it is ready; the interrupt comes in the same tick.
			await sleep(30);
			const signal = tool.signal;
			assert.ok(signal);
			let interrupted: Promise<void>;
			if (order === "ready, then Esc") {
				markToolCallReadyForDetachment(signal);
				interrupted = session.abort();
			} else {
				interrupted = session.abort();
				markToolCallReadyForDetachment(signal);
			}

			assert.ok(await settlesWithin(interrupted, TURN_END_BUDGET_MS), "the interrupted turn ends");
			await prompt.catch(() => {});
			assert.deepEqual(session.takeDetachedToolCalls(), [], "the interrupted call is not handed over as detached");
			const result = session.messages.find((message) => message.role === "toolResult");
			assert.ok(
				result?.role === "toolResult",
				"the interrupted call has its own result, not a detached placeholder",
			);
			assert.equal(result.isError, true);
			assert.match(textOf(result.content), /^Operation aborted: stuck did not stop within 0\.2 seconds/);
			assert.ok(
				await settlesWithin(session.prompt("next"), TURN_END_BUDGET_MS),
				"the next turn's exclusive call runs while the stuck call still runs",
			);

			await assertLateSettlementIsSilent(session, tool, "CI is green");
		});

	test("Esc in the same tick a call becomes ready to detach wins: a call that stops on it keeps its own result and does not detach (#5486)", async () => {
		const { session, tool } = await sessionWithStuckTool("main", { detachable: true, requiresReady: true });
		tool.stopsWith = "stopped cleanly";
		session.setToolDetachment({ afterMs: 0 });
		const prompt = session.prompt("go");
		await tool.started.promise;
		await sleep(30);
		assert.ok(tool.signal);
		markToolCallReadyForDetachment(tool.signal);
		const interrupted = session.abort();

		assert.ok(await settlesWithin(interrupted, TURN_END_BUDGET_MS), "the interrupted turn ends");
		await prompt.catch(() => {});
		assert.deepEqual(session.takeDetachedToolCalls(), [], "a call its turn cancelled is not handed over as detached");
		const result = session.messages.find((message) => message.role === "toolResult");
		assert.ok(result?.role === "toolResult");
		assert.equal(textOf(result.content), "stopped cleanly");
		await sleep(TEST_GRACE_MS * 2);
		assert.equal(
			session.messages.some((message) => message.role === "custom"),
			false,
			"nothing is recorded later",
		);
	});

	test("a call whose work answers just before it becomes ready to detach and Esc is pressed keeps its own answer (#5486)", async () => {
		// The readiness and the interrupt land at each point of the call's answer settling, before and after it.
		for (let microtasks = 0; microtasks <= 12; microtasks++) {
			const { session, tool } = await sessionWithStuckTool("main", { detachable: true, requiresReady: true });
			session.setToolDetachment({ afterMs: 0 });
			const prompt = session.prompt("go");
			await tool.started.promise;
			await sleep(30);
			const signal = tool.signal;
			assert.ok(signal);
			tool.release.resolve("CI is green");
			for (let index = 0; index < microtasks; index++) await Promise.resolve();
			markToolCallReadyForDetachment(signal);
			const interrupted = session.abort();

			assert.ok(await settlesWithin(interrupted, TURN_END_BUDGET_MS), `the turn ends (${microtasks})`);
			await prompt.catch(() => {});
			assert.deepEqual(session.takeDetachedToolCalls(), [], `nothing detached (${microtasks})`);
			const result = session.messages.find((message) => message.role === "toolResult");
			assert.ok(result?.role === "toolResult", `the call has a result (${microtasks})`);
			assert.equal(textOf(result.content), "CI is green", `the call keeps its own answer (${microtasks})`);
			assert.equal(
				session.messages.some((message) => message.role === "custom"),
				false,
				`nothing is recorded later (${microtasks})`,
			);
		}
	});

	test("a call handed over as detached is not cancelled by an Esc that follows it (#5486)", async () => {
		const { session, tool } = await sessionWithStuckTool("main", { detachable: true, requiresReady: true });
		tool.stopsWith = "stopped by the interrupt";
		session.setToolDetachment({ afterMs: 0 });
		const prompt = session.prompt("go");
		await tool.started.promise;
		await sleep(30);
		assert.ok(tool.signal);
		markToolCallReadyForDetachment(tool.signal);
		// One microtask is enough for the turn to hand the call over.
		await Promise.resolve();
		const interrupted = session.abort();

		assert.ok(await settlesWithin(interrupted, TURN_END_BUDGET_MS), "the turn ends");
		await prompt.catch(() => {});
		assert.equal(tool.signal.aborted, false, "the interrupt does not reach the detached call");
		const detached = session.takeDetachedToolCalls();
		assert.deepEqual(
			detached.map((call) => call.toolCallId),
			["stuck-1"],
		);
		tool.release.resolve("CI is green");
		const outcome = await detached[0]?.result;
		assert.equal(outcome === undefined ? undefined : textOf(outcome.result.content), "CI is green");
		assert.equal(
			session.messages.some((message) => message.role === "toolResult" || message.role === "custom"),
			false,
			"the host records the detached call's result, not the session",
		);
	});

	test("Esc ends a turn whose later call waits for its place behind a call that already detached (#5486)", async () => {
		const { session, tool } = await sessionWithStuckTool("main", { detachable: true, go: ["stuck", "stuck"] });
		session.setToolDetachment({ afterMs: 50 });
		const timeline = detachTimeline(session);
		const prompt = session.prompt("go");
		await tool.started.promise;
		timeline.note("the first call started");
		// Wait for the first call to actually detach (keeping its exclusive place while it runs on) rather than sleeping
		// a fixed duration: under load a sleep can share a timer bucket with an earlier runner timer and fire before the
		// 50 ms detachment deadline.
		assert.ok(
			await settlesWithin(timeline.waitForToolEnd("stuck-1"), TURN_END_BUDGET_MS),
			`the first call detached: ${timeline.report()}`,
		);
		timeline.note(`Esc, with the agent waiting for [${[...session.agent.state.pendingToolCalls].join(", ")}]`);
		assert.deepEqual(
			[...session.agent.state.pendingToolCalls],
			["stuck-2"],
			`the second call waits behind the detached call: ${timeline.report()}`,
		);

		assert.ok(await settlesWithin(session.abort(), TURN_END_BUDGET_MS), "the interrupted turn ends");
		await prompt.catch(() => {});
		const results = session.messages
			.filter((message) => message.role === "toolResult")
			.map((result) => [result.toolCallId, textOf(result.content), result.isError]);
		assert.deepEqual(
			results,
			[["stuck-2", "Operation aborted", true]],
			`${JSON.stringify(results)}: ${timeline.report()}`,
		);
		const detached = session.takeDetachedToolCalls();
		assert.deepEqual(
			detached.map((call) => call.toolCallId),
			["stuck-1"],
			"the call that detached before the interrupt is still the host's",
		);
		assert.equal(tool.signal?.aborted, false, "the interrupt does not reach the detached call");

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
		const timeline = detachTimeline(session);
		const prompt = session.prompt("go");
		await tool.started.promise;
		timeline.note("the first call started");
		// As above: wait for the first call to detach while the quick call waits for its exclusive place.
		assert.ok(
			await settlesWithin(timeline.waitForToolEnd("stuck-1"), TURN_END_BUDGET_MS),
			`the first call detached: ${timeline.report()}`,
		);
		timeline.note(`Esc, with the agent waiting for [${[...session.agent.state.pendingToolCalls].join(", ")}]`);
		assert.deepEqual(
			[...session.agent.state.pendingToolCalls],
			["quick-2"],
			`the quick call waits behind the detached call: ${timeline.report()}`,
		);

		assert.ok(await settlesWithin(session.abort(), TURN_END_BUDGET_MS), "the interrupted turn ends");
		await prompt.catch(() => {});
		const results = session.messages
			.filter((message) => message.role === "toolResult")
			.map((result) => [result.toolCallId, textOf(result.content), result.isError]);
		assert.deepEqual(
			results,
			[["quick-2", "Operation aborted", true]],
			`${JSON.stringify(results)}: ${timeline.report()}`,
		);
		const detached = session.takeDetachedToolCalls();
		assert.deepEqual(
			detached.map((call) => call.toolCallId),
			["stuck-1"],
			"the call that detached before the interrupt is still the host's",
		);
		assert.equal(tool.signal?.aborted, false, "the interrupt does not reach the detached call");
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

		await assertLateSettlementIsSilent(session, tool, "CI is green");
		assert.deepEqual(tool.ran, ["stuck-1", "quick-1"], "the call aborted while it waited never runs");
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
