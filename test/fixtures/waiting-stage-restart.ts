import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DetachedToolCall, DetachedToolResult, SessionManager } from "@bastani/atomic";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import type { StageWaitKind } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { expireWorkflowLease } from "../helpers/workflow-lease.js";

/**
 * Scenario `tool` (the default): every stage is a task that prompts once and its tool call detaches, so the stage waits
 * released. `wait`: the process then hangs until the test kills it. `answer`: every call's result arrives and is
 * recorded, then the model never answers; the process hangs there.
 *
 * Scenario `release`: every stage prompts once, then the workflow calls `stage.release()` and holds the stage across a
 * long wait, after which it sends the stage one more message. Scenario `idle`: every stage prompts once and the workflow
 * holds it unused across a long wait, so the run's idle scan releases it; nothing more is sent. In `wait` mode the long
 * wait never ends and the test kills the process once every stage waits released.
 *
 * Scenario `finished`: every stage prompts once (even stages with `ctx.stage`, odd ones with `ctx.task`) and the model
 * gives its final answer, but in `wait` mode the call never returns, as when the process stops after the turn and
 * before the stage records its completion; the test kills the process once every stage has its answer.
 *
 * `resume`: the same run resumes from the journal; the tool now finishes at once and the long wait is over. The values
 * the workflow received from its stages are written to `resumed-results.json`.
 */
const [mode, directory, stageCountText, runIdArgument, scenarioArgument] = process.argv.slice(2);
assert.ok(mode === "wait" || mode === "answer" || mode === "resume");
assert.ok(directory);
const STAGES = Number(stageCountText ?? "20");
assert.ok(runIdArgument);
const runId = runIdArgument;
const scenario = scenarioArgument ?? "tool";
assert.ok(scenario === "tool" || scenario === "release" || scenario === "idle" || scenario === "finished");
const TOOL = "wait_for_ci";
const effects = join(directory, "effects.txt");
const journalPath = join(directory, "journal.sqlite");
if (mode === "resume") expireWorkflowLease(journalPath, runId);
const backend = await JournalDurableBackend.open(await openSqlRunJournal(journalPath));
const sessionStore = await JsonlSessionStore.open(join(directory, "sessions"), {
	exactDirectory: true,
	scanExisting: false,
});

function dispatch(toolCallId: string, stageName: string): DetachedToolCall {
	void appendFile(effects, `dispatch ${stageName}\n`);
	const result: DetachedToolResult = {
		toolCallId,
		toolName: TOOL,
		result: { content: [{ type: "text", text: "ci passed" }], details: undefined },
		isError: false,
	};
	return {
		toolCallId,
		toolName: TOOL,
		result: mode === "wait" ? new Promise<DetachedToolResult>(() => {}) : Promise.resolve(result),
		abort() {},
	};
}

/** The text of the transcript's last assistant message, as a session reports its last answer. */
function lastAnswer(messages: ReturnType<SessionManager["buildSessionProjection"]>["messages"]): string | undefined {
	const last = [...messages].reverse().find((message) => message.role === "assistant");
	if (last?.role !== "assistant") return undefined;
	return last.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

/** How a prompt reads in the effects log: the author's own text by its first word, anything else as `other`. */
function promptKind(text: string): string {
	const first = text.split(" ")[0] ?? "";
	return first === "plan" || first === "report" || first === "watch" ? first : "other";
}

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The long wait the workflow holds its stages across: endless before the kill, over at once on resume. */
const longWait = mode === "resume" ? Promise.resolve() : new Promise<void>(() => {});
const expectedWait: StageWaitKind | undefined =
	scenario === "tool" ? "tool" : scenario === "finished" ? undefined : scenario;

let waiting = 0;
let answered = 0;
let finished = 0;
/** What each stage's call returned to the workflow, by stage name. */
const results: Record<string, string> = {};
const definition = workflow({
	name: "waiting-stage-restart",
	description: "",
	inputs: {},
	outputs: {},
	async run(ctx) {
		await Promise.all(
			Array.from({ length: STAGES }, async (_, index) => {
				const name = `stage-${index}`;
				if (scenario === "tool") {
					await ctx.task(name, { prompt: `watch ci ${index}` });
					return;
				}
				if (scenario === "finished" && index % 2 === 1) {
					results[name] = (await ctx.task(name, { prompt: `plan ${index}` })).text;
					return;
				}
				const stage = ctx.stage(name);
				const answer = await stage.prompt(`plan ${index}`);
				if (scenario === "finished") results[name] = answer;
				if (scenario === "release") await stage.release();
				await longWait;
				if (scenario === "release") await stage.sendUserMessage(`report ${index}`);
			}),
		);
		return {};
	},
});

try {
	const result = await run(
		definition,
		{},
		{
			runId,
			cwd: directory,
			store: createStore(),
			durableBackend: backend,
			// An explicitly released stage, or one that never waits, does not depend on the threshold; keep the idle scan
			// away from it.
			releaseWhenWaiting: { afterMs: scenario === "release" || scenario === "finished" ? 600_000 : 0 },
			onStageLifecycleEvent: (_runId, event) => {
				if (event.type !== "stage_waiting" || event.wait.kind !== expectedWait) return;
				waiting += 1;
				if (mode === "wait" && waiting === STAGES) void writeFile(join(directory, "waiting-ready"), "ready");
			},
			adapters: {
				sessionStore,
				agentSession: {
					async create(options, meta) {
						const manager = options.sessionManager as SessionManager;
						const stageName = meta?.stageName ?? "stage";
						const toolCallId = `call-${stageName}`;
						let detached: DetachedToolCall[] = [];
						const transcript = () => manager.buildSessionProjection().messages;
						await appendFile(effects, `open ${stageName} ${transcript().length}\n`);
						return {
							async prompt(text: string) {
								await appendFile(effects, `prompt ${stageName} ${promptKind(text)}\n`);
								await manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
								if (scenario !== "tool") {
									await manager.appendMessage({
										role: "assistant",
										content: [{ type: "text", text: `answered ${text}` }],
										api: "faux",
										provider: "faux",
										model: "faux",
										usage,
										stopReason: "stop",
										timestamp: Date.now(),
									});
									if (scenario === "finished" && mode === "wait") {
										finished += 1;
										if (finished === STAGES) await writeFile(join(directory, "finished-ready"), "ready");
										// The answer is stored; the stage never records its completion. The process is killed here.
										await new Promise<never>(() => {});
									}
									return;
								}
								await manager.appendMessage({
									role: "assistant",
									content: [{ type: "toolCall", id: toolCallId, name: TOOL, arguments: { run: stageName } }],
									api: "faux",
									provider: "faux",
									model: "faux",
									usage,
									stopReason: "toolUse",
									timestamp: Date.now(),
								});
								detached = [dispatch(toolCallId, stageName)];
							},
							setToolDetachment() {},
							takeDetachedToolCalls() {
								const taken = detached;
								detached = [];
								return taken;
							},
							hasPendingDetachedTurn() {
								const last = transcript().at(-1);
								return (
									last?.role === "toolResult" || (last?.role === "assistant" && last.stopReason === "toolUse")
								);
							},
							redispatchDetachedToolCalls() {
								const last = transcript().at(-1);
								return last?.role === "assistant" && last.stopReason === "toolUse"
									? [dispatch(toolCallId, stageName)]
									: [];
							},
							async resumeDetachedTurn(results: readonly DetachedToolResult[]) {
								await appendFile(effects, `continue ${stageName}\n`);
								for (const result of results)
									await manager.appendMessage({
										role: "toolResult",
										toolCallId: result.toolCallId,
										toolName: result.toolName,
										content: result.result.content,
										isError: result.isError,
										timestamp: Date.now(),
									});
								if (mode !== "answer") return;
								answered += 1;
								if (answered === STAGES) await writeFile(join(directory, "answered-ready"), "ready");
								// The model is asked and never answers: the process is killed here.
								await new Promise<never>(() => {});
							},
							async steer() {},
							async followUp() {},
							subscribe: () => () => {},
							get sessionFile() {
								return manager.getSessionFile();
							},
							sessionId: manager.getSessionId(),
							async setModel() {},
							setThinkingLevel() {},
							cycleModel: (async () => undefined) as never,
							cycleThinkingLevel: (async () => undefined) as never,
							agent: undefined as never,
							model: undefined as never,
							thinkingLevel: "off",
							// The `finished` stages read their transcript; the others keep none, as before.
							get messages() {
								return (scenario === "finished" ? transcript() : []) as never;
							},
							isStreaming: false,
							navigateTree: (async () => ({ cancelled: false })) as never,
							compact: (async () => ({})) as never,
							abortCompaction() {},
							async abort() {},
							dispose() {},
							getLastAssistantText: () =>
								scenario === "finished"
									? lastAnswer(transcript())
									: scenario === "tool"
										? "ci passed"
										: "answered",
						};
					},
				},
			},
		},
	);
	assert.equal(result.status, "completed", JSON.stringify(result.error));
	await writeFile(join(directory, "resumed-stages.json"), JSON.stringify(result.stages.map((stage) => stage.status)));
	await writeFile(join(directory, "resumed-results.json"), JSON.stringify(results));
} finally {
	await backend.close();
	await sessionStore.close();
}
