import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { describe, test } from "vitest";
import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	ExecOptions,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
	ToolCallEvent,
	ToolCallEventResult,
	ToolDefinition,
	ToolResultEvent,
	ToolResultEventResult,
} from "../src/core/extensions/index.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import feedbackExtension, {
	buildFeedbackTurnMessage,
	collectFeedbackSessionFacts,
	createFeedbackExtension,
	FEEDBACK_USAGE,
} from "../src/extensions/feedback/index.ts";
import { createGitHubFeedbackPostHandler } from "../src/extensions/feedback/posting.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { createHarness, getMessageText } from "./suite/harness.ts";

type FeedbackToolCallHandler = (
	event: ToolCallEvent,
	ctx: ExtensionContext,
) => Promise<ToolCallEventResult | undefined> | ToolCallEventResult | undefined;
type FeedbackToolResultHandler = (
	event: ToolResultEvent,
	ctx: ExtensionContext,
) => Promise<ToolResultEventResult | undefined> | ToolResultEventResult | undefined;
type FeedbackAgentEndHandler = (event: AgentEndEvent, ctx: ExtensionContext) => Promise<void> | void;
type FeedbackBeforeAgentStartHandler = (event: BeforeAgentStartEvent, ctx: ExtensionContext) => Promise<void> | void;

function registerFeedback(
	activeTools: string[] = ["subagent"],
	extension: (pi: ExtensionAPI) => void = feedbackExtension,
): {
	command: Omit<RegisteredCommand, "name" | "sourceInfo">;
	tool: ToolDefinition;
	sent: Array<string | object[]>;
	toolCallHandlers: FeedbackToolCallHandler[];
	toolResultHandlers: FeedbackToolResultHandler[];
	beforeAgentStartHandlers: FeedbackBeforeAgentStartHandler[];
	agentEndHandlers: FeedbackAgentEndHandler[];
} {
	let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
	let tool: ToolDefinition | undefined;
	const sent: Array<string | object[]> = [];
	const toolCallHandlers: FeedbackToolCallHandler[] = [];
	const toolResultHandlers: FeedbackToolResultHandler[] = [];
	const beforeAgentStartHandlers: FeedbackBeforeAgentStartHandler[] = [];
	const agentEndHandlers: FeedbackAgentEndHandler[] = [];
	const pi = {
		registerTool: (definition: ToolDefinition) => {
			assert.equal(definition.name, "submit_feedback");
			tool = definition;
		},
		registerCommand: (name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			assert.equal(name, "feedback");
			command = options;
		},
		sendUserMessage: (content: string | object[]) => {
			sent.push(content);
		},
		getActiveTools: () => activeTools,
		exec: async (_command: string, _args: string[], _options?: ExecOptions) => ({
			stdout: "",
			stderr: "",
			code: 0,
			killed: false,
		}),
		on: ((
			eventName: string,
			handler:
				| FeedbackToolCallHandler
				| FeedbackToolResultHandler
				| FeedbackBeforeAgentStartHandler
				| FeedbackAgentEndHandler,
		) => {
			if (eventName === "tool_call") toolCallHandlers.push(handler as FeedbackToolCallHandler);
			if (eventName === "tool_result") toolResultHandlers.push(handler as FeedbackToolResultHandler);
			if (eventName === "before_agent_start") {
				beforeAgentStartHandlers.push(handler as FeedbackBeforeAgentStartHandler);
			}
			if (eventName === "agent_end") agentEndHandlers.push(handler as FeedbackAgentEndHandler);
		}) as ExtensionAPI["on"],
	} as ExtensionAPI;
	extension(pi);
	assert.ok(command);
	assert.ok(tool);
	return { command, tool, sent, toolCallHandlers, toolResultHandlers, beforeAgentStartHandlers, agentEndHandlers };
}

function commandContext(overrides: Partial<ExtensionCommandContext> = {}): ExtensionCommandContext {
	return {
		cwd: process.cwd(),
		mode: "tui",
		hasUI: true,
		hasNonBuiltinExtensions: false,
		model: {
			provider: "anthropic",
			id: "claude-sonnet-4-5",
		} as ExtensionCommandContext["model"],
		sessionManager: {
			getEntries: () => [],
		} as ExtensionCommandContext["sessionManager"],
		ui: {
			notify: () => {},
		} as ExtensionCommandContext["ui"],
		...overrides,
	} as ExtensionCommandContext;
}
function feedbackInteractionContext(inputsByView: readonly (readonly string[])[]): ExtensionContext {
	let view = 0;
	return {
		mode: "tui",
		hasUI: true,
		ui: {
			custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) =>
				await new Promise((resolve) => {
					const component = factory(
						{ requestRender: () => {} } as never,
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
						{} as never,
						resolve,
					);
					for (const input of inputsByView[view] ?? []) component.handleInput?.(input);
					view += 1;
				}),
			notify: () => {},
			setEditorText: () => {},
		} as ExtensionContext["ui"],
	} as ExtensionContext;
}

describe("built-in /feedback command", () => {
	test("advertises the required prompt", () => {
		const command = BUILTIN_SLASH_COMMANDS.find((candidate) => candidate.name === "feedback");
		assert.deepEqual(command, {
			name: "feedback",
			description: "Draft and review an Atomic bug report or enhancement",
			argumentHint: "<what happened or what you would like changed>",
		});
		const extension = builtInExtensions.find(
			(candidate) => typeof candidate !== "function" && candidate.name === "feedback",
		);
		assert.ok(extension && typeof extension !== "function");
		assert.equal(extension.factory, feedbackExtension);
		assert.equal(extension.bundled, true);
		assert.equal(extension.hidden, true);
	});

	test("loads through the complete built-in extension catalog", async () => {
		const harness = await createHarness({ extensionFactories: builtInExtensions });
		try {
			const command = harness.session.extensionRunner
				.getRegisteredCommands()
				.find((candidate) => candidate.invocationName === "feedback");
			assert.ok(command);
			assert.equal(command.description, "Draft and review an Atomic bug report or enhancement");
		} finally {
			harness.cleanup();
		}
	});

	test("shows usage without starting work when the prompt is absent", async () => {
		for (const args of ["", " ", "\t\n"]) {
			const { command, sent } = registerFeedback();
			const notifications: string[] = [];
			await command.handler(
				args,
				commandContext({
					ui: {
						notify: (message: string) => notifications.push(message),
					} as ExtensionCommandContext["ui"],
				}),
			);
			assert.deepEqual(notifications, [FEEDBACK_USAGE]);
			assert.deepEqual(sent, []);
		}
	});

	test("starts exactly one ordinary model turn and preserves the report verbatim", async () => {
		const { command, sent } = registerFeedback();
		const prompt = "  build fails\nwith punctuation: [] and  two spaces  ";

		await command.handler(prompt, commandContext());

		assert.equal(sent.length, 1);
		assert.equal(typeof sent[0], "string");
		assert.ok((sent[0] as string).endsWith(prompt));
		assert.match(sent[0] as string, /one ordinary in-session model turn/i);
		assert.match(sent[0] as string, /exactly one foreground.*debugger/i);
		assert.match(sent[0] as string, /enhancement.*do not launch the debugger/i);
		assert.match(sent[0] as string, /Do not launch a workflow/i);
	});

	test("gives the model one exact classification and clarification contract", () => {
		for (const prompt of ["Atomic crashes after paste", "Please add a keyboard shortcut", "The editor feels wrong"]) {
			const message = buildFeedbackTurnMessage(prompt, collectFeedbackSessionFacts(commandContext()));
			assert.match(message, /Classify it as a bug or enhancement\./u);
			assert.equal(message.match(/Ask one concise clarification/gu)?.length, 1);
			assert.match(message, /only if classification or a required issue field is genuinely unresolved/u);
			assert.match(message, /For a bug, launch exactly one foreground run of the existing bundled debugger/u);
			assert.match(message, /For an enhancement, do not launch the debugger/u);
			assert.match(message, /Do not launch a workflow, create or customize an agent, start a repair loop/u);
			assert.ok(message.endsWith(prompt));
		}
	});

	test("permits only truthful sanitized textual reconstruction for visual reports", () => {
		const message = buildFeedbackTurnMessage("the layout is wrong", collectFeedbackSessionFacts(commandContext()));
		assert.match(message, /clearly labelled sanitized textual reconstruction/u);
		assert.match(message, /expected-versus-observed/u);
		assert.match(message, /never claim.*captured screenshot|never present.*captured evidence/u);
		assert.match(
			message,
			/Do not attach.*transcript.*raw trace.*environment dump.*repository file.*screenshot.*artifact/u,
		);
	});

	test("hard-blocks every parent tool except submission and the one admitted debugger", async () => {
		const { command, toolCallHandlers } = registerFeedback();
		const context = commandContext();
		await command.handler("hard boundary report", context);

		for (const [toolName, input] of [
			["workflow", { action: "run", workflow: "repair" }],
			["bash", { command: "gh issue create --title bypass" }],
			["write", { path: "mutated.txt", content: "bypass" }],
			["edit", { path: "existing.txt", oldText: "a", newText: "b" }],
			["read", { path: "private.txt" }],
			["intercom", { action: "list" }],
		] as const) {
			const blocked = await toolCallHandlers[0]?.(
				{ type: "tool_call", toolCallId: `blocked-${toolName}`, toolName, input },
				context,
			);
			assert.equal(blocked?.block, true, toolName);
			assert.match(blocked?.reason ?? "", /Only submit_feedback and the admitted foreground debugger/u);
		}

		assert.equal(
			await toolCallHandlers[0]?.(
				{ type: "tool_call", toolCallId: "submit", toolName: "submit_feedback", input: {} },
				context,
			),
			undefined,
		);
		assert.equal(
			await toolCallHandlers[0]?.(
				{ type: "tool_call", toolCallId: "debugger", toolName: "subagent", input: { agent: "debugger" } },
				context,
			),
			undefined,
		);
	});

	test("guards the existing subagent tool as one foreground debugger handoff", async () => {
		const { command, toolCallHandlers, toolResultHandlers } = registerFeedback();
		const context = commandContext();
		await command.handler("exact bug report", context);
		assert.equal(toolCallHandlers.length, 1);
		assert.equal(toolResultHandlers.length, 1);

		const input: Record<string, unknown> = {
			agent: "debugger",
			task: "model-supplied task",
			model: "model override",
			worktree: true,
		};
		const first = await toolCallHandlers[0]?.(
			{ type: "tool_call", toolCallId: "debug-1", toolName: "subagent", input },
			context,
		);
		assert.equal(first, undefined);
		assert.equal(input.agent, "debugger");
		assert.equal("model" in input, false);
		assert.equal("worktree" in input, false);
		assert.ok((input.task as string).endsWith("exact bug report"));

		const duplicate = await toolCallHandlers[0]?.(
			{ type: "tool_call", toolCallId: "debug-2", toolName: "subagent", input: { agent: "debugger" } },
			context,
		);
		assert.equal(duplicate?.block, true);
		const toolResult = await toolResultHandlers[0]?.(
			{
				type: "tool_result",
				toolCallId: "debug-1",
				toolName: "subagent",
				input,
				content: [{ type: "text", text: "supported findings" }],
				isError: false,
				details: undefined,
			},
			context,
		);
		assert.match(
			toolResult?.content?.at(-1)?.type === "text" ? toolResult.content.at(-1)!.text : "",
			/Working-tree disclosure/,
		);
	});

	test("accepts the live call/result sequence after a blocked subagent inventory probe", async () => {
		const { command, tool, toolCallHandlers, toolResultHandlers, agentEndHandlers } = registerFeedback();
		const context = commandContext();
		await command.handler("live bug report", context);

		const inventoryCallId = "call_ew8BtDqU8TDscUfJPXBpi5Vq|fc_0972a163c7b97135016a972432936c87d0becb273c649fdc9d";
		const debuggerCallId = "call_d73GDDsgh78OB21JWPWGAbnj|fc_0972a163c7b97135016a972435436487d0bcd36bef33e57dad";
		const inventoryInput = { action: "list" };
		const inventoryBlock = await toolCallHandlers[0]?.(
			{ type: "tool_call", toolCallId: inventoryCallId, toolName: "subagent", input: inventoryInput },
			context,
		);
		assert.deepEqual(inventoryBlock, {
			block: true,
			reason: "Feedback investigation must use one foreground execution of the existing bundled debugger.",
		});

		const debuggerInput: Record<string, unknown> = {
			agent: "debugger",
			task: "Investigate only",
		};
		assert.equal(
			await toolCallHandlers[0]?.(
				{ type: "tool_call", toolCallId: debuggerCallId, toolName: "subagent", input: debuggerInput },
				context,
			),
			undefined,
		);
		assert.equal(debuggerInput.agent, "debugger");
		assert.ok((debuggerInput.task as string).endsWith("live bug report"));
		const debuggerResult = await toolResultHandlers[0]?.(
			{
				type: "tool_result",
				toolCallId: debuggerCallId,
				toolName: "subagent",
				input: debuggerInput,
				content: [{ type: "text", text: "Delivered single subagent result via intercom." }],
				isError: false,
				details: {
					mode: "single",
					runId: "7ac81f7c",
					results: [
						{
							agent: "debugger",
							status: "ok",
							path: "7ac81f7c/debugger_1",
							artifactPaths: {
								outputPath: "/tmp/atomic-2799-e2e/sessions/subagent-artifacts/7ac81f7c_debugger_0_output.md",
							},
						},
					],
					parentAskYielded: false,
				},
			},
			context,
		);
		assert.match(
			debuggerResult?.content?.map((part) => (part.type === "text" ? part.text : "")).join("\n") ?? "",
			/Delivered single subagent result.*Working-tree disclosure/su,
		);

		const submission = await tool.execute(
			"call_T5EMqZS02UDwABaApT0jgcmN|fc_0972a163c7b97135016a9724a95c8087d08890af1e29efd44b",
			{
				kind: "bug",
				title: "Live debugger gate regression",
				whatHappened: "The completed foreground debugger must satisfy the gate.",
				stepsToReproduce: "Run one foreground debugger, then submit feedback.",
				expectedBehavior: "The submission reaches privacy review.",
				version: "1.2.3-alpha.4",
				nonBuiltinExtensionState: "inactive",
				extensionFreeReproduction: "unknown",
			},
			undefined,
			undefined,
			{ mode: "json", hasUI: false, ui: {} } as ExtensionContext,
		);
		assert.equal(submission.details?.status, "retained");

		await agentEndHandlers[0]?.(
			{ type: "agent_end", messages: [fauxAssistantMessage("submission retained")] },
			context,
		);
		await assert.rejects(
			tool.execute(
				"late-submit",
				{
					kind: "enhancement",
					title: "Stale",
					whatToChange: "Must not survive the turn",
					why: "The prior request ended",
				},
				undefined,
				undefined,
				{ mode: "json", hasUI: false, ui: {} } as ExtensionContext,
			),
			/No active \/feedback request is available for submission\./u,
		);
	});

	test("does not rewrite or accept a result from a non-admitted subagent call", async () => {
		const { command, tool, toolCallHandlers, toolResultHandlers } = registerFeedback();
		const context = commandContext();
		await command.handler("result correlation bug", context);
		const input: Record<string, unknown> = { agent: "debugger" };
		await toolCallHandlers[0]?.(
			{ type: "tool_call", toolCallId: "admitted-debugger", toolName: "subagent", input },
			context,
		);

		assert.equal(
			await toolResultHandlers[0]?.(
				{
					type: "tool_result",
					toolCallId: "other-subagent",
					toolName: "subagent",
					input: { agent: "worker" },
					content: [{ type: "text", text: "unrelated result" }],
					isError: false,
					details: {},
				},
				context,
			),
			undefined,
		);
		await assert.rejects(
			tool.execute(
				"premature-submit",
				{
					kind: "bug",
					title: "Result correlation",
					whatHappened: "An unrelated result must not satisfy the debugger gate.",
					stepsToReproduce: "Return a different subagent result ID.",
					nonBuiltinExtensionState: "inactive",
					extensionFreeReproduction: "unknown",
				},
				undefined,
				undefined,
				{ mode: "json", hasUI: false, ui: {} } as ExtensionContext,
			),
			/Feedback cannot continue while debugger investigation is active\./u,
		);

		await toolResultHandlers[0]?.(
			{
				type: "tool_result",
				toolCallId: "admitted-debugger",
				toolName: "subagent",
				input,
				content: [{ type: "text", text: "matching result" }],
				isError: false,
				details: {},
			},
			context,
		);
		const accepted = await tool.execute(
			"accepted-submit",
			{
				kind: "bug",
				title: "Result correlation",
				whatHappened: "The matching result satisfies the debugger gate.",
				stepsToReproduce: "Return the admitted subagent result ID.",
				nonBuiltinExtensionState: "inactive",
				extensionFreeReproduction: "unknown",
			},
			undefined,
			undefined,
			{ mode: "json", hasUI: false, ui: {} } as ExtensionContext,
		);
		assert.equal(accepted.details?.status, "retained");
	});

	test("replaces debugger failure with the honest marker and preserves the original report", async () => {
		const { command, sent, toolCallHandlers, toolResultHandlers } = registerFeedback();
		const context = commandContext();
		const prompt = " raw failure report ";
		await command.handler(prompt, context);
		const input: Record<string, unknown> = { agent: "debugger" };
		await toolCallHandlers[0]?.(
			{ type: "tool_call", toolCallId: "failed-debug", toolName: "subagent", input },
			context,
		);
		const failed = await toolResultHandlers[0]?.(
			{
				type: "tool_result",
				toolCallId: "failed-debug",
				toolName: "subagent",
				input,
				content: [{ type: "text", text: "unsupported diagnosis and raw failure" }],
				isError: true,
				details: undefined,
			},
			context,
		);
		const text = failed?.content?.map((part) => (part.type === "text" ? part.text : "")).join("\n") ?? "";
		assert.match(text, /^Investigation unavailable/);
		assert.doesNotMatch(text, /unsupported diagnosis|raw failure/);
		assert.ok((sent[0] as string).endsWith(prompt));
	});

	test("tells the model to retain an honest draft when the debugger tool is disabled", async () => {
		const { command, sent } = registerFeedback([]);
		await command.handler("bug while subagents are disabled", commandContext());
		assert.match(sent[0] as string, /Investigation unavailable/);
	});

	test("preserves exactly one clarification continuation, consumes it, and then clears", async () => {
		const { command, tool, beforeAgentStartHandlers, agentEndHandlers } = registerFeedback();
		const context = commandContext();
		await command.handler("ambiguous feedback", context);
		assert.equal(beforeAgentStartHandlers.length, 1);
		assert.equal(agentEndHandlers.length, 1);

		await agentEndHandlers[0]?.(
			{ type: "agent_end", messages: [fauxAssistantMessage("Is this a bug or enhancement?")] },
			context,
		);
		await beforeAgentStartHandlers[0]?.(
			{
				type: "before_agent_start",
				prompt: "It is an enhancement",
				images: undefined,
				systemPrompt: "",
				systemPromptOptions: {} as never,
			},
			context,
		);
		const submitted = await tool.execute(
			"clarified-submit",
			{
				kind: "enhancement",
				title: "Clarified enhancement",
				whatToChange: "Add the requested behavior.",
				why: "The clarification identifies it as an enhancement.",
			},
			undefined,
			undefined,
			{ mode: "json", hasUI: false, ui: {} } as ExtensionContext,
		);
		assert.equal(submitted.details?.status, "retained");

		await assert.rejects(
			tool.execute(
				"late-submit",
				{
					kind: "enhancement",
					title: "Stale",
					whatToChange: "Must not survive",
					why: "The clarification was consumed",
				},
				undefined,
				undefined,
				{ mode: "json", hasUI: false, ui: {} } as ExtensionContext,
			),
			/No active \/feedback request is available for submission\./u,
		);

		const second = registerFeedback();
		await second.command.handler("another ambiguous report", context);
		await second.agentEndHandlers[0]?.(
			{ type: "agent_end", messages: [fauxAssistantMessage("Please clarify")] },
			context,
		);
		await second.beforeAgentStartHandlers[0]?.(
			{
				type: "before_agent_start",
				prompt: "clarification",
				images: undefined,
				systemPrompt: "",
				systemPromptOptions: {} as never,
			},
			context,
		);
		await second.agentEndHandlers[0]?.(
			{ type: "agent_end", messages: [fauxAssistantMessage("Did not submit")] },
			context,
		);
		assert.equal(
			await second.toolCallHandlers[0]?.(
				{ type: "tool_call", toolCallId: "unrelated", toolName: "bash", input: { command: "pwd" } },
				context,
			),
			undefined,
		);
	});

	test("retains the same uncertain request through agent turns until reconciliation finds it", async () => {
		// #2799: Cancel dismisses uncertain failure UI without clearing the active request or controller.
		let posts = 0;
		let gets = 0;
		let labels = 0;
		const postedBodies: string[] = [];
		const post = createGitHubFeedbackPostHandler({
			env: { GH_TOKEN: "synthetic-token" },
			exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
			fetch: async (input, init) => {
				if (String(input).endsWith("/issues") && init?.method === "POST") {
					posts += 1;
					postedBodies.push(String(init.body));
					return new Response(null, { status: 500 });
				}
				if (init?.method === "POST") {
					labels += 1;
					return new Response(null, { status: 200 });
				}
				gets += 1;
				if (gets === 1) return new Response(null, { status: 503 });
				const firstDraft = JSON.parse(postedBodies[0] ?? "{}") as { body?: string };
				return new Response(
					JSON.stringify([
						{
							html_url: "https://github.com/bastani-inc/atomic/issues/999988",
							body: firstDraft.body,
						},
					]),
					{ status: 200 },
				);
			},
		});
		const registered = registerFeedback(
			["subagent"],
			createFeedbackExtension({ post, createRequestId: () => "turn-stable-request" }),
		);
		const context = commandContext();
		await registered.command.handler("retain this exact enhancement", context);
		const retained = await registered.tool.execute(
			"initial-submit",
			{
				kind: "enhancement",
				title: "Stable retained title",
				whatToChange: "Keep this exact body.",
				why: "Retry must not regenerate it.",
			},
			undefined,
			undefined,
			feedbackInteractionContext([["\x1b[B", "\r"], ["\x1b"]]),
		);
		assert.equal(retained.details?.status, "retained");
		assert.equal(retained.details?.requestId, "turn-stable-request");
		assert.equal(retained.details?.uncertain, true);

		const startNextTurn = async (turn: number): Promise<void> => {
			await registered.agentEndHandlers[0]?.(
				{ type: "agent_end", messages: [fauxAssistantMessage("uncertain request retained")] },
				context,
			);
			const blocked = await registered.toolCallHandlers[0]?.(
				{ type: "tool_call", toolCallId: `blocked-${turn}`, toolName: "bash", input: { command: "pwd" } },
				context,
			);
			assert.equal(blocked?.block, true);
			await registered.beforeAgentStartHandlers[0]?.(
				{
					type: "before_agent_start",
					prompt: "Retry",
					images: undefined,
					systemPrompt: "",
					systemPromptOptions: {} as never,
				},
				context,
			);
		};

		await startNextTurn(1);
		const stillUncertain = await registered.tool.execute(
			"retry-unavailable",
			{
				kind: "enhancement",
				title: "Replacement title must be ignored",
				whatToChange: "Replacement body must be ignored.",
				why: "The retained controller owns Retry.",
			},
			undefined,
			undefined,
			feedbackInteractionContext([["\r"], ["\x1b"]]),
		);
		assert.equal(stillUncertain.details?.status, "retained");
		assert.equal(stillUncertain.details?.requestId, "turn-stable-request");
		assert.equal(stillUncertain.details?.uncertain, true);
		assert.equal(posts, 1);

		await startNextTurn(2);
		const posted = await registered.tool.execute(
			"retry-found",
			{
				kind: "enhancement",
				title: "Another ignored replacement",
				whatToChange: "Do not replace the retained body.",
				why: "Retry must reconcile the existing request.",
			},
			undefined,
			undefined,
			feedbackInteractionContext([["\r"]]),
		);
		assert.equal(posted.details?.status, "posted");
		assert.equal(posted.details?.requestId, "turn-stable-request");
		assert.equal(posts, 1);
		assert.equal(gets, 2);
		assert.equal(labels, 1);
		const submitted = JSON.parse(postedBodies[0] ?? "{}") as { title?: string; body?: string };
		assert.equal(submitted.title, "Stable retained title");
		assert.match(submitted.body ?? "", /atomic-feedback-request:turn-stable-request/u);
		assert.equal(
			await registered.toolCallHandlers[0]?.(
				{ type: "tool_call", toolCallId: "after-terminal", toolName: "bash", input: { command: "pwd" } },
				context,
			),
			undefined,
		);
	});
	test("clears interrupted, cancelled, and error turns without reviving their request", async () => {
		for (const messages of [
			[{ ...fauxAssistantMessage(""), stopReason: "aborted" as const }],
			[],
			[{ ...fauxAssistantMessage(""), stopReason: "error" as const }],
		]) {
			const { command, tool, toolCallHandlers, agentEndHandlers } = registerFeedback();
			const context = commandContext({
				ui: { notify: () => {}, select: async () => undefined } as ExtensionCommandContext["ui"],
			});
			await command.handler("request that ends before submission", context);
			await agentEndHandlers[0]?.({ type: "agent_end", messages }, context);

			assert.equal(
				await toolCallHandlers[0]?.(
					{ type: "tool_call", toolCallId: "unrelated", toolName: "subagent", input: { agent: "worker" } },
					context,
				),
				undefined,
			);
			await assert.rejects(
				tool.execute(
					"late-submit",
					{
						kind: "enhancement",
						title: "Unrelated",
						whatToChange: "Must not revive stale request",
						why: "The old turn ended",
					},
					undefined,
					undefined,
					{ mode: "json", hasUI: false, ui: {} } as ExtensionContext,
				),
				/No active \/feedback request is available for submission\./u,
			);
		}
	});

	test("dispatches through the session as one normal model turn", async () => {
		const harness = await createHarness({ extensionFactories: [feedbackExtension] });
		const errors: string[] = [];
		const unsubscribe = harness.session.extensionRunner.onError((error) => errors.push(error.error));
		const turnEnded = new Promise<void>((resolve) => {
			const stop = harness.session.subscribe((event) => {
				if (event.type !== "agent_end") return;
				stop();
				resolve();
			});
		});
		try {
			harness.setResponses([fauxAssistantMessage("drafted")]);

			await harness.session.prompt("/feedback exact raw report");
			await turnEnded;

			assert.deepEqual(errors, []);
			assert.deepEqual(
				harness.session.messages.map((message) => message.role),
				["user", "assistant"],
			);
			assert.ok(getMessageText(harness.session.messages[0]).endsWith("exact raw report"));
			assert.equal(getMessageText(harness.session.messages[1]), "drafted");
			assert.equal(harness.getPendingResponseCount(), 0);
		} finally {
			unsubscribe();
			harness.cleanup();
		}
	});

	test("seeds only safe current-session facts and summarizes failures without their output", () => {
		const secret = "synthetic-secret-must-not-appear";
		const context = commandContext({
			mode: "rpc",
			hasNonBuiltinExtensions: true,
			sessionManager: {
				getEntries: () =>
					[
						{
							type: "message",
							message: {
								role: "toolResult",
								toolCallId: "call-1",
								toolName: "bash",
								content: [{ type: "text", text: `failed with ${secret}` }],
								isError: true,
								timestamp: 1,
							},
						},
						{
							type: "message",
							message: {
								role: "assistant",
								content: [],
								api: "anthropic-messages",
								provider: "anthropic",
								model: "claude-sonnet-4-5",
								usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
								stopReason: "error",
								errorMessage: secret,
								timestamp: 2,
							},
						},
					] as ReturnType<ExtensionCommandContext["sessionManager"]["getEntries"]>,
			} as ExtensionCommandContext["sessionManager"],
		});

		const facts = collectFeedbackSessionFacts(context, {
			version: "1.2.3-alpha.4",
			platform: "darwin",
			architecture: "arm64",
			runtime: "Bun 1.4.0",
		});
		const message = buildFeedbackTurnMessage("keep me exact", facts);

		assert.deepEqual(facts, {
			version: "1.2.3-alpha.4",
			platform: "darwin",
			architecture: "arm64",

			runtime: "Bun 1.4.0",
			mode: "rpc",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			nonBuiltinExtensionsLoaded: true,
			recentFailedOutcomes: ["Tool bash failed", "Provider response failed"],
			sessionErrorState: "present",
		});
		assert.doesNotMatch(message, new RegExp(secret));
		assert.doesNotMatch(message, /process\.env|Authorization/i);
		assert.ok(message.endsWith("keep me exact"));
	});

	test("cancels model-unavailable classification without previewing or posting", async () => {
		let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
		let previews = 0;
		let posts = 0;
		const pi = {
			registerTool: () => {},
			registerCommand: (_name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
				command = options;
			},
			sendUserMessage: async () => {
				throw new Error("synthetic model admission failure");
			},
			getActiveTools: () => ["subagent"],
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
			on: () => {},
		} as ExtensionAPI;
		createFeedbackExtension({
			post: async () => {
				posts += 1;
				return { status: "failure", message: "must not post" };
			},
		})(pi);
		assert.ok(command);
		await command.handler(
			"ambiguous report",
			commandContext({
				ui: {
					notify: () => {},
					select: async () => undefined,
					custom: async () => {
						previews += 1;
						return undefined;
					},
				} as ExtensionCommandContext["ui"],
			}),
		);
		assert.equal(previews, 0);
		assert.equal(posts, 0);
	});

	test("falls back from model admission failure to an honest editable draft without posting", async () => {
		let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
		let posts = 0;
		const rendered: string[] = [];
		const notifications: string[] = [];
		const pi = {
			registerTool: () => {},
			registerCommand: (_name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
				command = options;
			},
			sendUserMessage: async () => {
				throw new Error("synthetic model admission failure");
			},
			getActiveTools: () => ["subagent"],
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
			on: () => {},
		} as ExtensionAPI;
		createFeedbackExtension({
			post: async () => {
				posts += 1;
				return { status: "failure", message: "must not post" };
			},
		})(pi);
		assert.ok(command);
		const prompt = "  raw model failure report  ";
		await command.handler(
			prompt,
			commandContext({
				ui: {
					notify: (message: string) => notifications.push(message),
					select: async () => "Bug",
					custom: async (factory) =>
						await new Promise((resolve) => {
							const component = factory(
								{ requestRender: () => {} } as never,
								{ fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
								{} as never,
								resolve,
							);
							rendered.push(...component.render(100));
							for (let page = 0; page < 20; page += 1) {
								component.handleInput?.("\x1b[6~");
								rendered.push(...component.render(100));
							}
							component.handleInput?.("\x1b");
						}),
					setEditorText: () => {},
				} as ExtensionCommandContext["ui"],
			}),
		);

		const output = rendered.join("\n");
		assert.match(output, /raw model failure report/);
		assert.match(output, /Drafting model unavailable/);
		assert.match(output, /Investigation unavailable/);
		assert.match(notifications.join("\n"), /selected model is unavailable/i);
		assert.equal(posts, 0);
	});

	test("routes a production binding admission rejection into the editable fallback", async () => {
		let fallbackSelections = 0;
		const harness = await createHarness({ extensionFactories: [createFeedbackExtension()] });
		try {
			const command = harness.session.extensionRunner
				.getRegisteredCommands()
				.find((candidate) => candidate.invocationName === "feedback");
			assert.ok(command);
			harness.session.sendUserMessage = async () => {
				throw new Error("synthetic production binding admission failure");
			};

			await command.handler(
				"production binding report",
				commandContext({
					cwd: harness.tempDir,
					ui: {
						notify: () => {},
						select: async () => {
							fallbackSelections += 1;
							return undefined;
						},
					} as ExtensionCommandContext["ui"],
				}),
			);

			assert.equal(fallbackSelections, 1);
		} finally {
			harness.cleanup();
		}
	});
	test("opens the same honest fallback when the admitted model turn ends in provider error", async () => {
		let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
		let agentEnd: ((event: AgentEndEvent, ctx: ExtensionContext) => Promise<void> | void) | undefined;
		const rendered: string[] = [];
		const ui = {
			notify: () => {},
			select: async () => "Enhancement",
			custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) =>
				await new Promise((resolve) => {
					const component = factory(
						{ requestRender: () => {} } as never,
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
						{} as never,
						resolve,
					);
					rendered.push(...component.render(100));
					for (let page = 0; page < 20; page += 1) {
						component.handleInput?.("\x1b[6~");
						rendered.push(...component.render(100));
					}
					component.handleInput?.("\x1b");
				}),
			setEditorText: () => {},
		} as ExtensionContext["ui"];
		const pi = {
			registerTool: () => {},
			registerCommand: (_name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
				command = options;
			},
			sendUserMessage: async () => {},
			getActiveTools: () => ["subagent"],
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
			on: ((eventName: string, handler: (event: AgentEndEvent, ctx: ExtensionContext) => Promise<void> | void) => {
				if (eventName === "agent_end") agentEnd = handler;
			}) as ExtensionAPI["on"],
		} as ExtensionAPI;
		createFeedbackExtension()(pi);
		assert.ok(command);
		await command.handler(" raw provider failure ", commandContext({ ui }));
		assert.ok(agentEnd);
		await agentEnd(
			{ type: "agent_end", messages: [{ ...fauxAssistantMessage(""), stopReason: "error" }] },
			commandContext({ ui }),
		);
		assert.match(rendered.join("\n"), /raw provider failure/);
		assert.match(rendered.join("\n"), /Drafting model unavailable/);
	});
});
