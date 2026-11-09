import type { DetachedToolCall, DetachedToolResult, SessionManager } from "@bastani/atomic";
import { describe } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { ReleaseWhenWaiting } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { assert, createStore, mockSession, run, type StageSessionRuntime, test, workflow } from "./executor-shared.js";
import { type Counters, counters, FakeCiService, TOOL } from "./waiting-stage-helpers.js";

type Message = Parameters<SessionManager["appendMessage"]>[0];

function assistant(content: Extract<Message, { role: "assistant" }>["content"], stopReason: "stop" | "toolUse") {
	return {
		role: "assistant",
		content,
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	} satisfies Message;
}

/**
 * Stage sessions that run their turn the way an `AgentSession`'s agent loop does: a prompt ends on a call of the fake
 * long tool, which detaches when the stage may release; steering waits for the turn's tool results and lands before
 * the model continues; a follow-up lands once the model would stop. The session streams while its turn runs.
 */
function agentLoopAdapters(service: FakeCiService, seen: Counters, sessionStore: MemorySessionStore): StageAdapters {
	return {
		sessionStore,
		agentSession: {
			async create(options, meta) {
				const manager = options.sessionManager as SessionManager;
				const stageName = meta?.stageName ?? "stage";
				const toolCallId = `call-${stageName}`;
				seen.created += 1;
				seen.peakLive = Math.max(seen.peakLive, seen.created - seen.disposed);
				const steering: string[] = [];
				const followUps: string[] = [];
				let detachable = false;
				let detached: DetachedToolCall[] = [];
				let streaming = false;
				const continueTurn = async (results: readonly DetachedToolResult[]): Promise<void> => {
					for (const result of results)
						await manager.appendMessage({
							role: "toolResult",
							toolCallId: result.toolCallId,
							toolName: result.toolName,
							content: result.result.content,
							isError: result.isError,
							timestamp: Date.now(),
						});
					for (const text of steering.splice(0))
						await manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
					await manager.appendMessage(assistant([{ type: "text", text: "continued" }], "stop"));
					for (const text of followUps.splice(0)) {
						await manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
						await manager.appendMessage(assistant([{ type: "text", text: `answered ${text}` }], "stop"));
					}
				};
				const session: StageSessionRuntime = {
					...mockSession(manager),
					get isStreaming() {
						return streaming;
					},
					setToolDetachment(policy: { readonly afterMs: number } | undefined) {
						detachable = policy !== undefined;
					},
					async prompt(text: string) {
						seen.userPrompts.set(stageName, (seen.userPrompts.get(stageName) ?? 0) + 1);
						streaming = true;
						try {
							await manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
							await manager.appendMessage(
								assistant(
									[{ type: "toolCall", id: toolCallId, name: TOOL, arguments: { run: stageName } }],
									"toolUse",
								),
							);
							const call = service.dispatch(toolCallId);
							if (detachable) {
								detached = [call];
								return;
							}
							await continueTurn([await call.result]);
						} finally {
							streaming = false;
						}
					},
					takeDetachedToolCalls() {
						const taken = detached;
						detached = [];
						return taken;
					},
					async resumeDetachedTurn(results: readonly DetachedToolResult[]) {
						seen.continued.set(stageName, (seen.continued.get(stageName) ?? 0) + 1);
						streaming = true;
						try {
							await continueTurn(results);
						} finally {
							streaming = false;
						}
					},
					async steer(text: string) {
						seen.queued.push(`${stageName}: steer ${text}`);
						steering.push(text);
					},
					async followUp(text: string) {
						seen.queued.push(`${stageName}: followUp ${text}`);
						followUps.push(text);
					},
					async dispose() {
						seen.disposed += 1;
					},
				};
				return session;
			},
		},
	};
}

async function until(predicate: () => boolean): Promise<void> {
	for (let round = 0; round < 1_000 && !predicate(); round++) await new Promise((resolve) => setImmediate(resolve));
	assert.ok(predicate(), "condition never held");
}

/** The stored transcript as `<role>: <text>` lines, tool calls and results by id. */
async function transcript(sessionStore: MemorySessionStore, sessionId: string): Promise<string[]> {
	const stored = await sessionStore.load(sessionId);
	return stored.entries.flatMap((entry) => {
		if (entry.type !== "message") return [];
		const message = entry.message;
		if (message.role === "toolResult") return [`toolResult: ${message.toolCallId}`];
		if (message.role === "user")
			return [`user: ${typeof message.content === "string" ? message.content : "(parts)"}`];
		if (message.role !== "assistant") return [];
		return message.content.map((part) =>
			part.type === "toolCall" ? `assistant: call ${part.id}` : `assistant: ${"text" in part ? part.text : ""}`,
		);
	});
}

interface WhileWaiting {
	readonly status: string | undefined;
	readonly live: number;
}

/**
 * One stage prompted once; while its tool call runs, the workflow sends it a steering message and a follow-up through
 * the public stage, notes the stage's status and live sessions, and only then lets the call finish.
 */
async function sendWhileTheToolRuns(releaseWhenWaiting: ReleaseWhenWaiting) {
	const service = new FakeCiService();
	const seen = counters();
	const store = createStore();
	const sessionStore = new MemorySessionStore();
	const stageNamed = (): StageSnapshot | undefined =>
		store.runs()[0]?.stages.find((stage) => stage.name === "implement");
	let whileWaiting: WhileWaiting | undefined;
	let sessionId: string | undefined;
	const definition = workflow({
		name: "send-while-waiting",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const stage = ctx.stage("implement");
			const turn = stage.prompt("write the change");
			await until(() => service.pending.size === 1 && (releaseWhenWaiting === false || seen.disposed === 1));
			await stage.sendUserMessage("steer one", { deliverAs: "steer" });
			await stage.sendUserMessage("then summarize", { deliverAs: "followUp" });
			whileWaiting = { status: stageNamed()?.status, live: seen.created - seen.disposed };
			service.finishAll();
			await turn;
			sessionId = stage.sessionId;
			return {};
		},
	});

	const result = await run(
		definition,
		{},
		{ store, releaseWhenWaiting, adapters: agentLoopAdapters(service, seen, sessionStore) },
	);
	return {
		result,
		seen,
		whileWaiting,
		stage: stageNamed(),
		transcript: sessionId === undefined ? [] : await transcript(sessionStore, sessionId),
	};
}

/** The transcript every case must end with: the held steering after the result, before the model continues. */
const EXPECTED_TRANSCRIPT = [
	"user: write the change",
	"assistant: call call-implement",
	"toolResult: call-implement",
	"user: steer one",
	"assistant: continued",
	"user: then summarize",
	"assistant: answered then summarize",
];

describe("stage.sendUserMessage() while the stage waits on a tool call (#4309)", () => {
	test("a stage released on a tool wait holds a message sent through the public stage: it stays waiting with no live session, and the run completes with the message after the result and before the continuation (#4309)", async () => {
		const outcome = await sendWhileTheToolRuns({ afterMs: 0 });

		assert.equal(outcome.result.status, "completed", outcome.result.error);
		assert.deepEqual(outcome.whileWaiting, { status: "suspended", live: 0 });
		assert.equal(outcome.stage?.status, "completed");
		assert.deepEqual(outcome.transcript, EXPECTED_TRANSCRIPT);
		// Prompted once, continued once from the delivered result, in the one session it was reopened into.
		assert.equal(outcome.seen.userPrompts.get("implement"), 1);
		assert.equal(outcome.seen.continued.get("implement"), 1);
		assert.equal(outcome.seen.created, 2);
	});

	test("a stage that stays resident for its tool wait takes the same messages into its running turn (#4309)", async () => {
		const outcome = await sendWhileTheToolRuns(false);

		assert.equal(outcome.result.status, "completed", outcome.result.error);
		assert.deepEqual(outcome.whileWaiting, { status: "running", live: 1 });
		assert.equal(outcome.stage?.status, "completed");
		assert.deepEqual(outcome.transcript, EXPECTED_TRANSCRIPT);
		assert.equal(outcome.seen.userPrompts.get("implement"), 1);
		assert.equal(outcome.seen.created, 1);
	});
});
