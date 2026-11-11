/**
 * #4648: a workflow stage and a subagent recall the project's history by default. The main session is a real
 * `createAgentSession` with the bundled workflows and subagents extensions; it runs a project workflow whose stage, and
 * then a project subagent, read and search `history://` on a scripted model. Nothing configures history for them.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCurrentSystemPrompt } from "@bastani/pi-ai";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	type ToolCall,
	type ToolResultMessage,
} from "@bastani/pi-ai/compat";
import { afterEach, test, vi } from "vitest";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import {
	type AgentSession,
	AuthStorage,
	createAgentSession,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/**
 * Structural cost: the main session loads the real workflows and subagents extensions, then a real workflow stage and
 * a real subagent each open a session of their own and run three tool calls.
 */
const REAL_STAGE_AND_SUBAGENT_TIMEOUT_MS = 120_000;
const PROVIDER = "faux-history-4648";
const MAIN_MODEL = "main-4648";
const STAGE_MODEL = "stage-4648";
const CHILD_MODEL = "child-4648";
const EARLIER_WORK = "we chose a retry budget of three attempts";

type Recaller = "stage" | "subagent";
interface Recall {
	readonly systemPrompt: string;
	readonly calls: readonly ToolCall[];
	readonly results: readonly ToolResultMessage[];
}

const RECALL_CALLS: readonly ToolCall[] = [
	fauxToolCall("read", { path: "history://sessions" }),
	fauxToolCall("read", { path: "history://workflows" }),
	fauxToolCall("search", { pattern: "retry budget", paths: "history://" }),
];

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	clearSubagentControls();
	vi.unstubAllEnvs();
});

function resultText(message: ToolResultMessage): string {
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

/** Each recaller runs the three recall calls in turn on its own model, then answers. */
function scriptedModel(recalls: Map<Recaller, Recall>): FauxResponseFactory {
	return (context, _options, _state, model) => {
		const recaller: Recaller | undefined =
			model.id === STAGE_MODEL ? "stage" : model.id === CHILD_MODEL ? "subagent" : undefined;
		const results = context.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
		if (recaller !== undefined) {
			const next = RECALL_CALLS[results.length];
			if (next) return fauxAssistantMessage([{ ...next }], { stopReason: "toolUse" });
			recalls.set(recaller, {
				systemPrompt: getCurrentSystemPrompt(context.messages),
				calls: context.messages.flatMap((message) =>
					message.role === "assistant" ? message.content.filter((part) => part.type === "toolCall") : [],
				),
				results,
			});
			return fauxAssistantMessage(`${recaller} recalled the project's history`);
		}
		const delegated = results.some((message) => message.toolName === "subagent");
		const asked = context.messages.some(
			(message) => message.role === "user" && JSON.stringify(message.content).includes("Delegate the recall"),
		);
		if (asked && !delegated)
			return fauxAssistantMessage(
				[
					fauxToolCall("subagent", {
						agent: "recall-4648",
						task: "Recall the project's earlier work.",
						wait: { kind: "foreground", budgetMs: REAL_STAGE_AND_SUBAGENT_TIMEOUT_MS },
					}),
				],
				{ stopReason: "toolUse" },
			);
		return fauxAssistantMessage("done");
	};
}

async function mainSession(cwd: string, respond: FauxResponseFactory): Promise<AgentSession> {
	const faux = registerFauxProvider({
		provider: PROVIDER,
		models: [{ id: MAIN_MODEL }, { id: STAGE_MODEL }, { id: CHILD_MODEL }],
	});
	cleanups.push(() => faux.unregister());
	faux.setResponses(Array.from({ length: 40 }, () => respond));
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(PROVIDER, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
	});
	modelRuntime.registerProvider(PROVIDER, {
		baseUrl: faux.getModel().baseUrl,
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
	const { session } = await createAgentSession({
		cwd,
		modelRuntime,
		model: faux.getModel(MAIN_MODEL),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
			sessionSummary: { enabled: false },
		}),
		builtins: { mcp: false, intercom: false, "web-access": false },
	});
	cleanups.push(() => session.dispose());
	return session;
}

function writeProject(cwd: string): void {
	mkdirSync(join(cwd, ".atomic", "workflows"), { recursive: true });
	mkdirSync(join(cwd, ".atomic", "agents"), { recursive: true });
	writeFileSync(
		join(cwd, ".atomic", "workflows", "recall-4648.ts"),
		`import { workflow } from "@bastani/atomic/workflows";
export default workflow({
	name: "recall-4648",
	description: "A stage recalls the project's earlier work",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.stage("recall", { model: "${PROVIDER}/${STAGE_MODEL}" }).prompt("Recall the project's earlier work.");
		return {};
	},
});
`,
	);
	writeFileSync(
		join(cwd, ".atomic", "agents", "recall-4648.md"),
		`---
name: recall-4648
description: Recalls the project's earlier work
tools: read, search
model: ${PROVIDER}/${CHILD_MODEL}
---

Recall the project's earlier work and report it.
`,
	);
}

function assertRecalled(recall: Recall | undefined, who: Recaller, earlierSessionId: string, runId: string): void {
	assert.ok(recall, `${who} finished its recall`);
	assert.ok(recall.systemPrompt.includes("**Session memory**"), `${who}'s system prompt has Session memory`);
	assert.deepEqual(
		recall.calls.map((call) => [call.name, call.arguments]),
		RECALL_CALLS.map((call) => [call.name, call.arguments]),
		who,
	);
	assert.deepEqual(
		recall.results.map((result) => result.isError),
		[false, false, false],
		`${who}: ${recall.results.map(resultText).join("\n---\n")}`,
	);
	const [sessions, workflows, search] = recall.results.map(resultText);
	assert.ok(sessions?.includes(`history://sessions/${earlierSessionId} `), `${who} lists sessions:\n${sessions}`);
	assert.ok(workflows?.includes(`history://workflows/${runId} `), `${who} lists workflow runs:\n${workflows}`);
	assert.ok(search?.includes(`history://sessions/${earlierSessionId}:`), `${who} searches history://:\n${search}`);
	assert.ok(search?.includes(EARLIER_WORK), `${who} finds the earlier work:\n${search}`);
	assert.ok(!search?.includes("not searched"), `${who} searches sessions and workflow runs:\n${search}`);
}

test(
	"a workflow stage and a subagent read and search history:// by default, with Session memory in their prompts (#4648)",
	async () => {
		vi.stubEnv("NODE_ENV", "production");
		const cwd = makeTempDirectory("atomic-history-children-4648-");
		cleanups.push(() => removeTempDirectory(cwd));
		writeProject(cwd);
		const recalls = new Map<Recaller, Recall>();
		const session = await mainSession(cwd, scriptedModel(recalls));
		const store = session.sessionManager.getSessionStore();
		const earlier = await SessionManager.create(store, cwd);
		await earlier.appendMessage({ role: "user", content: `Earlier: ${EARLIER_WORK}.`, timestamp: Date.now() });

		await session.prompt("/workflow recall-4648 --no-picker");
		const runId = await vi.waitFor(
			async () => {
				const [run] = await session.workflows.listRuns();
				assert.ok(run, "the workflow run started");
				return run.runId;
			},
			{ timeout: 10_000 },
		);
		await session.workflows.waitForSettled(runId);
		assert.equal((await session.workflows.getRun(runId)).status, "completed");
		assertRecalled(recalls.get("stage"), "stage", earlier.getSessionId(), runId);

		await session.prompt("Delegate the recall to the recall-4648 subagent.", { streamingBehavior: "followUp" });
		await vi.waitFor(() => assert.ok(recalls.has("subagent")), { timeout: REAL_STAGE_AND_SUBAGENT_TIMEOUT_MS });
		assertRecalled(recalls.get("subagent"), "subagent", earlier.getSessionId(), runId);
	},
	REAL_STAGE_AND_SUBAGENT_TIMEOUT_MS,
);
