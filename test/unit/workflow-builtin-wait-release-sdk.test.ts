/**
 * Real SDK stages release their sessions, and give back their run slot, while their model waits in a built-in tool
 * (#4374): a `bash` wait without a budget on the stage's own task host, and an `ask_user_question` answered through
 * the stage's UI broker. With a run limit of one stage, every stage reaches its wait only because each waiting stage
 * gave its slot back; each takes its slot back when its result arrives, and records that result once.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@bastani/pi-ai/compat";
import { test } from "vitest";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import { resolveSessionStore } from "../../packages/coding-agent/src/core/session-storage.js";
import { AuthStorage, ModelRuntime, SettingsManager } from "../../packages/coding-agent/src/index.js";
import { createAgentSessionAdapter, run, workflow } from "../../packages/workflows/src/sdk-surface.js";
import type { StageLifecycleEvent } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import { currentStageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const BUILTINS = { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false } as const;
const STAGES = 2;
/**
 * Structural cost: each stage runs on the real `AgentSession` runtime with the SQLite session store, which loads the
 * model runtime and tool registry for each session the stage opens.
 */
const REAL_AGENT_SESSION_TIMEOUT_MS = 120_000;

type FauxContext = { readonly messages: readonly { readonly role: string; readonly content?: unknown }[] };

function textOf(message: { readonly content?: unknown } | undefined): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: { readonly text?: string }) => part.text ?? "").join("");
}

interface Rig {
	readonly cwd: string;
	readonly faux: FauxProviderRegistration;
	readonly adapter: ReturnType<typeof createAgentSessionAdapter>;
	readonly sessionStore: Awaited<ReturnType<typeof resolveSessionStore>>;
	close(): Promise<void>;
}

async function rig(tools: string[]): Promise<Rig> {
	const cwd = makeTempDirectory("atomic-builtin-wait-release-");
	const faux = registerFauxProvider();
	const sessionStore = await resolveSessionStore(cwd, { agentDir: join(cwd, "agent"), settings: {} });
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
	});
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((registered) => ({
			id: registered.id,
			name: registered.name,
			api: registered.api,
			reasoning: registered.reasoning,
			input: registered.input,
			contextWindow: registered.contextWindow,
			maxTokens: registered.maxTokens,
			cost: registered.cost,
		})),
	});
	return {
		cwd,
		faux,
		sessionStore,
		adapter: createAgentSessionAdapter({
			cwd,
			agentDir: join(cwd, "agent"),
			model,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
			builtins: BUILTINS,
			tools,
		}),
		async close() {
			await sessionStore.close();
			faux.unregister();
			removeTempDirectory(cwd);
		},
	};
}

/** How the stages held their sessions and the run's one slot. */
interface Holding {
	live: number;
	peakLive: number;
	/** Stages that held the run's slot at once, at most. */
	peakRunning: number;
	/** Stages that waited released at once, at most. */
	peakWaiting: number;
	readonly events: StageLifecycleEvent[];
}

function countingAdapter(adapter: Rig["adapter"], holding: Holding): Rig["adapter"] {
	return {
		async create(...args) {
			const created = await adapter.create(...args);
			const session = "session" in created ? created.session : created;
			holding.live += 1;
			holding.peakLive = Math.max(holding.peakLive, holding.live);
			const dispose = session.dispose.bind(session);
			session.dispose = async () => {
				holding.live -= 1;
				await dispose();
			};
			return created;
		},
	};
}

function observe(store: ReturnType<typeof createStore>, holding: Holding): () => void {
	return store.subscribe(() => {
		const stages = store.runs().flatMap((snapshot: RunSnapshot) => snapshot.stages);
		const running = stages.filter((stage) => stage.status === "running" && stage.wait === undefined).length;
		const waiting = stages.filter((stage) => stage.wait !== undefined).length;
		holding.peakRunning = Math.max(holding.peakRunning, running);
		holding.peakWaiting = Math.max(holding.peakWaiting, waiting);
	});
}

function holdingCounts(): Holding {
	return { live: 0, peakLive: 0, peakRunning: 0, peakWaiting: 0, events: [] };
}

const ONE_STAGE_AT_A_TIME = {
	defaultConcurrency: 1,
	maxDepth: 3,
	persistRuns: false,
	statusFile: false,
	resumeInFlight: "never",
} as const;

test(
	"stages waiting in a bash wait without a budget release their sessions and slots, then take them back once each task exits (#4374)",
	async () => {
		const setup = await rig(["bash"]);
		const gateDirectory = mkdtempSync(join(tmpdir(), "atomic-builtin-wait-gate-"));
		const gate = join(gateDirectory, "open").replaceAll("\\", "/");
		try {
			setup.faux.setResponses(
				Array.from({ length: 3 * STAGES }, () => (context: FauxContext) => {
					const results = context.messages.filter((message) => message.role === "toolResult");
					const prompt = textOf(context.messages.find((message) => message.role === "user"));
					const stage = /build (\d+)/.exec(prompt)?.[1] ?? "?";
					if (results.length === 0)
						return fauxAssistantMessage(
							[
								fauxToolCall("bash", {
									command: `while [ ! -e '${gate}' ]; do sleep 0.02; done; echo built-${stage}`,
									wait: { kind: "background" },
									timeout: 60,
								}),
							],
							{ stopReason: "toolUse" },
						);
					if (results.length === 1) {
						const taskId = /\(task ([^)]+)\)/.exec(textOf(results[0]))?.[1] ?? "unknown";
						return fauxAssistantMessage(
							[fauxToolCall("bash", { action: "wait", id: taskId }, { id: `wait-${stage}` })],
							{
								stopReason: "toolUse",
							},
						);
					}
					return fauxAssistantMessage(`stage ${stage}: ${textOf(results[1]).split("\n")[0]}`);
				}),
			);
			const holding = holdingCounts();
			const store = createStore();
			const stopObserving = observe(store, holding);
			const allWaiting = Promise.withResolvers<void>();
			const definition = workflow({
				name: "bash-wait-release",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					const tasks = Array.from({ length: STAGES }, (_, index) =>
						ctx.task(`stage-${index}`, { prompt: `build ${index}` }),
					);
					const finished = Promise.all(tasks).then(() => {
						throw new Error("the stages finished without ever waiting released together");
					});
					await Promise.race([allWaiting.promise, finished]);
					assert.equal(holding.live, 0, "no stage kept a live session while it waited");
					writeFileSync(gate, "");
					await Promise.all(tasks);
					return {};
				},
			});

			const result = await run(
				definition,
				{},
				{
					cwd: setup.cwd,
					store,
					config: ONE_STAGE_AT_A_TIME,
					journal: { memory: true },
					releaseWhenWaiting: { afterMs: 0 },
					onStageLifecycleEvent: (_runId, event) => {
						holding.events.push(event);
						if (holding.events.filter((candidate) => candidate.type === "stage_waiting").length === STAGES)
							allWaiting.resolve();
					},
					adapters: { sessionStore: setup.sessionStore, agentSession: countingAdapter(setup.adapter, holding) },
				},
			);
			stopObserving();

			assert.equal(result.status, "completed", result.error);
			assert.deepEqual(
				holding.events.map((event) => [
					event.type,
					event.wait.kind,
					event.wait.toolCalls?.map((call) => call.toolName),
				]),
				[
					...Array.from({ length: STAGES }, () => ["stage_waiting", "tool", ["bash"]]),
					...Array.from({ length: STAGES }, () => ["stage_rehydrated", "tool", ["bash"]]),
				],
			);
			assert.equal(holding.peakWaiting, STAGES, "every stage waited released at once");
			assert.equal(holding.peakRunning, 1, "the run's one slot was never held by two stages");
			assert.equal(holding.peakLive, 1, "never more than one live session");
			assert.equal(setup.faux.state.callCount, 3 * STAGES, "each stage's turn continued once from its result");
			for (const stage of store.runs()[0]!.stages) {
				const saved = await setup.sessionStore.load(stage.sessionId!);
				const results = saved.entries.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
				);
				const index = stage.name.split("-")[1];
				assert.deepEqual(
					results.map((message) => message.toolName),
					["bash", "bash"],
					stage.name,
				);
				assert.equal(results.filter((message) => message.toolCallId === `wait-${index}`).length, 1, stage.name);
				assert.match(textOf(results[1]), new RegExp(`built-${index}`), stage.name);
				assert.match(stage.result ?? "", new RegExp(`stage ${index}: built-${index}`), stage.name);
			}
		} finally {
			rmSync(gateDirectory, { recursive: true, force: true });
			await setup.close();
		}
	},
	REAL_AGENT_SESSION_TIMEOUT_MS,
);

test(
	"stages waiting on an ask_user_question release their sessions and slots, keep awaiting input, and take them back once answered (#4374)",
	async () => {
		const setup = await rig(["ask_user_question"]);
		try {
			setup.faux.setResponses(
				Array.from({ length: 2 * STAGES }, () => (context: FauxContext) => {
					const prompt = textOf(context.messages.find((message) => message.role === "user"));
					const stage = /stage (\d+)/.exec(prompt)?.[1] ?? "?";
					const results = context.messages.filter((message) => message.role === "toolResult");
					if (results.length === 0)
						return fauxAssistantMessage(
							[
								fauxToolCall(
									"ask_user_question",
									{
										questions: [
											{
												question: `Which database should stage ${stage} use?`,
												header: "Database",
												options: [
													{ label: "Postgres", description: "Relational" },
													{ label: "SQLite", description: "Embedded" },
												],
											},
										],
									},
									{ id: `ask-${stage}` },
								),
							],
							{ stopReason: "toolUse" },
						);
					return fauxAssistantMessage(`stage ${stage}: ${/Postgres|SQLite/.exec(textOf(results[0]))?.[0] ?? "?"}`);
				}),
			);
			const holding = holdingCounts();
			const store = createStore();
			const broker = currentStageUiBroker();
			const stopObserving = observe(store, holding);
			const allWaiting = Promise.withResolvers<void>();
			let awaitingWhileReleased: readonly string[] = [];
			const definition = workflow({
				name: "question-release",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					const tasks = Array.from({ length: STAGES }, (_, index) =>
						ctx.task(`stage-${index}`, { prompt: `plan stage ${index}` }),
					);
					const finished = Promise.all(tasks).then(() => {
						throw new Error("the stages finished without ever waiting released together");
					});
					await Promise.race([allWaiting.promise, finished]);
					assert.equal(holding.live, 0, "no stage kept a live session while it waited");
					const stages = store.runs()[0]!.stages;
					awaitingWhileReleased = stages.map((stage) => `${stage.status}:${stage.wait?.kind}`);
					for (const stage of stages)
						assert.equal(
							broker.answerStagePrompt(store.runs()[0]!.id, stage.id, {
								optionLabels: [stage.name === "stage-0" ? "Postgres" : "SQLite"],
							}),
							true,
							stage.name,
						);
					await Promise.all(tasks);
					return {};
				},
			});

			const result = await run(
				definition,
				{},
				{
					cwd: setup.cwd,
					store,
					config: ONE_STAGE_AT_A_TIME,
					journal: { memory: true },
					releaseWhenWaiting: { afterMs: 0 },
					onStageLifecycleEvent: (_runId, event) => {
						holding.events.push(event);
						if (holding.events.filter((candidate) => candidate.type === "stage_waiting").length === STAGES)
							allWaiting.resolve();
					},
					adapters: { sessionStore: setup.sessionStore, agentSession: countingAdapter(setup.adapter, holding) },
				},
			);
			stopObserving();

			assert.equal(result.status, "completed", result.error);
			assert.deepEqual(
				awaitingWhileReleased,
				Array.from({ length: STAGES }, () => "awaiting_input:tool"),
			);
			assert.deepEqual(
				holding.events.map((event) => [event.type, event.wait.toolCalls?.map((call) => call.toolName)]),
				[
					...Array.from({ length: STAGES }, () => ["stage_waiting", ["ask_user_question"]]),
					...Array.from({ length: STAGES }, () => ["stage_rehydrated", ["ask_user_question"]]),
				],
			);
			assert.equal(holding.peakWaiting, STAGES, "every stage waited released at once");
			assert.equal(holding.peakLive, 1, "never more than one live session");
			assert.equal(setup.faux.state.callCount, 2 * STAGES, "each stage's turn continued once from its answer");
			for (const stage of store.runs()[0]!.stages) {
				const saved = await setup.sessionStore.load(stage.sessionId!);
				const index = stage.name.split("-")[1];
				const results = saved.entries.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolCallId] : [],
				);
				assert.deepEqual(results, [`ask-${index}`], stage.name);
				assert.equal(stage.result, `stage ${index}: ${index === "0" ? "Postgres" : "SQLite"}`);
				assert.equal(stage.status, "completed");
			}
		} finally {
			await setup.close();
		}
	},
	REAL_AGENT_SESSION_TIMEOUT_MS,
);
