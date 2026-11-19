import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import { normalizeContext } from "@bastani/atomic-ai";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	getModel,
	type Message,
	type Model,
	streamSimple,
} from "@bastani/atomic-ai/compat";
import { afterEach, describe, test, vi } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import {
	createExtensionRuntime,
	loadExtensionFromFactory,
} from "../../packages/coding-agent/src/core/extensions/loader.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import type { ResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { type CreateAgentSessionOptions, createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import type { Skill } from "../../packages/coding-agent/src/core/skills.js";
import { createSyntheticSourceInfo } from "../../packages/coding-agent/src/core/source-info.js";
import {
	CHILD_FANOUT_BOUNDARY_INSTRUCTIONS,
	CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
	createInProcessChildPromptBehavior,
	createInProcessChildSystemPromptTransform,
	stripParentOnlySubagentMessages,
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
	type?: string;
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

type ChildSession = Awaited<ReturnType<typeof createChildSession>>;

/** Capture the destination's payload after the same conversion and payload hooks used by the session. */
async function childFirstRequest(session: ChildSession, model: Model<Api> = copilotOpus): Promise<PayloadMessage[]> {
	let payload: { messages?: PayloadMessage[]; input?: PayloadMessage[] } | undefined;
	await streamSimple(
		model,
		{
			messages: await session.agent.convertToLlm([
				...session.messages,
				{ role: "user", content: "The child's task.", timestamp: 1 },
			]),
		},
		{
			apiKey: "credential-free-test-key",
			reasoning: "xhigh",
			onPayload: async (body, target) => {
				payload = ((await session.agent.onPayload?.(body, target)) ?? body) as typeof payload;
				throw new Error("Request captured before sending");
			},
		},
	).result();
	const messages = payload?.messages ?? payload?.input;
	if (!messages) throw new Error("no request payload was built");
	return messages;
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

async function testModelRuntime(model: Model<Api>) {
	const credentials = AuthStorage.inMemory();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "test-key" }));
	return ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
}

function replyStream(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: message });
	if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
	else stream.push({ type: "done", reason: "stop", message });
	return stream;
}

describe("child context refresh (#5481)", () => {
	test("a fork does not enable a custom history filter's optional fanout argument (#5481)", async () => {
		const parent = forkParent();
		await parent.appendMessage(
			parentTurn([{ type: "toolCall", id: "parent_call", name: "subagent", arguments: {} }]),
		);
		await parent.appendMessage(parentToolResult("parent_call", "subagent", "Parent-only result."));
		const child = await createForkContextResolver(parent, "fork").sessionManagerForIndex(0);
		const session = await createChildSession({}, child, { initialContextTransform: stripParentOnlySubagentMessages });
		try {
			assert.ok(
				!session.messages.some((message) => message.role === "toolResult" && message.toolName === "subagent"),
			);
		} finally {
			await session.dispose();
		}
	});

	test("a fresh child's retry keeps the user's task, including after reopening (#5481)", async () => {
		const root = forkParent().getCwd();
		const manager = await SessionManager.create(root, join(root, "sessions"));
		await manager.appendCustomMessageEntry("subagent-notify", "Previous worker finished.", true);
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			(pi) => {
				pi.on("turn_end", ({ message }) => {
					if (message.role === "assistant" && message.stopReason === "error")
						return {
							entries: [
								{
									type: "custom_message",
									customType: "subagent-notify",
									content: "Worker finished.",
									display: true,
								},
							],
						};
				});
			},
			root,
			createEventBus(),
			runtime,
		);
		const loader = resourceLoader();
		loader.getExtensions = () => ({ extensions: [extension], errors: [], runtime });
		const settingsManager = SettingsManager.create(root, root);
		settingsManager.applyOverrides({ retry: { enabled: true, baseDelayMs: 1, maxRetries: 1 } });
		const session = await createChildSession({}, manager, {
			model: copilotOpus,
			modelRuntime: await testModelRuntime(copilotOpus),
			settingsManager,
			resourceLoader: loader,
			builtins: { intercom: false },
		});
		const requests: Message[][] = [];
		session.agent.streamFunction = (_model, context) => {
			requests.push(context.messages);
			return replyStream(
				requests.length === 1
					? {
							...parentTurn([{ type: "thinking", thinking: "Partial", thinkingSignature: "sig" }]),
							stopReason: "error",
							errorMessage: "overloaded_error",
						}
					: parentTurn([{ type: "text", text: "Recovered." }]),
			);
		};
		try {
			const recoveryEdit = new Promise<void>((resolve) =>
				session.subscribe((event) => {
					if (event.type === "entry_appended" && event.entry.type === "context_edit") resolve();
				}),
			);
			const prompt = session.prompt("Keep this task.");
			await recoveryEdit;
			const reopened = await SessionManager.open(manager.getSessionFile()!);
			const messages = reopened.buildSessionProjection().messages;
			assert.ok(messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("Keep this task.")));
			assert.ok(!messages.some((m) => m.role === "assistant" && m.stopReason === "error"));
			await prompt;
			assert.equal(requests.length, 2);
			assert.deepEqual(requests[1], requests[0]);
		} finally {
			await session.dispose();
		}
	});

	test("an unchanged fresh child still sends its scheduled cache warm after refresh (#5481)", async () => {
		const manager = forkParent();
		const model = { ...getModel("anthropic", "claude-sonnet-4-5")!, promptCache: { short: 60, long: 60 } };
		const answer = {
			...parentTurn([{ type: "thinking", thinking: "Answer", thinkingSignature: "sig" }]),
			provider: model.provider,
			model: model.id,
			usage: { ...zeroUsage, input: 100_000, totalTokens: 100_000 },
		};
		await manager.appendMessage({ role: "user", content: "Prior task.", timestamp: 0 });
		await manager.appendMessage(answer);
		await manager.appendCustomMessageEntry("subagent-notify", "Worker finished.", true);
		const settingsManager = SettingsManager.create(manager.getCwd(), manager.getCwd());
		settingsManager.setCacheWarmingMode("idle");
		const modelRuntime = await testModelRuntime(model);
		const tokenLimits: (number | undefined)[] = [];
		modelRuntime.streamSimple = (_model, _context, options) => {
			tokenLimits.push(options?.maxTokens);
			return replyStream(answer);
		};
		const session = await createChildSession({}, manager, {
			model,
			modelRuntime,
			settingsManager,
			builtins: { intercom: false },
		});
		try {
			vi.useFakeTimers();
			const messages = await session.agent.convertToLlm(session.messages);
			await session.agent.streamFunction(model, normalizeContext({ messages }), { sessionId: session.sessionId });
			const scheduled = session.cacheWarmingStatus;
			assert.equal(scheduled?.state, "scheduled");
			assert.equal(scheduled.decision?.action, "warm");
			session.refreshContext();
			await vi.advanceTimersByTimeAsync(scheduled.nextWarmAt! - Date.now());
			assert.deepEqual(tokenLimits, [undefined, 1]);
		} finally {
			vi.useRealTimers();
			await session.dispose();
		}
	});

	test("refreshing a fork never rereads a mixed answer's signatures for each removed notice (#5481)", () => {
		let reads = 0;
		const answer = parentTurn([
			...Array.from({ length: 256 }, () => ({
				type: "thinking" as const,
				thinking: "Thinking",
				get thinkingSignature() {
					reads++;
					return "sig";
				},
			})),
			{ type: "text", text: "Done." },
		]);
		const notices = Array.from({ length: 256 }, () => ({
			role: "custom",
			customType: "subagent-notify",
			content: "Worker finished.",
		}));
		const projected = stripParentOnlySubagentMessages([answer, ...notices]);
		assert.equal(reads, 0);
		assert.equal(projected.length, 1);
		assert.strictEqual(projected[0], answer);
	});
});

describe("forked child's first request replays the parent's thinking (#5481)", () => {
	test("an aborted reply after a notice does not replace the latest signed answer, even on reopen (#5481)", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-reopen-thinking-"));
		tempDirs.push(root);
		const parent = await SessionManager.create(root, join(root, "sessions"));
		await parent.appendMessage(
			parentTurn([
				{ type: "thinking", thinking: "Check the result.", thinkingSignature: "sig-answer" },
				{ type: "text", text: "Done." },
			]),
		);
		await parent.appendCustomMessageEntry("subagent-notify", "Worker finished.", true);
		await parent.appendMessage({ ...parentTurn([]), stopReason: "aborted" });
		await parent.appendMessage({ role: "user", content: "Continue.", timestamp: 1 });
		const child = (await createForkContextResolver(parent, "fork").sessionManagerForIndex(0))!;
		for (const reopen of [false, true]) {
			const session = await createChildSession(
				{},
				reopen ? await SessionManager.open(child.getSessionFile()!) : child,
			);
			try {
				assert.deepEqual(assistantTurns(await childFirstRequest(session)), [
					[
						{ type: "thinking", thinking: "Check the result.", signature: "sig-answer" },
						{ type: "text", text: "Done." },
					],
				]);
			} finally {
				await session.dispose();
			}
		}
	});

	test.each(["fork", "fresh"] as const)(
		"Responses keeps encrypted reasoning across a notice in a reopened %s child (#5481)",
		async (kind) => {
			const root = mkdtempSync(join(tmpdir(), "atomic-responses-thinking-"));
			tempDirs.push(root);
			const parent = await SessionManager.create(root, join(root, "sessions"));
			const model: Model<"openai-responses"> = {
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
			const item = { type: "reasoning", id: "rs_first", encrypted_content: "opaque", summary: [] };
			const first = {
				...parentTurn([
					{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(item) },
					{ type: "text", text: "First." },
				]),
				model: model.id,
				provider: model.provider,
				api: model.api,
			};
			await parent.appendMessage(first);
			await parent.appendCustomMessageEntry("subagent-notify", "Worker finished.", true);
			await parent.appendMessage({ ...first, content: [{ type: "text", text: "Second." }] });
			const child =
				kind === "fork" ? (await createForkContextResolver(parent, kind).sessionManagerForIndex(0))! : parent;
			const session = await createChildSession({}, await SessionManager.open(child.getSessionFile()!));
			try {
				const request = await childFirstRequest(session, model);
				assert.deepEqual(
					request.find((entry) => entry.type === "reasoning"),
					item,
				);
			} finally {
				await session.dispose();
			}
		},
	);

	test("unsigned thinking remains readable text across a removed notice (#5481)", async () => {
		const parent = forkParent();
		await parent.appendMessage(
			parentTurn([{ type: "thinking", thinking: "Handoff code: 730.", thinkingSignature: "" }]),
		);
		await parent.appendCustomMessageEntry("subagent-notify", "Worker finished.", true);
		await parent.appendMessage(
			parentTurn([
				{ type: "thinking", thinking: "Review.", thinkingSignature: "sig-review" },
				{ type: "text", text: "Done." },
			]),
		);
		const session = await forkChild(parent);
		try {
			assert.deepEqual(assistantTurns(await childFirstRequest(session))[0], [
				{ type: "text", text: "Handoff code: 730." },
			]);
		} finally {
			await session.dispose();
		}
	});

	test("projecting an ordinary fork does not visit the content blocks of user messages (#5481)", () => {
		let reads = 0;
		const content = Array.from({ length: 1024 }, () => ({
			get type() {
				reads++;
				return "text" as const;
			},
			text: "a",
		}));
		const messages = Array.from({ length: 128 }, () => [
			{ role: "user", content, timestamp: 1 },
			parentTurn([{ type: "text", text: "OK" }]),
		]).flat();
		assert.equal(stripParentOnlySubagentMessages(messages), messages);
		assert.equal(reads, 0);
	});

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
			const same = await childFirstRequest(session);
			assert.deepEqual(assistantTurns(same), [
				[
					{ type: "thinking", thinking: "Now list the files.", signature: "sig-list" },
					{ type: "redacted_thinking", data: "opaque-list" },
					tool,
				],
			]);
			assert.doesNotMatch(JSON.stringify(same), /Launched reviewer/);
			const other = getModel("anthropic", "claude-opus-5-5") as Model<"anthropic-messages">;
			assert.deepEqual(assistantTurns(await childFirstRequest(session, other)), [[tool]]);

			// Once the child has answered, this is no longer its latest assistant turn.
			await session.sessionManager.appendMessage(parentTurn([{ type: "text", text: "Child answer." }]));
			session.refreshContext();
			assert.deepEqual(assistantTurns(await childFirstRequest(session))[0], [
				{ type: "thinking", thinking: "Launch a reviewer first.", signature: "sig-launch" },
			]);
		} finally {
			await session.dispose();
		}
		// Child policy alone does not make a session a fork.
		const fresh = await createChildSession({}, parent);
		try {
			assert.deepEqual(assistantTurns(await childFirstRequest(fresh))[0], [
				{ type: "thinking", thinking: "Launch a reviewer first.", signature: "sig-launch" },
			]);
		} finally {
			await fresh.dispose();
		}
	});

	test("a removed parent-only notice never changes a turn with both thinking and text (#5481)", async () => {
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
			const request = await childFirstRequest(session);

			assert.doesNotMatch(JSON.stringify(request), /Earlier parent notice|The reviewer finished/);
			assert.deepEqual(assistantTurns(request), [
				[{ type: "thinking", thinking: "Start here.", signature: "sig-first" }],
				[
					{ type: "thinking", thinking: "Summarize the status.", signature: "sig-status" },
					{ type: "text", text: "Waiting on the reviewer." },
				],
				[
					{ type: "thinking", thinking: "Read the review.", signature: "sig-review" },
					{ type: "tool_use", id: "toolu_cat", name: "bash", input: { command: "cat review.md" } },
				],
			]);
		} finally {
			session.dispose();
		}
	});

	test("omitting a thinking-only turn leaves the complete turn before it alone (#5481)", async () => {
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
			const request = await childFirstRequest(session);

			assert.deepEqual(assistantTurns(request), [
				[
					{ type: "thinking", thinking: "Report first.", signature: "sig-report" },
					{ type: "text", text: "Two tests fail." },
				],
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
