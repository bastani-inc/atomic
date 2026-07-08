import type { AgentEndEvent, AgentStartEvent, ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionHandler, MessageRenderer, ModelSelectEvent, RegisteredCommand, SessionShutdownEvent, SessionStartEvent, ToolDefinition, ToolExecutionEndEvent, ToolExecutionStartEvent, TurnEndEvent, TurnStartEvent } from "@bastani/atomic";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renderIntercomToolResult } from "./result-renderers.js";

type CapturedCommand = Omit<RegisteredCommand, "name" | "sourceInfo">;
type CapturedShortcut = Parameters<ExtensionAPI["registerShortcut"]>[1];
type EventHandler = Parameters<ExtensionAPI["events"]["on"]>[1];
type EventPayload = Parameters<EventHandler>[0];
type ToolRenderResultArgs = Parameters<NonNullable<ToolDefinition["renderResult"]>>;

type ForwardedEventMap = {
	session_start: SessionStartEvent;
	session_shutdown: SessionShutdownEvent;
	turn_start: TurnStartEvent;
	turn_end: TurnEndEvent;
	agent_start: AgentStartEvent;
	agent_end: AgentEndEvent;
	tool_execution_start: ToolExecutionStartEvent;
	tool_execution_end: ToolExecutionEndEvent;
	model_select: ModelSelectEvent;
};

type LazyLifecycleEvent = keyof ForwardedEventMap;
type ForwardedHandler<K extends LazyLifecycleEvent> = ExtensionHandler<ForwardedEventMap[K]>;
type ForwardedHandlerMap = { [K in LazyLifecycleEvent]: ForwardedHandler<K>[] };
type AnyForwardedHandler = { [K in LazyLifecycleEvent]: ForwardedHandler<K> }[LazyLifecycleEvent];

type CapturedHeavy = {
	tools: Map<string, ToolDefinition>;
	commands: Map<string, CapturedCommand>;
	handlers: ForwardedHandlerMap;
	shortcuts: Map<string, CapturedShortcut>;
	eventHandlers: Map<string, EventHandler[]>;
};

type LifecycleSnapshot<K extends LazyLifecycleEvent> = {
	event: ForwardedEventMap[K];
	ctx: ExtensionContext;
};

type SessionSnapshot = LifecycleSnapshot<"session_start"> & {
	generation: number;
};

type ActiveLifecycleState = {
	turnStart: LifecycleSnapshot<"turn_start"> | null;
	agentStart: LifecycleSnapshot<"agent_start"> | null;
	activeTools: Map<string, LifecycleSnapshot<"tool_execution_start">>;
	modelSelect: LifecycleSnapshot<"model_select"> | null;
};
const SUBAGENT_CONTROL_INTERCOM_EVENT = "subagent:control-intercom";
const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";

function hasSubagentIntercomEnv(): boolean {
	return Object.keys(process.env).some((key) => key.endsWith("_SUBAGENT_ORCHESTRATOR_TARGET"));
}

function createSyntheticSessionStartEvent(): SessionStartEvent {
	return { type: "session_start", reason: "startup" };
}

function createForwardedHandlerMap(): ForwardedHandlerMap {
	return {
		session_start: [],
		session_shutdown: [],
		turn_start: [],
		turn_end: [],
		agent_start: [],
		agent_end: [],
		tool_execution_start: [],
		tool_execution_end: [],
		model_select: [],
	};
}

function addHandler<K extends LazyLifecycleEvent>(captured: CapturedHeavy, event: K, handler: ForwardedHandler<K>): void {
	captured.handlers[event].push(handler);
}

function captureForwardedHandler(captured: CapturedHeavy, event: "session_start", handler: ForwardedHandler<"session_start">): void;
function captureForwardedHandler(captured: CapturedHeavy, event: "session_shutdown", handler: ForwardedHandler<"session_shutdown">): void;
function captureForwardedHandler(captured: CapturedHeavy, event: "turn_start", handler: ForwardedHandler<"turn_start">): void;
function captureForwardedHandler(captured: CapturedHeavy, event: "turn_end", handler: ForwardedHandler<"turn_end">): void;
function captureForwardedHandler(captured: CapturedHeavy, event: "agent_start", handler: ForwardedHandler<"agent_start">): void;
function captureForwardedHandler(captured: CapturedHeavy, event: "agent_end", handler: ForwardedHandler<"agent_end">): void;
function captureForwardedHandler(captured: CapturedHeavy, event: "tool_execution_start", handler: ForwardedHandler<"tool_execution_start">): void;
function captureForwardedHandler(captured: CapturedHeavy, event: "tool_execution_end", handler: ForwardedHandler<"tool_execution_end">): void;
function captureForwardedHandler(captured: CapturedHeavy, event: "model_select", handler: ForwardedHandler<"model_select">): void;
function captureForwardedHandler(captured: CapturedHeavy, event: LazyLifecycleEvent, handler: AnyForwardedHandler): void;
function captureForwardedHandler(captured: CapturedHeavy, event: LazyLifecycleEvent, handler: AnyForwardedHandler): void {
	switch (event) {
		case "session_start":
			addHandler(captured, event, handler as ForwardedHandler<"session_start">);
			return;
		case "session_shutdown":
			addHandler(captured, event, handler as ForwardedHandler<"session_shutdown">);
			return;
		case "turn_start":
			addHandler(captured, event, handler as ForwardedHandler<"turn_start">);
			return;
		case "turn_end":
			addHandler(captured, event, handler as ForwardedHandler<"turn_end">);
			return;
		case "agent_start":
			addHandler(captured, event, handler as ForwardedHandler<"agent_start">);
			return;
		case "agent_end":
			addHandler(captured, event, handler as ForwardedHandler<"agent_end">);
			return;
		case "tool_execution_start":
			addHandler(captured, event, handler as ForwardedHandler<"tool_execution_start">);
			return;
		case "tool_execution_end":
			addHandler(captured, event, handler as ForwardedHandler<"tool_execution_end">);
			return;
		case "model_select":
			addHandler(captured, event, handler as ForwardedHandler<"model_select">);
	}
}

function addEventHandler(captured: CapturedHeavy, event: string, handler: EventHandler): void {
	const handlers = captured.eventHandlers.get(event) ?? [];
	handlers.push(handler);
	captured.eventHandlers.set(event, handlers);
}

async function dispatchHandlers<K extends LazyLifecycleEvent>(captured: CapturedHeavy, eventName: K, event: ForwardedEventMap[K], ctx: ExtensionContext): Promise<void> {
	for (const handler of captured.handlers[eventName]) {
		await handler(event, ctx);
	}
}

async function dispatchEventHandlers(captured: CapturedHeavy, eventName: string, payload: EventPayload): Promise<void> {
	for (const handler of captured.eventHandlers.get(eventName) ?? []) {
		await handler(payload);
	}
}

function createHeavyProxy(pi: ExtensionAPI, captured: CapturedHeavy): ExtensionAPI {
	return new Proxy(pi, {
		get(target, prop, receiver) {
			if (prop === "registerTool") {
				return (tool: ToolDefinition) => captured.tools.set(tool.name, tool);
			}
			if (prop === "registerCommand") {
				return (name: string, options: CapturedCommand) => captured.commands.set(name, options);
			}
			if (prop === "on") {
				return (event: LazyLifecycleEvent, handler: AnyForwardedHandler) => {
					captureForwardedHandler(captured, event, handler);
				};
			}
			if (prop === "registerShortcut") {
				return (shortcut: string, options: CapturedShortcut) => {
					captured.shortcuts.set(shortcut, options);
				};
			}
			if (prop === "registerMessageRenderer") {
				return (customType: string, renderer: MessageRenderer) => pi.registerMessageRenderer(customType, renderer);
			}
			if (prop === "events") {
				return new Proxy(pi.events, {
					get(eventTarget, eventProp, eventReceiver) {
						if (eventProp === "on") {
							return (event: string, handler: EventHandler) => {
								addEventHandler(captured, event, handler);
								return () => {
									const handlers = captured.eventHandlers.get(event) ?? [];
									captured.eventHandlers.set(event, handlers.filter((candidate) => candidate !== handler));
								};
							};
						}
						return Reflect.get(eventTarget, eventProp, eventReceiver);
					},
				});
			}
			return Reflect.get(target, prop, receiver);
		},
	}) as ExtensionAPI;
}

async function executeHeavyTool(
	loadHeavy: (ctx?: ExtensionContext) => Promise<CapturedHeavy>,
	name: string,
	args: Parameters<NonNullable<ToolDefinition["execute"]>>,
): Promise<Awaited<ReturnType<NonNullable<ToolDefinition["execute"]>>>> {
	const ctx = args[4];
	const heavy = await loadHeavy(ctx);
	const tool = heavy.tools.get(name);
	if (!tool?.execute) throw new Error(`Intercom tool implementation not found: ${name}`);
	return await tool.execute(...args) as Awaited<ReturnType<NonNullable<ToolDefinition["execute"]>>>;
}

async function runHeavyCommand(loadHeavy: (ctx?: ExtensionContext) => Promise<CapturedHeavy>, args: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
	const heavy = await loadHeavy(ctx);
	const command = heavy.commands.get("intercom");
	if (!command) throw new Error("Intercom command implementation not found");
	await command.handler(args ?? "", ctx);
}

function renderHeavyToolResult(loadedHeavy: CapturedHeavy | null, name: string, args: ToolRenderResultArgs): ReturnType<NonNullable<ToolDefinition["renderResult"]>> {
	const renderer = loadedHeavy?.tools.get(name)?.renderResult;
	if (renderer) return renderer(...args);
	return renderIntercomToolResult(name, args);
}

export default function intercom(pi: ExtensionAPI) {
	let heavyPromise: Promise<CapturedHeavy> | null = null;
	let loadedHeavy: CapturedHeavy | null = null;
	let sessionSnapshot: SessionSnapshot | null = null;
	let lifecycleGeneration = 0;
	let replayedGeneration = 0;
	const activeLifecycle: ActiveLifecycleState = {
		turnStart: null,
		agentStart: null,
		activeTools: new Map(),
		modelSelect: null,
	};

	async function replaySessionStart(heavy: CapturedHeavy): Promise<void> {
		if (!sessionSnapshot || replayedGeneration === sessionSnapshot.generation) return;
		replayedGeneration = sessionSnapshot.generation;
		await dispatchHandlers(heavy, "session_start", sessionSnapshot.event, sessionSnapshot.ctx);
		if (activeLifecycle.turnStart) {
			await dispatchHandlers(heavy, "turn_start", activeLifecycle.turnStart.event, activeLifecycle.turnStart.ctx);
		}
		if (activeLifecycle.modelSelect) {
			await dispatchHandlers(heavy, "model_select", activeLifecycle.modelSelect.event, activeLifecycle.modelSelect.ctx);
		}
		if (activeLifecycle.agentStart) {
			await dispatchHandlers(heavy, "agent_start", activeLifecycle.agentStart.event, activeLifecycle.agentStart.ctx);
		}
		for (const activeTool of activeLifecycle.activeTools.values()) {
			await dispatchHandlers(heavy, "tool_execution_start", activeTool.event, activeTool.ctx);
		}
	}

	async function loadHeavy(ctx?: ExtensionContext): Promise<CapturedHeavy> {
		if (!heavyPromise) {
			heavyPromise = (async () => {
				const captured: CapturedHeavy = {
					tools: new Map(),
					commands: new Map(),
					handlers: createForwardedHandlerMap(),
					shortcuts: new Map(),
					eventHandlers: new Map(),
				};
				const mod = await import("./index-heavy.js");
				await mod.default(createHeavyProxy(pi, captured));
				loadedHeavy = captured;
				if (!sessionSnapshot && ctx) {
					sessionSnapshot = { event: createSyntheticSessionStartEvent(), ctx, generation: ++lifecycleGeneration };
				}
				await replaySessionStart(captured);
				return captured;
			})();
		}
		const heavy = await heavyPromise;
		if (!sessionSnapshot && ctx) {
			sessionSnapshot = { event: createSyntheticSessionStartEvent(), ctx, generation: ++lifecycleGeneration };
			await replaySessionStart(heavy);
		}
		return heavy;
	}

	pi.on("session_start", async (event, ctx) => {
		const generation = ++lifecycleGeneration;
		sessionSnapshot = { event, ctx, generation };
		if (loadedHeavy) {
			replayedGeneration = generation;
			await dispatchHandlers(loadedHeavy, "session_start", event, ctx);
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		++lifecycleGeneration;
		activeLifecycle.turnStart = null;
		activeLifecycle.agentStart = null;
		activeLifecycle.activeTools.clear();
		activeLifecycle.modelSelect = null;
		if (loadedHeavy) {
			await dispatchHandlers(loadedHeavy, "session_shutdown", event, ctx);
		}
		sessionSnapshot = null;
		replayedGeneration = lifecycleGeneration;
	});

	pi.on("turn_start", async (event, ctx) => {
		activeLifecycle.turnStart = { event, ctx };
		if (loadedHeavy) await dispatchHandlers(loadedHeavy, "turn_start", event, ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		activeLifecycle.turnStart = null;
		activeLifecycle.agentStart = null;
		activeLifecycle.activeTools.clear();
		if (loadedHeavy) await dispatchHandlers(loadedHeavy, "turn_end", event, ctx);
	});

	pi.on("agent_start", async (event, ctx) => {
		activeLifecycle.agentStart = { event, ctx };
		activeLifecycle.activeTools.clear();
		if (loadedHeavy) await dispatchHandlers(loadedHeavy, "agent_start", event, ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		activeLifecycle.agentStart = null;
		activeLifecycle.activeTools.clear();
		if (loadedHeavy) await dispatchHandlers(loadedHeavy, "agent_end", event, ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		activeLifecycle.activeTools.set(event.toolCallId, { event, ctx });
		if (loadedHeavy) await dispatchHandlers(loadedHeavy, "tool_execution_start", event, ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		activeLifecycle.activeTools.delete(event.toolCallId);
		if (loadedHeavy) await dispatchHandlers(loadedHeavy, "tool_execution_end", event, ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		activeLifecycle.modelSelect = { event, ctx };
		if (loadedHeavy) await dispatchHandlers(loadedHeavy, "model_select", event, ctx);
	});

	pi.registerShortcut("alt+m", {
		description: "Open session intercom overlay",
		handler: async (ctx) => {
			const heavy = await loadHeavy(ctx);
			const handler = heavy.shortcuts.get("alt+m")?.handler;
			if (!handler) throw new Error("Intercom shortcut implementation not found: alt+m");
			await handler(ctx);
		},
	});

	for (const eventName of [SUBAGENT_CONTROL_INTERCOM_EVENT, SUBAGENT_RESULT_INTERCOM_EVENT] as const) {
		pi.events.on(eventName, (payload) => {
			void loadHeavy().then((heavy) => dispatchEventHandlers(heavy, eventName, payload)).catch((error) => {
				console.error(`Intercom event relay failed (${eventName}):`, error);
			});
		});
	}

	if (hasSubagentIntercomEnv()) {
		pi.on("session_start", (_event, ctx) => {
			void loadHeavy(ctx).catch((error) => {
				console.error("Intercom initialization failed:", error);
			});
		});
	}

	pi.registerTool({
		name: "intercom",
		label: "Intercom",
		description: `Send a message to another local agent session running on this machine.
Use this to communicate findings, request help, or coordinate work with other sessions.

Usage:
  intercom({ action: "list" })                    → List active sessions
  intercom({ action: "send", to: "session-name", message: "..." })  → Send message
  intercom({ action: "ask", to: "session-name", message: "..." })   → Ask and wait for reply
  intercom({ action: "reply", message: "..." })                      → Reply to the active/single pending ask
  intercom({ action: "pending" })                                      → List unresolved inbound asks
  intercom({ action: "status" })                  → Show connection status`,
		promptSnippet: "Use to coordinate with other local agent sessions: list peers, send updates, ask for help, or check intercom connectivity.",
		parameters: Type.Object({
			action: Type.String({ description: "Action: 'list', 'send', 'ask', 'reply', 'pending', or 'status'" }),
			to: Type.Optional(Type.String({ description: "Target session name or ID (for 'send', 'ask', or disambiguating 'reply')" })),
			message: Type.Optional(Type.String({ description: "Message to send (for 'send', 'ask', or 'reply' action)" })),
			attachments: Type.Optional(Type.Array(Type.Object({
				type: Type.Union([Type.Literal("file"), Type.Literal("snippet"), Type.Literal("context")]),
				name: Type.String(),
				content: Type.String(),
				language: Type.Optional(Type.String()),
			}))),
			replyTo: Type.Optional(Type.String({ description: "Message ID to reply to (for threading or responding to an 'ask')" })),
		}),
		execute: (...args) => executeHeavyTool(loadHeavy, "intercom", args),
		renderResult: (...args) => renderHeavyToolResult(loadedHeavy, "intercom", args),
		renderCall(args, theme) {
			const input = args as { action?: string; to?: string; message?: string };
			const target = input.to ? ` ${input.to}` : "";
			return new Text(theme.fg("toolTitle", theme.bold(`intercom ${input.action ?? ""}`)) + theme.fg("accent", target), 0, 0);
		},
	});

	if (hasSubagentIntercomEnv()) {
		pi.registerTool({
			name: "contact_supervisor",
			label: "Contact Supervisor",
			description: "Subagent-only tool for contacting the supervisor agent that delegated this task. Use need_decision when blocked, uncertain, needing approval, or facing a product/API/scope decision before continuing; this waits for the supervisor's reply. Use interview_request when multiple structured questions need supervisor answers; this also waits for a reply. Use progress_update only for meaningful progress or unexpected discoveries that change the plan; this does not wait for a reply. Do not use for routine completion handoffs.",
			promptSnippet: "Subagent-only: contact the supervisor for decisions, structured interviews, or meaningful plan-changing updates. Do not use for routine completion handoffs.",
			promptGuidelines: [
				"Use contact_supervisor with reason='need_decision' when a subagent is blocked, uncertain, needs approval, or faces a product/API/scope decision before continuing.",
				"Use contact_supervisor with reason='interview_request' when the child needs multiple structured answers from the supervisor in one blocking exchange.",
				"Use contact_supervisor with reason='progress_update' only for meaningful progress or unexpected discoveries that change the plan.",
				"Do not use contact_supervisor for routine completion handoffs; return the final subagent result normally.",
			],
			parameters: Type.Object({
				reason: Type.String({
					enum: ["need_decision", "progress_update", "interview_request"],
					description: "Contact reason: 'need_decision' waits for a reply; 'interview_request' sends structured questions and waits for a reply; 'progress_update' sends a non-blocking update",
				}),
				message: Type.Optional(Type.String({
					description: "Decision request, optional interview note, or meaningful progress update for the supervisor",
				})),
				interview: Type.Optional(Type.Object({
					title: Type.Optional(Type.String()),
					description: Type.Optional(Type.String()),
					questions: Type.Array(Type.Object({
						id: Type.String(),
						type: Type.String({ description: "Question type: single, multi, text, image, or info" }),
						question: Type.String(),
						options: Type.Optional(Type.Array(Type.Unknown())),
						context: Type.Optional(Type.String()),
					})),
				}, { description: "Structured interview request for reason='interview_request'" })),
			}),
			execute: (...args) => executeHeavyTool(loadHeavy, "contact_supervisor", args),
			renderResult: (...args) => renderHeavyToolResult(loadedHeavy, "contact_supervisor", args),
			renderCall(args, theme) {
				const input = args as { reason?: string; message?: string; interview?: { title?: string } };
				const reason = input.reason ?? "contact";
				const title = input.interview?.title?.trim();
				const preview = input.message?.trim();
				let text = theme.fg("toolTitle", theme.bold("contact_supervisor ")) + theme.fg(reason === "need_decision" ? "warning" : reason === "progress_update" ? "muted" : "accent", reason);
				if (title) text += " " + theme.fg("accent", title);
				if (preview) text += "\n  " + theme.fg("dim", preview.length > 96 ? `${preview.slice(0, 93)}...` : preview);
				return new Text(text, 0, 0);
			},
		});
	}

	pi.registerCommand("intercom", {
		description: "Open session intercom overlay",
		handler: (args, ctx) => runHeavyCommand(loadHeavy, args, ctx),
	});
}
