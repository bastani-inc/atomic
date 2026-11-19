import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import { type AssistantMessage, getModel, type Message, type Model, streamSimple } from "@bastani/atomic-ai/compat";
import { afterEach, describe, test } from "vitest";
import { createExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/loader.js";
import { convertToLlm } from "../../packages/coding-agent/src/core/messages.js";
import type { ResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import type { Skill } from "../../packages/coding-agent/src/core/skills.js";
import { createSyntheticSourceInfo } from "../../packages/coding-agent/src/core/source-info.js";
import {
	CHILD_FANOUT_BOUNDARY_INSTRUCTIONS,
	CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
	createInProcessChildPromptBehavior,
	createInProcessChildSystemPromptTransform,
} from "../../packages/subagents/src/runs/inprocess/prompt-behavior.js";
import { createForkContextResolver } from "../../packages/subagents/src/shared/fork-context.js";

const tempDirs: string[] = [];

const policy = (
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

function resourceLoader(): ResourceLoader {
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

async function createChildSession(
	overrides: Parameters<typeof policy>[0] = {},
	sessionManager = SessionManager.inMemory(),
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
		systemPromptTransform: behavior.systemPromptTransform,
		initialContextTransform: behavior.initialContextTransform,
	});
	return session;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("in-process child prompt construction", () => {
	test("constructs the normal boundary and strips project context, skills, and orchestration skill by policy", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-child-prompt-"));
		tempDirs.push(root);
		const session = await createChildSession(
			{
				inheritProjectContext: false,
				inheritSkills: false,
			},
			SessionManager.inMemory(root),
		);
		try {
			assert.match(session.systemPrompt, new RegExp(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
			assert.doesNotMatch(session.systemPrompt, new RegExp(CHILD_FANOUT_BOUNDARY_INSTRUCTIONS));
			assert.doesNotMatch(session.systemPrompt, /PROJECT_CONTEXT_SENTINEL/);
			assert.doesNotMatch(session.systemPrompt, /inherited-skill/);
			assert.doesNotMatch(session.systemPrompt, /<skill name=["']subagent["']/);
			assert.match(session.systemPrompt, /BASE_CHILD_PROMPT/);
		} finally {
			session.dispose();
		}
	});

	test("strips inherited qualified subagent orchestration skill names from child prompts", () => {
		const transform = createInProcessChildSystemPromptTransform(policy({ inheritSkills: true }));
		const transformed = transform(
			[
				"BASE_CHILD_PROMPT",
				'<skill name="subagent@builtin" location="/skills/subagent/SKILL.md" candidate="skill_abc">',
				"PARENT_ORCHESTRATION_BODY",
				"</skill>",
				"<available_skills>",
				"  <skill>",
				"    <name>subagent@builtin</name>",
				"    <description>parent-only</description>",
				"  </skill>",
				"</available_skills>",
			].join("\n"),
		);

		assert.doesNotMatch(transformed, /PARENT_ORCHESTRATION_BODY/);
		assert.doesNotMatch(transformed, /<name>\s*subagent@builtin\s*<\/name>/);
		assert.doesNotMatch(transformed, /<skill name=["']subagent@builtin["']/);
		assert.match(transformed, /BASE_CHILD_PROMPT/);
	});

	test("keeps explicitly selected skill injection after inherited skills are stripped", () => {
		const transform = createInProcessChildSystemPromptTransform(
			policy({ inheritSkills: false }),
			'<skill name="tdd@builtin">\nEXPLICIT_SKILL_SENTINEL\n</skill>',
		);
		const transformed = transform(
			"BASE_CHILD_PROMPT\n\nThe following skills provide specialized instructions for specific tasks.\n\n<skills>\nINHERITED_SKILL_SENTINEL\n</skills>\nCurrent date: 2026-08-14",
		);

		assert.doesNotMatch(transformed, /INHERITED_SKILL_SENTINEL/);
		assert.match(transformed, /EXPLICIT_SKILL_SENTINEL/);
		assert.match(transformed, /<skill name="tdd@builtin">/);
	});

	test("constructs the fanout boundary only for a fanout-authorized child", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-child-fanout-prompt-"));
		tempDirs.push(root);
		const session = await createChildSession({ fanoutAuthorized: true }, SessionManager.inMemory(root));
		try {
			assert.match(session.systemPrompt, new RegExp(CHILD_FANOUT_BOUNDARY_INSTRUCTIONS));
			assert.doesNotMatch(session.systemPrompt, /You are a child subagent, not the parent orchestrator/);
			assert.match(session.systemPrompt, /PROJECT_CONTEXT_SENTINEL/);
			assert.match(session.systemPrompt, /inherited-skill/);
			assert.doesNotMatch(session.systemPrompt, /<skill name=["']subagent["']/);
		} finally {
			session.dispose();
		}
	});

	test("filters parent-only orchestration messages from inherited child context at construction", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-child-context-"));
		tempDirs.push(root);
		const manager = SessionManager.inMemory(root);
		await manager.appendMessage({ role: "user", content: "keep this task", timestamp: Date.now() });
		await manager.appendCustomMessageEntry("subagent-control-notice", "parent-only message", false);
		const session = await createChildSession({}, manager);
		try {
			assert.equal(
				session.messages.some(
					(message: AgentMessage) => message.role === "custom" && message.customType === "subagent-control-notice",
				),
				false,
			);
			assert.equal(
				session.messages.some(
					(message: AgentMessage) => message.role === "user" && message.content === "keep this task",
				),
				true,
			);
		} finally {
			session.dispose();
		}
	});
});

interface PayloadMessage {
	role: string;
	content: unknown;
}

const copilotOpus = getModel("github-copilot", "claude-opus-5.5") as Model<"anthropic-messages">;

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A parent turn produced by the model the forked child runs on, so its signed thinking is replayed to the child. */
function parentTurn(content: AssistantMessage["content"]): AssistantMessage {
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

function parentToolResult(toolCallId: string, toolName: string, text: string): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

/** The Anthropic Messages payload the child's first request would send for its projected context. */
async function childFirstRequest(messages: AgentMessage[], model = copilotOpus): Promise<PayloadMessage[]> {
	let payload: { messages: PayloadMessage[] } | undefined;
	await streamSimple(
		model,
		{ messages: [...convertToLlm(messages), { role: "user", content: "The child's task.", timestamp: Date.now() }] },
		{
			apiKey: "credential-free-test-key",
			reasoning: "xhigh",
			onPayload: (body) => {
				payload = body as { messages: PayloadMessage[] };
				throw new Error("Request captured before sending");
			},
		},
	).result();
	if (!payload) throw new Error("no Anthropic payload was built");
	return payload.messages;
}

function forkParent(): SessionManager {
	const root = mkdtempSync(join(tmpdir(), "atomic-fork-thinking-"));
	tempDirs.push(root);
	return SessionManager.inMemory(root);
}

function assistantTurns(request: PayloadMessage[]) {
	return request.filter((message) => message.role === "assistant").map((message) => message.content);
}

async function forkChild(parent: SessionManager): Promise<Awaited<ReturnType<typeof createAgentSession>>["session"]> {
	const child = await createForkContextResolver(parent, "fork").sessionManagerForIndex(0);
	return createChildSession({}, child);
}

describe("forked child's first request replays the parent's thinking (#5481)", () => {
	test("a signed subagent call does not join the next turn on same-model or cross-provider forks (#5481)", async () => {
		const parent = forkParent();
		await parent.appendMessage({ role: "user", content: "Fix the failing test.", timestamp: Date.now() });
		await parent.appendMessage(
			parentTurn([
				{ type: "thinking", thinking: "Launch a reviewer first.", thinkingSignature: "sig-launch" },
				{ type: "toolCall", id: "toolu_launch", name: "subagent", arguments: { agent: "reviewer" } },
			]),
		);
		await parent.appendMessage(parentToolResult("toolu_launch", "subagent", "Launched reviewer."));
		await parent.appendMessage(
			parentTurn([
				{ type: "thinking", thinking: "Now list the files.", thinkingSignature: "sig-list" },
				{ type: "thinking", thinking: "", thinkingSignature: "opaque-list", redacted: true },
				{ type: "toolCall", id: "toolu_ls", name: "bash", arguments: { command: "ls" } },
			]),
		);
		await parent.appendMessage(parentToolResult("toolu_ls", "bash", "a.ts"));
		// The turn that launches the forked child is still in flight.
		await parent.appendMessage(
			parentTurn([{ type: "toolCall", id: "toolu_fork", name: "subagent", arguments: { agent: "worker" } }]),
		);

		const session = await forkChild(parent);
		try {
			const tool = { type: "tool_use", id: "toolu_ls", name: "bash", input: { command: "ls" } };
			const same = await childFirstRequest(session.messages);
			assert.deepEqual(assistantTurns(same), [
				[
					{ type: "thinking", thinking: "Now list the files.", signature: "sig-list" },
					{ type: "redacted_thinking", data: "opaque-list" },
					tool,
				],
			]);
			assert.doesNotMatch(JSON.stringify(same), /Launched reviewer/);
			const other = getModel("anthropic", "claude-opus-5-5") as Model<"anthropic-messages">;
			assert.deepEqual(assistantTurns(await childFirstRequest(session.messages, other)), [[tool]]);
		} finally {
			session.dispose();
		}
	});

	test("a removed parent-only notice between two turns with thinking does not join their thinking (#5481)", async () => {
		const parent = forkParent();
		await parent.appendMessage({ role: "user", content: "Report the status.", timestamp: Date.now() });
		await parent.appendMessage(
			parentTurn([{ type: "thinking", thinking: "Start here.", thinkingSignature: "sig-first" }]),
		);
		await parent.appendCustomMessageEntry("subagent-notify", "Earlier parent notice.", true);
		await parent.appendMessage({ role: "user", content: "Check the review.", timestamp: Date.now() });
		await parent.appendMessage(
			parentTurn([
				{ type: "thinking", thinking: "Summarize the status.", thinkingSignature: "sig-status" },
				{ type: "text", text: "Waiting on the reviewer." },
			]),
		);
		await parent.appendCustomMessageEntry("subagent-notify", "The reviewer finished.", true);
		await parent.appendMessage(
			parentTurn([
				{ type: "thinking", thinking: "Read the review.", thinkingSignature: "sig-review" },
				{ type: "toolCall", id: "toolu_cat", name: "bash", arguments: { command: "cat review.md" } },
			]),
		);
		await parent.appendMessage(parentToolResult("toolu_cat", "bash", "Looks good."));
		await parent.appendMessage(
			parentTurn([{ type: "toolCall", id: "toolu_fork", name: "subagent", arguments: { agent: "worker" } }]),
		);

		const session = await forkChild(parent);
		try {
			const request = await childFirstRequest(session.messages);

			assert.doesNotMatch(JSON.stringify(request), /Earlier parent notice|The reviewer finished/);
			assert.deepEqual(assistantTurns(request), [
				[{ type: "thinking", thinking: "Start here.", signature: "sig-first" }],
				[{ type: "text", text: "Waiting on the reviewer." }],
				[
					{ type: "thinking", thinking: "Read the review.", signature: "sig-review" },
					{ type: "tool_use", id: "toolu_cat", name: "bash", input: { command: "cat review.md" } },
				],
			]);
		} finally {
			session.dispose();
		}
	});

	test("a turn left with nothing but thinking goes, and the turn before it gives up its thinking too (#5481)", async () => {
		const parent = forkParent();
		await parent.appendMessage({ role: "user", content: "Report, then delegate.", timestamp: Date.now() });
		await parent.appendMessage(
			parentTurn([
				{ type: "thinking", thinking: "Report first.", thinkingSignature: "sig-report" },
				{ type: "text", text: "Two tests fail." },
			]),
		);
		// Nothing the model reads separates these two turns in the parent either.
		await parent.appendMessage(
			parentTurn([
				{ type: "thinking", thinking: "Delegate the fix.", thinkingSignature: "sig-delegate" },
				{ type: "toolCall", id: "toolu_launch", name: "subagent", arguments: { agent: "worker" } },
			]),
		);
		await parent.appendMessage(parentToolResult("toolu_launch", "subagent", "Launched worker."));
		await parent.appendMessage(
			parentTurn([
				{ type: "thinking", thinking: "Check the log.", thinkingSignature: "sig-log" },
				{ type: "toolCall", id: "toolu_log", name: "bash", arguments: { command: "git log -1" } },
			]),
		);
		await parent.appendMessage(parentToolResult("toolu_log", "bash", "abc123"));
		await parent.appendMessage(
			parentTurn([{ type: "toolCall", id: "toolu_fork", name: "subagent", arguments: { agent: "worker" } }]),
		);

		const session = await forkChild(parent);
		try {
			const request = await childFirstRequest(session.messages);

			assert.deepEqual(assistantTurns(request), [
				[{ type: "text", text: "Two tests fail." }],
				[
					{ type: "thinking", thinking: "Check the log.", signature: "sig-log" },
					{ type: "tool_use", id: "toolu_log", name: "bash", input: { command: "git log -1" } },
				],
			]);
		} finally {
			session.dispose();
		}
	});
});
