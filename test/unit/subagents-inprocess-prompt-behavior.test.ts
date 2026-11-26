import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@bastani/atomic-agent-core";
import { normalizeContext } from "@bastani/atomic-ai";
import type { Message, Model } from "@bastani/atomic-ai/compat";
import { afterEach, describe, test, vi } from "vitest";
import { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import {
	createExtensionRuntime,
	loadExtensionFromFactory,
} from "../../packages/coding-agent/src/core/extensions/loader.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import {
	CHILD_FANOUT_BOUNDARY_INSTRUCTIONS,
	CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
	createInProcessChildPromptBehavior,
	createInProcessChildSystemPromptTransform,
	stripParentOnlySubagentMessages,
} from "../../packages/subagents/src/runs/inprocess/prompt-behavior.js";
import { createForkContextResolver } from "../../packages/subagents/src/shared/fork-context.js";
import { getFixtureModel } from "../helpers/catalog-model-fixtures.ts";
import {
	assistantTurns,
	childFirstRequest,
	cleanupTempDirs,
	copilotOpus,
	createChildSession,
	forkChild,
	forkParent,
	parentToolResult,
	parentTurn,
	policy,
	replyStream,
	resourceLoader,
	responsesModel,
	tempDirs,
	testModelRuntime,
	zeroUsage,
} from "./subagents-inprocess-prompt-behavior-helpers.js";

afterEach(cleanupTempDirs);

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

describe("child context refresh (#5481)", () => {
	test("a non-fork child does not require routing to be bound at construction (#5481)", async () => {
		const manager = forkParent();
		await manager.appendCustomMessageEntry("subagent-notify", "Worker finished.", true);
		let bound = false;
		const model = new Proxy(copilotOpus, {
			get(target, key, receiver) {
				if (key === "fastRoute" && !bound) throw new Error("routing is not bound");
				return Reflect.get(target, key, receiver);
			},
		});
		const session = await createChildSession({}, manager, {
			model,
			modelRuntime: await testModelRuntime(copilotOpus),
		});
		try {
			bound = true;
			assert.equal(assistantTurns(await childFirstRequest(session, model)).length, 0);
		} finally {
			await session.dispose();
		}
	});

	test("an ordinary AgentSession does not ask its host for an internal fork hook (#5481)", async () => {
		const manager = forkParent();
		const session = new AgentSession(
			new Proxy(
				{
					agent: new Agent({
						initialState: { model: copilotOpus },
						streamFn: () => replyStream(parentTurn([{ type: "text", text: "OK" }])),
					}),
					sessionManager: manager,
					settingsManager: SettingsManager.inMemory(),
					modelRuntime: await testModelRuntime(copilotOpus),
					cwd: manager.getCwd(),
					resourceLoader: resourceLoader(),
				},
				{
					get(target, key, receiver) {
						if (key === "requestContextProjectionTransform") throw new Error("Unknown session option");
						return Reflect.get(target, key, receiver);
					},
				},
			),
		);
		try {
			await session.prompt("Reply OK.");
			const reply = session.messages.at(-1);
			assert.ok(reply?.role === "assistant");
			assert.deepEqual(reply.content, [{ type: "text", text: "OK" }]);
		} finally {
			await session.dispose();
		}
	});

	test("a child history filter remains safe to map over batches (#5481)", () => {
		const answer = parentTurn([{ type: "text", text: "Done." }]);
		const batch: AgentMessage[] = [
			answer,
			{
				role: "custom",
				customType: "subagent-notify",
				content: "Finished.",
				details: {},
				display: true,
				timestamp: 1,
			},
		];
		const { initialContextTransform } = createInProcessChildPromptBehavior(policy());
		assert.ok(initialContextTransform);
		assert.deepEqual([batch, batch].map(initialContextTransform), [[answer], [answer]]);
	});

	test("a fork does not enable a custom history filter's optional fanout argument (#5481)", async () => {
		const parent = forkParent();
		await parent.appendMessage(
			parentTurn([{ type: "toolCall", id: "parent_call", name: "subagent", arguments: {} }]),
		);
		await parent.appendMessage(parentToolResult("parent_call", "subagent", "Parent-only result."));
		const child = await createForkContextResolver(parent, "fork").sessionManagerForIndex(0);
		const session = await createChildSession({}, child, {
			initialContextTransform(this: { sessionManager: SessionManager }, messages, preserveFanoutHistory = false) {
				assert.equal(this.sessionManager.getSessionId(), child!.getSessionId());
				return stripParentOnlySubagentMessages(messages, preserveFanoutHistory);
			},
		});
		try {
			assert.ok(
				!session.messages.some((message) => message.role === "toolResult" && message.toolName === "subagent"),
			);
			session.refreshContext();
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
			(atomic) => {
				atomic.on("turn_end", ({ message }) => {
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
		const model = { ...getFixtureModel("anthropic", "claude-sonnet-4-5")!, promptCache: { short: 60, long: 60 } };
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

	test("preparing a plain Responses fork does not index historical answers on each request (#5481)", async () => {
		const parent = forkParent();
		const model = responsesModel;
		for (let index = 0; index < 32; index++) {
			await parent.appendMessage({
				...parentTurn([{ type: "text", text: `Answer ${index}` }]),
				model: model.id,
				provider: model.provider,
				api: model.api,
			});
			await parent.appendCustomMessageEntry("subagent-notify", "Worker finished.", true);
		}
		const child = await createForkContextResolver(parent, "fork").sessionManagerForIndex(0);
		const session = await createChildSession({}, child, { model });
		try {
			for (let repeat = 0; repeat < 2; repeat++) {
				const inserts = vi.spyOn(WeakSet.prototype, "add");
				try {
					const prepared = await session.agent.prepareRequest!({
						model,
						thinkingLevel: "off",
						context: { tools: [], messages: session.messages },
					});
					assert.equal(prepared?.context?.messages.length, 32);
					assert.equal(inserts.mock.calls.filter(([key]) => (key as AgentMessage).role === "assistant").length, 0);
				} finally {
					inserts.mockRestore();
				}
			}
		} finally {
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
			const model = responsesModel;
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
			const other = getFixtureModel("anthropic", "claude-opus-5-5") as Model<"anthropic-messages">;
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
