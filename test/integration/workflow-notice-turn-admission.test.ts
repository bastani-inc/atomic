/**
 * A chat that a workflow's notice wakes runs its own commands outside that workflow's resource admission, while the
 * workflow's stages keep drawing their commands on their run's. Real AgentSessions and a real workflow run with
 * admission, against a local scripted provider; no network is contacted.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@bastani/atomic";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@bastani/atomic-ai/compat";
import { test } from "vitest";
import { PROTECTED_RECONCILIATION_CUSTOM_TYPE } from "../../packages/coding-agent/src/core/agent-session-persistent-custom-messages.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { currentWorkflowSessionRunState } from "../../packages/workflows/src/extension/adopt-session-run-state.js";
import { createWorkflowExtensionRuntimeState } from "../../packages/workflows/src/extension/extension-runtime-state.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** Structural, not a slow test: a real chat session, a workflow run that opens its SQL admission, and a shell. */
const REAL_RUN_TIMEOUT_MS = 90_000;
/**
 * How long the `echo` of the turn the completion notice woke gets to finish; a command waiting for a permit it never
 * receives does not.
 */
const WOKEN_COMMAND_BUDGET_MS = 30_000;
/** How long the run gets to record its completed status once the chat was shown its completion. */
const RUN_SETTLED_BUDGET_MS = 15_000;
/** How long the chat gets to settle having read every card it was shown; a card it is never given a turn for is not. */
const READ_BUDGET_MS = 30_000;
const PERMIT_POLL_MS = 50;
const ECHOED = "turn-admission-echo";
/**
 * The cards the chat is shown whose hidden turn it must read: the workflow's lifecycle notices, and the completion of
 * its own bash if that command outlived its foreground budget and moved to the background. A foreground command that
 * returns its result has no completion card: the notice's arrival does not move it to the background.
 */
const READ_CARD_TYPES = new Set(["workflows:lifecycle-notice", "task-completion"]);

type PermitRow = { kind: string; state: string; reason: string | null; root: string };

const PROCESS_PERMITS = "SELECT kind, state, reason, root FROM wf_runs_resource_permits WHERE kind = 'process'";

/** The process permits asked of any workflow admission in the journal, once a run's admission has opened. */
async function processPermits(database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>): Promise<PermitRow[]> {
	const opened = await database.all("SELECT 1 FROM sqlite_master WHERE name = 'wf_runs_resource_permits'");
	return opened.length > 0 ? database.all<PermitRow>(PROCESS_PERMITS) : [];
}

/** A model that runs one `echo` through bash in each turn it is given, then answers. */
async function echoModel(): Promise<{ modelRuntime: ModelRuntime; model: Model<string> }> {
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider("turn-admission-fixture", {
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		apiKey: "fixture",
		models: [
			{
				id: "echo",
				name: "Echo",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 1_000,
			},
		],
		streamSimple(model, context) {
			const answered = context.messages.at(-1)?.role === "toolResult";
			const message: AssistantMessage = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: Date.now(),
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				...(answered
					? { content: [{ type: "text" as const, text: "done" }], stopReason: "stop" as const }
					: {
							content: [
								{
									type: "toolCall" as const,
									id: `echo-${Date.now()}`,
									name: "bash",
									arguments: { command: `echo ${ECHOED}` },
								},
							],
							stopReason: "toolUse" as const,
						}),
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
			stream.end();
			return stream;
		},
	});
	return { modelRuntime, model: modelRuntime.getModel("turn-admission-fixture", "echo")! };
}

function fixtureSettings(): SettingsManager {
	return SettingsManager.inMemory({
		retry: { enabled: false },
		sessionSummary: { enabled: false },
	});
}

test.skipIf(process.platform === "win32")(
	"a chat that a workflow's completion notice wakes runs its bash without that workflow's admission",
	async () => {
		const directory = makeTempDirectory("notice-turn-admission-");
		const journalPath = join(directory, "journal.sqlite");
		const { modelRuntime, model } = await echoModel();
		const settingsManager = fixtureSettings();
		let chat: ExtensionAPI | undefined;
		const resourceLoader = new DefaultResourceLoader({
			cwd: directory,
			agentDir: join(directory, "agent"),
			settingsManager,
			builtinPackagePaths: [],
			extensionFactories: [
				(api) => {
					chat = api;
				},
			],
		});
		await resourceLoader.reload();
		// A top-level chat: created outside any workflow, so it holds no resource admission of its own.
		const { session: parent } = await createAgentSession({
			cwd: directory,
			agentDir: join(directory, "agent"),
			modelRuntime,
			model,
			settingsManager,
			sessionManager: SessionManager.inMemory(directory),
			resourceLoader,
			builtins: { subagents: false, mcp: false, intercom: false, "web-access": false },
			tools: ["bash"],
		});
		const completionCommandOutput = Promise.withResolvers<string>();
		const commandsAfterCompletion = new Set<string>();
		// The chat is torn down only once it was shown the run's completion and has read every card it was shown: a notice
		// still queued for its next turn keeps the session from being disposed, by design.
		const readEverything = Promise.withResolvers<void>();
		const shown: string[] = [];
		let read = 0;
		let completionShown = false;
		parent.subscribe((event) => {
			if (event.type === "tool_execution_start" && completionShown) commandsAfterCompletion.add(event.toolCallId);
			if (event.type === "tool_execution_end" && commandsAfterCompletion.has(event.toolCallId)) {
				completionCommandOutput.resolve(JSON.stringify(event.result));
			}
			if (event.type === "message_start" && event.message.role === "custom") {
				if (event.message.customType === PROTECTED_RECONCILIATION_CUSTOM_TYPE) read++;
				else if (READ_CARD_TYPES.has(event.message.customType)) shown.push(event.message.customType);
				const details = event.message.details as { scope?: string; status?: string } | undefined;
				if (details?.scope === "run" && details.status === "completed") completionShown = true;
			}
			if (event.type === "agent_settled" && completionShown && read >= shown.length) readEverything.resolve();
		});
		const backend = await JournalDurableBackend.open(await openSqlRunJournal(journalPath));
		const permits = await openNodeSqliteDatabase(journalPath);
		const store = createStore();
		const jobs = createJobTracker();
		const toolControlRegistry = createToolControlRegistry();
		const runId = testRunId("notifying-run");
		const definition = workflow({
			name: "notice-turn-admission",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.tool("effect", {}, async () => "saved");
				return {};
			},
		});
		// The workflows extension's notice delivery, sending into the chat through its extension API.
		const notices = createWorkflowExtensionRuntimeState(
			{ sendMessage: (message, options) => chat!.sendMessage(message, options) },
			{},
			{ runState: { ...currentWorkflowSessionRunState(), store, jobs, toolControlRegistry } },
		);
		notices.setNotificationsActive(true);
		let polling = true;
		try {
			// The run's admission never grants a permit, as on a host below its free-memory floor.
			runDetached(
				definition,
				{},
				{
					runId,
					origin: "user",
					cwd: directory,
					store,
					durableBackend: backend,
					jobs,
					toolControlRegistry,
					admission: { host: { minFreeMemoryBytes: Number.MAX_SAFE_INTEGER } },
				},
			);
			const runOutcome = jobs.get(runId)?.outcome;
			assert.ok(runOutcome, "the detached run is tracked until it settles");
			const askedTheWorkflow = (async () => {
				while (polling) {
					const rows = await processPermits(permits);
					if (rows.length > 0) return rows;
					await new Promise((resolve) => setTimeout(resolve, PERMIT_POLL_MS));
				}
				return [];
			})();
			const outcome = await Promise.race([
				completionCommandOutput.promise.then((output) => ({ kind: "ran" as const, output })),
				askedTheWorkflow.then((rows) => ({ kind: "asked the workflow" as const, rows })),
				new Promise<{ kind: "stuck" }>((resolve) =>
					setTimeout(() => resolve({ kind: "stuck" }), WOKEN_COMMAND_BUDGET_MS),
				),
			]);

			const runSettled = await Promise.race([
				runOutcome.then(() => true),
				new Promise<false>((resolve) => setTimeout(() => resolve(false), RUN_SETTLED_BUDGET_MS)),
			]);
			assert.ok(runSettled, "the run settles once the chat was shown its completion");
			assert.equal(backend.getWorkflow(runId)?.status, "completed");
			assert.deepEqual(
				outcome.kind === "ran" ? { kind: outcome.kind, ran: outcome.output.includes(ECHOED) } : outcome,
				{ kind: "ran", ran: true },
				"the chat's command runs at once and never waits on the workflow's process permit",
			);
			const readAll = await Promise.race([
				readEverything.promise.then(() => true),
				new Promise<false>((resolve) => setTimeout(() => resolve(false), READ_BUDGET_MS)),
			]);
			assert.ok(
				readAll,
				`the chat settles having read every card it was shown; shown ${shown.join(", ")}, read ${read}, run completion shown ${completionShown}`,
			);
			assert.deepEqual(
				await processPermits(permits),
				[],
				"no command of any turn a notice woke asked the workflow for a process permit",
			);
		} finally {
			polling = false;
			notices.setNotificationsActive(false);
			await parent.abort();
			await parent.dispose();
			await permits.close();
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	REAL_RUN_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a workflow stage's bash takes its process permit from its run's admission",
	async () => {
		const directory = makeTempDirectory("stage-turn-admission-");
		const journalPath = join(directory, "journal.sqlite");
		const { modelRuntime, model } = await echoModel();
		const backend = await JournalDurableBackend.open(await openSqlRunJournal(journalPath));
		const permits = await openNodeSqliteDatabase(journalPath);
		const runId = testRunId("stage-run");
		try {
			const definition = workflow({
				name: "stage-turn-admission",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					await ctx
						.stage("echo", {
							cwd: directory,
							agentDir: directory,
							modelRuntime,
							model,
							settingsManager: fixtureSettings(),
							tools: ["bash"],
							builtins: { subagents: false, mcp: false, intercom: false, "web-access": false },
						} as never)
						.prompt("Run it.");
					return {};
				},
			});
			const result = await run(
				definition,
				{},
				{ runId, store: createStore(), durableBackend: backend, admission: { limits: { process: 1 } } },
			);

			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(await processPermits(permits), [
				{ kind: "process", state: "released", reason: "resource cleanup confirmed", root: runId },
			]);
		} finally {
			await permits.close();
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	REAL_RUN_TIMEOUT_MS,
);
