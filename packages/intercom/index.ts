import { APP_NAME, getEnvValue, type ExtensionAPI, type ExtensionContext, type SessionStartEvent, type ToolDefinition } from "@bastani/atomic";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renderIntercomToolResult } from "./result-renderers.js";
import { executeHeavyTool, runHeavyCommand, type HeavyHandle } from "./lazy-tool-execution.js";
import { assertCurrentLifecycleLease, createLifecycleLease, retainSettledLifecycleCleanup, retireLifecycleLease, SerializedLifecycleForwarder, type LifecycleLease } from "./lifecycle-lease.js";
import { rejectLazyResultRelay } from "./lazy-subagent-ack.js";
import {
	createForwardedHandlerMap,
	createHeavyProxy,
	dispatchEventHandlers,
	dispatchHandlers,
	type CapturedHeavy,
	type ForwardedEventMap,
	type ToolRenderResultArgs,
} from "./lazy-heavy-proxy.js";

type LifecycleSnapshot<K extends keyof ForwardedEventMap> = {
	event: ForwardedEventMap[K];
	ctx: ExtensionContext;
};
type ShutdownSnapshot = LifecycleSnapshot<"session_shutdown"> & { generation: number };
type IntercomLease = LifecycleLease<ShutdownSnapshot>;
type SessionSnapshot = LifecycleSnapshot<"session_start"> & { generation: number; lease: IntercomLease };
type IntercomHeavyHandle = HeavyHandle<CapturedHeavy>;
type HeavyAttempt = { lease: IntercomLease; promise: Promise<IntercomHeavyHandle> };
type ReplayAttempt = { lease: IntercomLease; heavy: CapturedHeavy; promise: Promise<void> };
type ActiveLifecycleState = {
	turnStart: LifecycleSnapshot<"turn_start"> | null;
	agentStart: LifecycleSnapshot<"agent_start"> | null;
	activeTools: Map<string, LifecycleSnapshot<"tool_execution_start">>;
	modelSelect: LifecycleSnapshot<"model_select"> | null;
};
interface LightweightIntercomOptions {
	importHeavy?: () => Promise<{ default: (pi: ExtensionAPI) => void | Promise<void> }>;
}

const SUBAGENT_CONTROL_INTERCOM_EVENT = "subagent:control-intercom";
const WORKFLOW_STAGE_LATE_MESSAGE_EVENT = "atomic:workflow-stage-late-message";

interface WorkflowStageLateMessageEvent {
	handled?: boolean;
	completion?: Promise<void>;
	workflowRunId?: string;
	workflowStageId?: string;
	messages?: Array<{
		customType?: string;
		content?: string;
		details?: { message?: { expectsReply?: boolean } };
	}>;
}

function isCompletedStageAskRoute(event: WorkflowStageLateMessageEvent): boolean {
	return typeof event.workflowRunId === "string"
		&& event.workflowRunId.length > 0
		&& typeof event.workflowStageId === "string"
		&& event.workflowStageId.length > 0
		&& Array.isArray(event.messages)
		&& event.messages.length > 0
		&& event.messages.every((message) =>
			message.customType === "intercom_message"
			&& typeof message.content === "string"
			&& message.details?.message?.expectsReply === true,
		);
}
const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";

const SUBAGENT_ENV_PREFIX = `${APP_NAME.toUpperCase()}_SUBAGENT_`;

function readSubagentEnv(name: string): string | undefined {
	const value = getEnvValue(`${SUBAGENT_ENV_PREFIX}${name}`)?.trim();
	return value || undefined;
}

function hasSubagentIntercomEnv(): boolean {
	return readSubagentEnv("ORCHESTRATOR_TARGET") !== undefined;
}

function createSyntheticSessionStartEvent(): SessionStartEvent {
	return { type: "session_start", reason: "startup" };
}

function renderHeavyToolResult(loadedHeavy: CapturedHeavy | null, name: string, args: ToolRenderResultArgs): ReturnType<NonNullable<ToolDefinition["renderResult"]>> {
	const renderer = loadedHeavy?.tools.get(name)?.renderResult;
	if (renderer) return renderer(...args);
	return renderIntercomToolResult(name, args);
}
export default function intercom(pi: ExtensionAPI, options: LightweightIntercomOptions = {}) {
	const delegatedSessionName = readSubagentEnv("INTERCOM_SESSION_NAME");
	let heavyAttempt: HeavyAttempt | null = null;
	let loadedHeavy: IntercomHeavyHandle | null = null;
	let sessionSnapshot: SessionSnapshot | null = null;
	let lifecycleGeneration = 0;
	let nextLeaseId = 1;
	let activeLease = createLifecycleLease<ShutdownSnapshot>(nextLeaseId++);
	let replayedGeneration = 0;
	let replayAttempt: ReplayAttempt | null = null;
	const lifecycleForward = new SerializedLifecycleForwarder();
	const invalidatedMessage = "Intercom initialization was invalidated by session shutdown";
	const activeLifecycle: ActiveLifecycleState = {
		turnStart: null,
		agentStart: null,
		activeTools: new Map(),
		modelSelect: null,
	};
	function assertLease(lease: IntercomLease): void {
		assertCurrentLifecycleLease(activeLease, lease, invalidatedMessage);
	}
	function createHandle(heavy: CapturedHeavy, lease: IntercomLease): IntercomHeavyHandle {
		return { heavy, assertCurrent: () => assertLease(lease) };
	}
	async function waitForPriorCleanup(lease: IntercomLease): Promise<void> {
		await lease.priorCleanup;
		assertLease(lease);
	}
	function isReplaySnapshotCurrent(snapshot: SessionSnapshot, lease: IntercomLease): boolean {
		assertLease(lease);
		return sessionSnapshot === snapshot;
	}
	async function replaySessionStart(heavy: CapturedHeavy, lease: IntercomLease, onReplay?: (ctx: ExtensionContext) => void): Promise<void> {
		for (;;) {
			assertLease(lease);
			const snapshot = sessionSnapshot;
			if (!snapshot || snapshot.lease !== lease || replayedGeneration === snapshot.generation) return;
			const active = {
				turnStart: activeLifecycle.turnStart,
				modelSelect: activeLifecycle.modelSelect,
				agentStart: activeLifecycle.agentStart,
				activeTools: [...activeLifecycle.activeTools.values()],
			};
			onReplay?.(snapshot.ctx);
			await dispatchHandlers(heavy, "session_start", snapshot.event, snapshot.ctx);
			if (!isReplaySnapshotCurrent(snapshot, lease)) continue;
			if (active.turnStart) await dispatchHandlers(heavy, "turn_start", active.turnStart.event, active.turnStart.ctx);
			if (!isReplaySnapshotCurrent(snapshot, lease)) continue;
			if (active.modelSelect) await dispatchHandlers(heavy, "model_select", active.modelSelect.event, active.modelSelect.ctx);
			if (!isReplaySnapshotCurrent(snapshot, lease)) continue;
			if (active.agentStart) await dispatchHandlers(heavy, "agent_start", active.agentStart.event, active.agentStart.ctx);
			if (!isReplaySnapshotCurrent(snapshot, lease)) continue;
			for (const activeTool of active.activeTools) {
				await dispatchHandlers(heavy, "tool_execution_start", activeTool.event, activeTool.ctx);
				if (!isReplaySnapshotCurrent(snapshot, lease)) break;
			}
			if (!isReplaySnapshotCurrent(snapshot, lease)) continue;
			replayedGeneration = snapshot.generation;
			return;
		}
	}
	async function ensureSessionStartReplayed(heavy: CapturedHeavy, lease: IntercomLease, onReplay?: (ctx: ExtensionContext) => void): Promise<void> {
		await waitForPriorCleanup(lease);
		const snapshot = sessionSnapshot;
		if (!snapshot || snapshot.lease !== lease || replayedGeneration === snapshot.generation) return;
		const existing = replayAttempt;
		if (existing?.lease === lease && existing.heavy === heavy) return existing.promise;
		let promise: Promise<void>;
		promise = lifecycleForward.enqueue(() => replaySessionStart(heavy, lease, onReplay)).finally(() => {
			if (replayAttempt?.promise === promise) replayAttempt = null;
		});
		replayAttempt = { lease, heavy, promise };
		await promise;
	}
	async function loadHeavy(ctx?: ExtensionContext): Promise<IntercomHeavyHandle> {
		const lease = activeLease;
		if (lease.retired) throw new Error("Intercom initialization unavailable: no active session");
		await waitForPriorCleanup(lease);
		const existing = heavyAttempt;
		if (existing?.lease === lease) {
			const handle = await existing.promise;
			assertLease(lease);
			if (!sessionSnapshot && ctx) {
				sessionSnapshot = { event: createSyntheticSessionStartEvent(), ctx, generation: ++lifecycleGeneration, lease };
			}
			await ensureSessionStartReplayed(handle.heavy, lease);
			assertLease(lease);
			return handle;
		}
		let promise: Promise<IntercomHeavyHandle>;
		promise = (async (): Promise<IntercomHeavyHandle> => {
			const captured: CapturedHeavy = {
				tools: new Map(), commands: new Map(), handlers: createForwardedHandlerMap(),
				shortcuts: new Map(), eventHandlers: new Map(),
			};
			let replayCtx: ExtensionContext | null = null;
			let cleaned = false;
			const cleanupCandidate = async (): Promise<void> => {
				const shutdown = lease.shutdown;
				const cleanupCtx = shutdown?.ctx ?? replayCtx;
				if (!cleanupCtx || cleaned) return;
				cleaned = true;
				const event = shutdown?.event ?? { type: "session_shutdown", reason: "quit" };
				try {
					await dispatchHandlers(captured, "session_shutdown", event, cleanupCtx);
				} catch (cleanupError) {
					console.error("Intercom failed to clean rejected lazy candidate:", cleanupError);
				}
			};
			try {
				const mod = await (options.importHeavy?.() ?? import("./index-heavy.js"));
				assertLease(lease);
				await mod.default(createHeavyProxy(pi, captured));
				assertLease(lease);
				if (!sessionSnapshot && ctx) {
					sessionSnapshot = { event: createSyntheticSessionStartEvent(), ctx, generation: ++lifecycleGeneration, lease };
				}
				await ensureSessionStartReplayed(captured, lease, (replayContext) => { replayCtx = replayContext; });
				assertLease(lease);
				const handle = createHandle(captured, lease);
				loadedHeavy = handle;
				return handle;
			} catch (error) {
				await cleanupCandidate();
				throw error;
			}
		})();
		heavyAttempt = { lease, promise };
		void promise.then(
			() => undefined,
			(error: unknown) => {
				if (heavyAttempt?.promise === promise) heavyAttempt = null;
				const message = error instanceof Error ? error.message : String(error);
				console.error(`Intercom heavy initialization failed; a later call will retry: ${message}`, error);
			},
		);
		return promise;
	}
	pi.on("session_start", async (event, ctx) => {
		if (delegatedSessionName && typeof pi.setSessionName === "function") pi.setSessionName(delegatedSessionName);
		if (activeLease.retired) activeLease = createLifecycleLease<ShutdownSnapshot>(nextLeaseId++, activeLease.cleanupBarrier);
		const lease = activeLease;
		await waitForPriorCleanup(lease);
		if (sessionSnapshot) {
			activeLifecycle.turnStart = null;
			activeLifecycle.agentStart = null;
			activeLifecycle.activeTools.clear();
			activeLifecycle.modelSelect = null;
		}
		const generation = ++lifecycleGeneration;
		sessionSnapshot = { event, ctx, generation, lease };
		if (loadedHeavy) await ensureSessionStartReplayed(loadedHeavy.heavy, lease);
	});
	pi.on("session_shutdown", async (event, ctx) => {
		const lease = activeLease;
		const generation = ++lifecycleGeneration;
		retireLifecycleLease(lease, { event, ctx, generation });
		const retiredHeavy = loadedHeavy?.heavy ?? null;
		const retiredAttempt = heavyAttempt?.lease === lease ? heavyAttempt.promise : null;
		const retiredReplay = replayAttempt?.lease === lease ? replayAttempt.promise : null;
		sessionSnapshot = null;
		heavyAttempt = null;
		loadedHeavy = null;
		replayAttempt = null;
		replayedGeneration = generation;
		activeLifecycle.turnStart = null;
		activeLifecycle.agentStart = null;
		activeLifecycle.activeTools.clear();
		activeLifecycle.modelSelect = null;
		const publishedCleanup = retiredHeavy
			? lifecycleForward.enqueue(() => dispatchHandlers(retiredHeavy, "session_shutdown", event, ctx))
			: Promise.resolve();
		const retainedCleanup = retainSettledLifecycleCleanup(lease, [publishedCleanup, retiredAttempt, retiredReplay, lifecycleForward.settled]);
		try {
			await publishedCleanup;
		} finally {
			await retainedCleanup;
		}
	});
	pi.on("turn_start", async (event, ctx) => {
		if (activeLease.retired) return;
		activeLifecycle.turnStart = { event, ctx };
		const heavy = loadedHeavy?.heavy;
		if (heavy) await lifecycleForward.enqueue(() => dispatchHandlers(heavy, "turn_start", event, ctx));
	});
	pi.on("turn_end", async (event, ctx) => {
		if (activeLease.retired) return;
		activeLifecycle.turnStart = null;
		activeLifecycle.agentStart = null;
		activeLifecycle.activeTools.clear();
		const heavy = loadedHeavy?.heavy;
		if (heavy) await lifecycleForward.enqueue(() => dispatchHandlers(heavy, "turn_end", event, ctx));
	});
	pi.on("agent_start", async (event, ctx) => {
		if (activeLease.retired) return;
		activeLifecycle.agentStart = { event, ctx };
		activeLifecycle.activeTools.clear();
		const heavy = loadedHeavy?.heavy;
		if (heavy) await lifecycleForward.enqueue(() => dispatchHandlers(heavy, "agent_start", event, ctx));
	});
	pi.on("agent_end", async (event, ctx) => {
		if (activeLease.retired) return;
		activeLifecycle.agentStart = null;
		activeLifecycle.activeTools.clear();
		const heavy = loadedHeavy?.heavy;
		if (heavy) await lifecycleForward.enqueue(() => dispatchHandlers(heavy, "agent_end", event, ctx));
	});
	pi.on("tool_execution_start", async (event, ctx) => {
		if (activeLease.retired) return;
		activeLifecycle.activeTools.set(event.toolCallId, { event, ctx });
		const heavy = loadedHeavy?.heavy;
		if (heavy) await lifecycleForward.enqueue(() => dispatchHandlers(heavy, "tool_execution_start", event, ctx));
	});
	pi.on("tool_execution_end", async (event, ctx) => {
		if (activeLease.retired) return;
		activeLifecycle.activeTools.delete(event.toolCallId);
		const heavy = loadedHeavy?.heavy;
		if (heavy) await lifecycleForward.enqueue(() => dispatchHandlers(heavy, "tool_execution_end", event, ctx));
	});
	pi.on("model_select", async (event, ctx) => {
		if (activeLease.retired) return;
		activeLifecycle.modelSelect = { event, ctx };
		const heavy = loadedHeavy?.heavy;
		if (heavy) await lifecycleForward.enqueue(() => dispatchHandlers(heavy, "model_select", event, ctx));
	});
	pi.registerShortcut("alt+m", {
		description: "Open session intercom overlay",
		handler: async (ctx) => {
			const handle = await loadHeavy(ctx);
			handle.assertCurrent();
			const handler = handle.heavy.shortcuts.get("alt+m")?.handler;
			if (!handler) throw new Error("Intercom shortcut implementation not found: alt+m");
			await handler(ctx);
			handle.assertCurrent();
		},
	});
	function latestLifecycleContext(): ExtensionContext | undefined {
		// Sessions that never emit `session_start` to extensions (for example
		// non-interactive in-process child sessions) still emit turn/tool/model
		// lifecycle events. Fall back to the most recent lifecycle context so a
		// relay-triggered heavy load can replay a synthetic `session_start` and
		// initialize the runtime instead of relaying against a disposed one.
		return sessionSnapshot?.ctx
			?? activeLifecycle.turnStart?.ctx
			?? activeLifecycle.agentStart?.ctx
			?? [...activeLifecycle.activeTools.values()].at(-1)?.ctx
			?? activeLifecycle.modelSelect?.ctx;
	}
	for (const eventName of [SUBAGENT_CONTROL_INTERCOM_EVENT, SUBAGENT_RESULT_INTERCOM_EVENT] as const) {
		pi.events.on(eventName, (payload) => {
			void loadHeavy(latestLifecycleContext()).then(async (handle) => {
				handle.assertCurrent();
				await dispatchEventHandlers(handle.heavy, eventName, payload);
				handle.assertCurrent();
			}).catch((error) => {
				rejectLazyResultRelay(pi, eventName, payload, error);
				console.error(`Intercom event relay failed (${eventName}):`, error);
			});
		});
	}
	pi.events.on(WORKFLOW_STAGE_LATE_MESSAGE_EVENT, (payload) => {
		if (!payload || typeof payload !== "object") return;
		const event = payload as WorkflowStageLateMessageEvent;
		// A completed-stage blocking ask belongs to the workflow post-mortem
		// router. It must remain unclaimed when Intercom registers first, while
		// every event already claimed by an earlier listener keeps its owner.
		if (event.handled === true || isCompletedStageAskRoute(event)) return;
		event.handled = true;
		event.completion = loadHeavy(latestLifecycleContext()).then(async (handle) => {
			handle.assertCurrent();
			await dispatchEventHandlers(handle.heavy, WORKFLOW_STAGE_LATE_MESSAGE_EVENT, payload);
			handle.assertCurrent();
		});
	});
	// Heavy Intercom state stays unloaded until the model or user invokes an
	// Intercom tool, command, shortcut, or relay that needs it.
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
		renderResult: (...args) => renderHeavyToolResult(loadedHeavy?.heavy ?? null, "intercom", args),
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
			renderResult: (...args) => renderHeavyToolResult(loadedHeavy?.heavy ?? null, "contact_supervisor", args),
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
