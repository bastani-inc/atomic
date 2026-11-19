/** A subagent inherits its parent's project history through its default read/search tools (#4648). */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCurrentSystemPrompt } from "@bastani/atomic-ai";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	type ToolCall,
	type ToolResultMessage,
} from "@bastani/atomic-ai/compat";
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

/** Structural cost: opening a real subagent session and running both recall tool calls. */
const REAL_SUBAGENT_TIMEOUT_MS = 120_000;
const PROVIDER = "faux-history-4648";
const MAIN_MODEL = "main-4648";
const CHILD_MODEL = "child-4648";
const EARLIER_WORK = "we chose a retry budget of three attempts";

interface Recall {
	readonly systemPrompt: string;
	readonly calls: readonly ToolCall[];
	readonly results: readonly ToolResultMessage[];
}

const RECALL_CALLS: readonly ToolCall[] = [
	fauxToolCall("read", { path: "history://sessions" }),
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

function scriptedModel(onRecall: (recall: Recall) => void): FauxResponseFactory {
	return (context, _options, _state, model) => {
		const results = context.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
		if (model.id === CHILD_MODEL) {
			const next = RECALL_CALLS[results.length];
			if (next) return fauxAssistantMessage([{ ...next }], { stopReason: "toolUse" });
			onRecall({
				systemPrompt: getCurrentSystemPrompt(context.messages),
				calls: context.messages.flatMap((message) =>
					message.role === "assistant" ? message.content.filter((part) => part.type === "toolCall") : [],
				),
				results,
			});
			return fauxAssistantMessage("Recalled the project's history");
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
		models: [{ id: MAIN_MODEL }, { id: CHILD_MODEL }],
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
	mkdirSync(join(cwd, ".atomic", "agents"), { recursive: true });
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

function assertRecalled(recall: Recall | undefined, earlierSessionId: string): void {
	assert.ok(recall, `subagent finished its recall`);
	assert.ok(recall.systemPrompt.includes("**Session memory**"), `subagent's system prompt has Session memory`);
	assert.deepEqual(
		recall.calls.map((call) => [call.name, call.arguments]),
		RECALL_CALLS.map((call) => [call.name, call.arguments]),
	);
	assert.deepEqual(
		recall.results.map((result) => result.isError),
		[false, false],
		`subagent: ${recall.results.map(resultText).join("\n---\n")}`,
	);
	const [sessions, search] = recall.results.map(resultText);
	assert.ok(sessions?.includes(`history://sessions/${earlierSessionId} `), `subagent lists sessions:\n${sessions}`);
	assert.ok(search?.includes(`history://sessions/${earlierSessionId}:`), `subagent searches history://:\n${search}`);
	assert.ok(search?.includes(EARLIER_WORK), `subagent finds the earlier work:\n${search}`);
	assert.ok(!search?.includes("sessions not searched"), `subagent searches the session history:\n${search}`);
}

test(
	"a subagent reads and searches history:// by default, with Session memory in its prompt (#4648)",
	async () => {
		vi.stubEnv("NODE_ENV", "production");
		const cwd = makeTempDirectory("atomic-history-children-4648-");
		cleanups.push(() => removeTempDirectory(cwd));
		writeProject(cwd);
		let recalled: Recall | undefined;
		const session = await mainSession(
			cwd,
			scriptedModel((result) => {
				recalled = result;
			}),
		);
		const store = session.sessionManager.getSessionStore();
		const earlier = await SessionManager.create(store, cwd);
		await earlier.appendMessage({ role: "user", content: `Earlier: ${EARLIER_WORK}.`, timestamp: Date.now() });

		await session.prompt("Delegate the recall to the recall-4648 subagent.", { streamingBehavior: "followUp" });
		await vi.waitFor(() => assert.ok(recalled), { timeout: REAL_SUBAGENT_TIMEOUT_MS });
		assertRecalled(recalled, earlier.getSessionId());
	},
	REAL_SUBAGENT_TIMEOUT_MS,
);
