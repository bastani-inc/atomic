/**
 * Chaos fixture for waiting stages (#4309): one workflow root whose stages each prompt once, call a detachable tool
 * that answers after a random delay, wait with their session released, and continue when the answer arrives. Run it
 * with `start`, kill or stop it at any point, and run it again with `resume` until it completes; the journal and the
 * stage sessions live in one shared database, so several nodes can run it against the same database at once.
 *
 *   node --import jiti/register test/fixtures/waiting-stage-chaos.ts start <directory>
 *
 * Environment: ATOMIC_CHAOS_DB_URL (a libsql/https URL, file:<path>, or node-sqlite:<path>), ATOMIC_CHAOS_DB_TOKEN_FILE (optional),
 * ATOMIC_CHAOS_RUN_ID, ATOMIC_CHAOS_STAGES (default 10), ATOMIC_CHAOS_TOOL_MAX_MS (default 3000),
 * ATOMIC_CHAOS_EXPIRE_LEASE=1 to take over the previous attempt's lease at once (only after that process is dead).
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@bastani/pi-ai/compat";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { AuthStorage, ModelRuntime, SettingsManager, type ToolDefinition } from "../../packages/coding-agent/src/index.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { openChaosDatabase } from "./waiting-stage-chaos-database.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { FOREIGN_LIVE_WORKFLOW_WINDOW_MS } from "../../packages/workflows/src/durable/resume-eligibility.js";
import { createAgentSessionAdapter, run } from "../../packages/workflows/src/sdk-surface.js";
import { findStageWaitError } from "../../packages/workflows/src/shared/stage-wait-errors.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

const [mode, directory] = process.argv.slice(2);
if ((mode !== "start" && mode !== "resume") || directory === undefined)
	throw new Error("usage: waiting-stage-chaos.ts start|resume <directory>");
const env = (name: string, fallback?: string): string => {
	const value = process.env[name] ?? fallback;
	if (value === undefined) throw new Error(`${name} is required`);
	return value;
};
const runId = env("ATOMIC_CHAOS_RUN_ID");
const stages = Number(env("ATOMIC_CHAOS_STAGES", "10"));
const toolMaxMs = Number(env("ATOMIC_CHAOS_TOOL_MAX_MS", "3000"));
const tokenFile = process.env.ATOMIC_CHAOS_DB_TOKEN_FILE;
const effects = join(directory, "effects.jsonl");
const record = (event: Record<string, string | number | boolean | null>): void =>
	appendFileSync(effects, `${JSON.stringify({ ...event, pid: process.pid, at: Date.now(), runId })}\n`);

const database = await openChaosDatabase(env("ATOMIC_CHAOS_DB_URL"), tokenFile);
if (mode === "resume" && process.env.ATOMIC_CHAOS_EXPIRE_LEASE === "1")
	await database.run(
		"UPDATE wf_leases SET renewed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) - ? - 1 WHERE run_id = ?",
		FOREIGN_LIVE_WORKFLOW_WINDOW_MS,
		runId,
	);
const backend = await JournalDurableBackend.open(await SqlRunJournal.open(database));
const sessionStore = await SqlSessionStore.open(database);

const faux = registerFauxProvider();
const model = faux.getModel();
faux.setResponses(
	Array.from({ length: 4 * stages + 16 }, () => (context: { readonly messages: readonly { readonly role: string }[] }) =>
		context.messages.at(-1)?.role === "toolResult"
			? fauxAssistantMessage("ci passed")
			: fauxAssistantMessage([fauxToolCall("wait_for_ci", {})], { stopReason: "toolUse" }),
	),
);
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
const waitForCi: ToolDefinition = {
	name: "wait_for_ci",
	label: "Wait for CI",
	description: "Waits for the CI run of the change",
	parameters: Type.Object({}),
	detachable: true,
	execute: (toolCallId) => {
		record({ event: "dispatch", toolCallId });
		return new Promise<AgentToolResult>((resolve) =>
			setTimeout(
				() => resolve({ content: [{ type: "text", text: "ci passed" }], details: undefined }),
				Math.floor(Math.random() * toolMaxMs),
			),
		);
	},
};
const adapter = createAgentSessionAdapter({
	cwd: directory,
	agentDir: join(directory, "agent"),
	model,
	modelRuntime,
	settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
	builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
	tools: ["wait_for_ci"],
});
const definition = workflow({
	name: "waiting-stage-chaos",
	description: "",
	inputs: {},
	outputs: {},
	async run(ctx) {
		await Promise.all(
			Array.from({ length: stages }, (_, index) =>
				ctx.task(`stage-${index}`, { prompt: `ship change ${index}`, customTools: [waitForCi] }),
			),
		);
		return {};
	},
});

record({ event: "attempt", mode });
let exitCode = 0;
try {
	const result = await run(
		definition,
		{},
		{
			runId,
			cwd: directory,
			store: createStore(),
			durableBackend: backend,
			releaseWhenWaiting: { afterMs: 0 },
			onStageLifecycleEvent: (_runId, event) => record({ event: event.type, stage: event.stageName }),
			adapters: { sessionStore, agentSession: adapter },
		},
	);
	record({
		event: "result",
		status: result.status,
		error: result.error ?? null,
		// `active_blocked`: a stage could not reopen its session and the run waits for a resume instead of failing.
		disposition: result.failure?.disposition ?? null,
		detail: result.failureDetail === undefined ? null : JSON.stringify(result.failureDetail).slice(0, 1500),
	});
	writeFileSync(join(directory, `result-${process.pid}.json`), JSON.stringify(result.stages.map((stage) => stage.status)));
	exitCode = result.status === "completed" ? 0 : 2;
} catch (error) {
	const typed = findStageWaitError(error);
	const named = error as { readonly name?: string; readonly code?: string; readonly message?: string };
	record({
		event: "error",
		name: typed?.name ?? named.name ?? "Error",
		code: typed?.code ?? named.code ?? null,
		message: String(named.message ?? error).slice(0, 300),
	});
	exitCode = 3;
} finally {
	faux.unregister();
	for (const close of [() => backend.close(), () => sessionStore.close()]) {
		try {
			await close();
		} catch (error) {
			record({ event: "close-error", message: String((error as Error).message ?? error).slice(0, 300) });
		}
	}
}
process.exit(exitCode);
