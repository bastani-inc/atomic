import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import {
	type AssistantMessage,
	type FetchFunction,
	getModel,
	type Message,
	type Model,
	streamSimple,
} from "@bastani/atomic-ai/compat";
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
import { createForkContextResolver, forkLaunchOfTasks } from "../../packages/subagents/src/shared/fork-context.js";

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
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		model: undefined,
		settingsManager,
		sessionManager,
		resourceLoader: resourceLoader(),
		subagentPolicy: childPolicy,
		...createInProcessChildPromptBehavior(childPolicy),
	});
	return session;
}

describe("in-process child prompt construction", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

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

	test("keeps the inherited context exactly as it was, parent-only orchestration included (#5481)", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-child-context-"));
		tempDirs.push(root);
		const manager = SessionManager.inMemory(root);
		await manager.appendMessage({ role: "user", content: "keep this task", timestamp: Date.now() });
		await manager.appendMessage(
			parentTurn([{ type: "toolCall", id: "toolu_earlier", name: "subagent", arguments: { agent: "reviewer" } }]),
		);
		await manager.appendMessage(parentToolResult("toolu_earlier", "subagent", "Launched reviewer."));
		await manager.appendCustomMessageEntry("subagent-control-notice", "parent-only message", false);
		const inherited = manager.buildSessionContext().messages;
		for (const fanoutAuthorized of [false, true]) {
			const session = await createChildSession({ fanoutAuthorized }, manager);
			try {
				assert.deepEqual(session.messages.slice(0, inherited.length), inherited);
			} finally {
				session.dispose();
			}
		}
	});
});

interface AnthropicPayloadBlock {
	type: string;
	thinking?: string;
	signature?: string;
	tool_use_id?: string;
	content?: unknown;
	text?: string;
}

interface AnthropicPayloadMessage {
	role: string;
	content: string | AnthropicPayloadBlock[];
}

const copilotOpus = getModel("github-copilot", "claude-opus-5.5") as Model<"anthropic-messages">;
const anthropicOpus = getModel("anthropic", "claude-opus-5-5") as Model<"anthropic-messages">;

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A parent turn made on github-copilot/claude-opus-5.5: a child on that model is sent its signed thinking as is. */
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

/** The Anthropic Messages payload of a request that sends `messages` to `model`, built without a network call. */
async function requestMessages(
	model: Model<"anthropic-messages">,
	messages: AgentMessage[],
): Promise<AnthropicPayloadMessage[]> {
	let payload: { messages: AnthropicPayloadMessage[] } | undefined;
	await streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" }, convertToLlmContext(messages), {
		apiKey: "credential-free-test-key",
		reasoning: "xhigh",
		fetch: (async () => {
			throw new Error("payload captured");
		}) as unknown as FetchFunction,
		onPayload: (body) => {
			payload = body as { messages: AnthropicPayloadMessage[] };
		},
	}).result();
	if (!payload) throw new Error("no Anthropic payload was built");
	return payload.messages;
}

function convertToLlmContext(messages: AgentMessage[]): { messages: Message[] } {
	return { messages: convertToLlm(messages) };
}

const childTask = (session: { messages: AgentMessage[] }): AgentMessage[] => [
	...session.messages,
	{ role: "user", content: "The child's task.", timestamp: Date.now() },
];

/** Index of the child's task in a payload: the last user message, which a system message update may follow. */
function taskIndex(messages: AnthropicPayloadMessage[]): number {
	return messages.findLastIndex(
		(message) =>
			message.role === "user" &&
			Array.isArray(message.content) &&
			message.content.some((block) => block.type === "text" && block.text === "The child's task."),
	);
}

/** Index of the assistant message holding `toolCallId` in a payload. */
function launchingTurnIndex(messages: AnthropicPayloadMessage[], toolCallId: string): number {
	return messages.findIndex(
		(message) =>
			message.role === "assistant" &&
			Array.isArray(message.content) &&
			message.content.some((block) => block.type === "tool_use" && (block as { id?: string }).id === toolCallId),
	);
}

/** The tool results of the user message right after `index`, by the tool call they answer. */
function toolResultsAfter(messages: AnthropicPayloadMessage[], index: number): Map<string, string> {
	const next = messages[index + 1];
	const results = new Map<string, string>();
	if (next?.role !== "user" || !Array.isArray(next.content)) return results;
	for (const block of next.content) {
		if (block.type !== "tool_result" || block.tool_use_id === undefined) continue;
		const content = block.content as { type: string; text?: string }[] | string;
		const text = typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
		assert.equal(results.has(block.tool_use_id), false, `tool call ${block.tool_use_id} answered twice`);
		results.set(block.tool_use_id, text);
	}
	return results;
}

/**
 * A parent whose newest turn has signed thinking and launches forked children with `toolu_fork`, beside a bash call
 * of its own. `toolu_status`'s result is already saved when the children are forked.
 */
async function parentLaunchingForks(): Promise<SessionManager> {
	const parent = SessionManager.inMemory();
	await parent.appendMessage({ role: "user", content: "Fix the failing test.", timestamp: Date.now() });
	await parent.appendMessage(
		parentTurn([
			{ type: "thinking", thinking: "List the files first.", thinkingSignature: "sig-list" },
			{ type: "toolCall", id: "toolu_ls", name: "bash", arguments: { command: "ls" } },
		]),
	);
	await parent.appendMessage(parentToolResult("toolu_ls", "bash", "a.ts"));
	await parent.appendMessage(
		parentTurn([
			{ type: "thinking", thinking: "Fork workers for the fix.", thinkingSignature: "sig-launch" },
			{ type: "toolCall", id: "toolu_fork", name: "subagent", arguments: { agent: "worker", context: "fork" } },
			{ type: "toolCall", id: "toolu_status", name: "bash", arguments: { command: "git status" } },
		]),
	);
	await parent.appendMessage(parentToolResult("toolu_status", "bash", "clean"));
	return parent;
}

/** The parent's own next request after its launching turn's real results, for the same `model`. */
async function parentContinuation(
	parent: SessionManager,
	model: Model<"anthropic-messages">,
): Promise<AnthropicPayloadMessage[]> {
	await parent.appendMessage(parentToolResult("toolu_fork", "subagent", "Launched forked workers."));
	return requestMessages(model, parent.buildSessionContext().messages);
}

describe("forked child's first request is the parent's conversation plus appended messages (#5481)", () => {
	for (const model of [copilotOpus, anthropicOpus]) {
		const pair = model === copilotOpus ? "same model" : "another provider";
		test(`a child on ${pair} replays the launching turn unchanged and answers each of its calls once (#5481)`, async () => {
			const parent = await parentLaunchingForks();
			const resolver = createForkContextResolver(parent, "fork", { toolCallIds: ["toolu_fork"] });
			const session = await createChildSession({}, await resolver.sessionManagerForIndex(0));
			try {
				const child = await requestMessages(model, childTask(session));
				const continuation = await parentContinuation(parent, model);

				const launching = launchingTurnIndex(continuation, "toolu_fork");
				assert.notEqual(launching, -1);
				assert.deepEqual(child.slice(0, launching + 1), continuation.slice(0, launching + 1));
				const answers = toolResultsAfter(child, launching);
				assert.deepEqual([...answers.keys()], ["toolu_fork", "toolu_status"]);
				assert.match(answers.get("toolu_fork")!, /forked child 1 of 1/);
				assert.match(answers.get("toolu_status")!, /not available here/);
				assert.equal(taskIndex(child), child.length - (child.at(-1)?.role === "system" ? 2 : 1));
			} finally {
				session.dispose();
			}
		});
	}

	test("children of one launch share one fork point, including a child started after the parent moved on (#5481)", async () => {
		const parent = await parentLaunchingForks();
		const resolver = createForkContextResolver(
			parent,
			"fork",
			forkLaunchOfTasks(["toolu_fork", "toolu_fork", "toolu_fork"], "toolu_fork"),
		);
		const first = await createChildSession({}, await resolver.sessionManagerForIndex(0));
		// The parent keeps going before the other children get a slot.
		await parent.appendMessage(parentToolResult("toolu_fork", "subagent", "Launched forked workers."));
		await parent.appendMessage(parentTurn([{ type: "text", text: "LATER_PARENT_TURN" }]));
		const later = [
			await createChildSession({}, await resolver.sessionManagerForIndex(2)),
			await createChildSession({}, await resolver.sessionManagerForIndex(1)),
		];
		const sessions = [first, later[1]!, later[0]!];
		try {
			const requests = await Promise.all(
				sessions.map((session) => requestMessages(copilotOpus, childTask(session))),
			);
			const launching = launchingTurnIndex(requests[0]!, "toolu_fork");
			assert.notEqual(launching, -1);
			for (const [index, request] of requests.entries()) {
				assert.deepEqual(request.slice(0, launching + 1), requests[0]!.slice(0, launching + 1));
				assert.doesNotMatch(JSON.stringify(request), /LATER_PARENT_TURN/);
				const answers = toolResultsAfter(request, launching);
				assert.deepEqual([...answers.keys()], ["toolu_fork", "toolu_status"]);
				assert.match(answers.get("toolu_fork")!, new RegExp(`forked child ${index + 1} of 3`));
			}
		} finally {
			for (const session of sessions) session.dispose();
		}
	});

	test("a child of one of several subagent calls in a message answers its own call and its siblings' (#5481)", async () => {
		const parent = SessionManager.inMemory();
		await parent.appendMessage({ role: "user", content: "Review and fix.", timestamp: Date.now() });
		await parent.appendMessage(
			parentTurn([
				{ type: "thinking", thinking: "Two reviewers and one fixer.", thinkingSignature: "sig-burst" },
				{ type: "toolCall", id: "toolu_review", name: "subagent", arguments: { tasks: [] } },
				{ type: "toolCall", id: "toolu_fix", name: "subagent", arguments: { agent: "worker" } },
			]),
		);
		// A merged burst: two tasks came from the first call, one from the second.
		const resolver = createForkContextResolver(
			parent,
			"fork",
			forkLaunchOfTasks(["toolu_review", "toolu_review", "toolu_fix"], "toolu_review"),
		);
		const sessions = await Promise.all(
			[0, 1, 2].map(async (index) => createChildSession({}, await resolver.sessionManagerForIndex(index))),
		);
		try {
			const requests = await Promise.all(
				sessions.map((session) => requestMessages(copilotOpus, childTask(session))),
			);
			const launching = launchingTurnIndex(requests[0]!, "toolu_review");
			const answers = requests.map((request) => toolResultsAfter(request, launching));
			for (const request of requests)
				assert.deepEqual(request.slice(0, launching + 1), requests[0]!.slice(0, launching + 1));
			for (const answer of answers) assert.deepEqual([...answer.keys()], ["toolu_review", "toolu_fix"]);
			assert.match(answers[0]!.get("toolu_review")!, /forked child 1 of 2/);
			assert.match(answers[1]!.get("toolu_review")!, /forked child 2 of 2/);
			assert.match(answers[2]!.get("toolu_fix")!, /forked child 1 of 1/);
			for (const answer of [answers[0]!.get("toolu_fix")!, answers[2]!.get("toolu_review")!])
				assert.match(answer, /other subagents of the parent session/);
		} finally {
			for (const session of sessions) session.dispose();
		}
	});
});
