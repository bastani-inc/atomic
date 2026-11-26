import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeContext } from "@bastani/atomic-ai";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
} from "@bastani/atomic-ai/compat";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { createExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/loader.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import type { ResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { type CreateAgentSessionOptions, createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import type { Skill } from "../../packages/coding-agent/src/core/skills.js";
import { createSyntheticSourceInfo } from "../../packages/coding-agent/src/core/source-info.js";
import { createInProcessChildPromptBehavior } from "../../packages/subagents/src/runs/inprocess/prompt-behavior.js";
import { createForkContextResolver } from "../../packages/subagents/src/shared/fork-context.js";
import { getFixtureModel } from "../helpers/catalog-model-fixtures.ts";

export const tempDirs: string[] = [];

export function cleanupTempDirs(): void {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export const policy = (
	overrides: Partial<{
		inheritProjectContext: boolean;
		inheritSkills: boolean;
		fanoutAuthorized: boolean;
	}> = {},
) => ({
	managementActions: "restricted" as const,
	inheritProjectContext: true,
	inheritSkills: true,
	fanoutAuthorized: false,
	...overrides,
});

function testSkill(): Skill {
	return {
		name: "inherited-skill",
		description: "Inherited skill sentinel",
		filePath: "/tmp/inherited-skill/SKILL.md",
		baseDir: "/tmp/inherited-skill",
		sourceInfo: createSyntheticSourceInfo("/tmp/inherited-skill/SKILL.md", { source: "sdk" }),
		disableModelInvocation: false,
	};
}

export function resourceLoader(): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [testSkill()], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [{ path: "AGENTS.md", content: "PROJECT_CONTEXT_SENTINEL" }] }),
		getSystemPrompt: () =>
			'BASE_CHILD_PROMPT\n<skill name="subagent"><name>subagent</name><description>parent-only</description></skill>',
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: async () => {},
		reload: async () => {},
	};
}

export async function createChildSession(
	overrides: Parameters<typeof policy>[0] = {},
	sessionManager = SessionManager.inMemory(),
	options: Pick<
		CreateAgentSessionOptions,
		"model" | "modelRuntime" | "settingsManager" | "resourceLoader" | "builtins" | "initialContextTransform"
	> = {},
): Promise<Awaited<ReturnType<typeof createAgentSession>>["session"]> {
	const cwd = sessionManager.getCwd();
	const settingsManager = SettingsManager.create(cwd, cwd);
	const childPolicy = policy(overrides);
	const behavior = createInProcessChildPromptBehavior(childPolicy);
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		model: undefined,
		settingsManager,
		sessionManager,
		resourceLoader: resourceLoader(),
		subagentPolicy: childPolicy,
		...behavior,
		...options,
	});
	return session;
}

export interface PayloadMessage {
	type?: string;
	role: string;
	content: unknown;
}

export const copilotOpus = getFixtureModel("github-copilot", "claude-opus-5.5") as Model<"anthropic-messages">;

export const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const responsesModel: Model<"openai-responses"> = {
	id: "gpt-6.2-astra",
	name: "GPT-6.2 Astra",
	api: "openai-responses",
	provider: "github-copilot",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text", "image"],
	cost: zeroUsage.cost,
	contextWindow: 1_050_000,
	maxTokens: 128_000,
};

/** A parent turn produced by the model the forked child runs on, so its signed thinking is replayed to the child. */
export function parentTurn(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: copilotOpus.api,
		provider: copilotOpus.provider,
		model: copilotOpus.id,
		usage: zeroUsage,
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

export function parentToolResult(toolCallId: string, toolName: string, text: string): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

export type ChildSession = Awaited<ReturnType<typeof createChildSession>>;

/** Observe the native provider's actual serialized request; the injected transport never leaves this process. */
export async function childFirstRequest(
	session: ChildSession,
	model: Model<Api> = copilotOpus,
): Promise<PayloadMessage[]> {
	let payload: { messages?: PayloadMessage[]; input?: PayloadMessage[] } | undefined;
	const messages = await session.agent.convertToLlm([
		...session.messages,
		{ role: "user", content: "The child's task.", timestamp: 1 },
	]);
	const stream = await session.agent.streamFunction(model, normalizeContext({ messages }), {
		apiKey: "credential-free-test-key",
		reasoning: "xhigh",
		onPayload: session.agent.onPayload,
		maxRetries: 0,
		fetch: Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
			assert.equal(typeof init?.body, "string");
			payload = JSON.parse(init!.body as string);
			return new Response(null, { status: 400 });
		}, globalThis.fetch),
	});
	const reply = await stream.result();
	const rows = payload?.messages ?? payload?.input;
	if (!rows) throw new Error(reply.errorMessage ?? "No serialized request reached the transport");
	return rows;
}

export function forkParent(): SessionManager {
	const root = mkdtempSync(join(tmpdir(), "atomic-fork-thinking-"));
	tempDirs.push(root);
	return SessionManager.inMemory(root);
}

export function assistantTurns(request: PayloadMessage[]) {
	return request.filter((message) => message.role === "assistant").map((message) => message.content);
}

export async function forkChild(
	parent: SessionManager,
): Promise<Awaited<ReturnType<typeof createAgentSession>>["session"]> {
	const child = await createForkContextResolver(parent, "fork").sessionManagerForIndex(0);
	return createChildSession({}, child);
}

export async function testModelRuntime(model: Model<Api>) {
	const credentials = AuthStorage.inMemory();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "test-key" }));
	return ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
}

export function replyStream(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: message });
	if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
	else stream.push({ type: "done", reason: "stop", message });
	return stream;
}
