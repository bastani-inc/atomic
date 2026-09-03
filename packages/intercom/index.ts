import { APP_NAME, getEnvValue, type ExtensionAPI, type ExtensionContext, type SessionStartEvent, type ToolDefinition } from "@bastani/atomic";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renderIntercomToolResult } from "./result-renderers.js";
import { executeHeavyTool, runHeavyCommand, type HeavyHandle } from "./lazy-tool-execution.js";
import { assertCurrentLifecycleLease, createLifecycleLease, retainSettledLifecycleCleanup, retireLifecycleLease, SerializedLifecycleForwarder, type LifecycleLease } from "./lifecycle-lease.js";
import { rejectLazyResultRelay } from "./lazy-subagent-ack.js";
import { isRecoverableIntercomDisconnect } from "./recoverable-disconnect.js";
import { reconnectDelayMs } from "./reconnect-backoff.js";
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
	/**
	 * Internal test seam: the warm-up retry schedule in milliseconds. Production
	 * uses the shared reconnect backoff; a test supplies short delays so the
	 * bounded retry can be driven without waiting out the real schedule.
	 */
	warmUpRetryDelaysMs?: readonly number[];
}

const SUBAGENT_CONTROL_INTERCOM_EVENT = "subagent:control-intercom";
const SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT = "subagent:supervisor-authorization";
interface SupervisorAuthorizationRequest {
	childName?: string;
	completion?: Promise<unknown>;
}

const WORKFLOW_STAGE_LATE_MESSAGE_EVENT = "atomic:workflow-stage-late-message";
const PENDING_STAGE_ROUTE_EVENT = "atomic:workflow-pending-stage-route";
const PENDING_STAGE_UNDELIVERABLE_EVENT = "atomic:workflow-pending-stage-undeliverable";

interface PendingStageUndeliverableRelay {
	handled?: boolean;
	completion?: Promise<boolean>;
	runId?: string;
	senderId?: string;
	senderRegistrationName?: string;
	senderReturnAddress?: string;
	messageId?: string;
	notificationId?: string;
	reason?: string;
}

function isPendingStageUndeliverableRelay(value: unknown): value is PendingStageUndeliverableRelay &
	Required<Pick<PendingStageUndeliverableRelay, "runId" | "senderId" | "messageId" | "notificationId" | "reason">> {
	if (typeof value !== "object" || value === null) return false;
	const event = value as PendingStageUndeliverableRelay;
	return (
		typeof event.runId === "string" &&
		typeof event.senderId === "string" &&
		(event.senderRegistrationName === undefined || typeof event.senderRegistrationName === "string") &&
		(event.senderReturnAddress === undefined || typeof event.senderReturnAddress === "string") &&
		typeof event.messageId === "string" &&
		typeof event.notificationId === "string" &&
		typeof event.reason === "string"
	);
}

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
/**
 * Diagnostics for a background Intercom event relay.
 *
 * A recoverable broker disconnect is not a relay failure the user can act on:
 * the lazy heavy attempt has already been discarded, so the next relay or tool
 * call reconnects on its own. Rendering it would dump an alarming
 * "Intercom event relay failed ... Client disconnected" into the stage UI for
 * work nobody requested. Every other failure — protocol, authentication,
 * configuration, a non-recoverable import, or a terminal relay error — is still
 * reported. The caller-facing acknowledgement is emitted either way, so a
 * waiting relay never hangs on this decision.
 */
function reportRelayFailure(eventName: string, error: unknown): void {
	if (isRecoverableIntercomDisconnect(error)) return;
	console.error(`Intercom event relay failed (${eventName}):`, error);
}

/**
 * Bounded attempts for the workflow-stage warm-up retry.
 *
 * A stage that carries queued pending messages parks on
 * `pendingStageDelivery.ready()`, which only a successful heavy-module replay
 * resolves. Silently discarding a recoverable warm-up disconnect would leave
 * that stage waiting with no owner and no signal, so the wrapper retries on the
 * shared reconnect backoff and reports once when the attempts run out.
 */
const WARM_UP_RETRY_ATTEMPTS = 5;

export default function intercom(pi: ExtensionAPI, options: LightweightIntercomOptions = {}) {
  const inheritedDelegatedSessionName = readSubagentEnv("INTERCOM_SESSION_NAME");
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
				if (!isRecoverableIntercomDisconnect(error)) {
					const message = error instanceof Error ? error.message : String(error);
					console.error(`Intercom heavy initialization failed; a later call will retry: ${message}`, error);
				}
			},
		);
		return promise;
	}
	type WarmUpRetry = { lease: IntercomLease; generation: number; timer: ReturnType<typeof setTimeout> | null; cancelled: boolean };
	let warmUpRetry: WarmUpRetry | null = null;
	function cancelWarmUpRetry(): void {
		if (!warmUpRetry) return;
		warmUpRetry.cancelled = true;
		if (warmUpRetry.timer) clearTimeout(warmUpRetry.timer);
		warmUpRetry = null;
	}
	function warmUpRetryDelay(attempt: number): number | undefined {
		const schedule = options.warmUpRetryDelaysMs;
		if (schedule) return schedule[attempt];
		return attempt < WARM_UP_RETRY_ATTEMPTS ? reconnectDelayMs(attempt) : undefined;
	}
	/**
	 * Own the recovery for a workflow-stage warm-up that lost the broker.
	 *
	 * `session_start` returns immediately so the host is not blocked on backoff,
	 * and exactly one retry chain runs per lease: each attempt re-checks that the
	 * lease and lifecycle generation are still current, so shutdown, reload, and
	 * session replacement abort it silently instead of racing a stale context or
	 * building a second client. A success drains the stage's pending deliveries
	 * through the normal `session_start` replay; running out of attempts is the
	 * terminal case the objective requires to stay visible.
	 */
	function scheduleWarmUpRetry(ctx: ExtensionContext, lease: IntercomLease, generation: number, stageName: string): void {
		if (warmUpRetry) return;
		const state: WarmUpRetry = { lease, generation, timer: null, cancelled: false };
		warmUpRetry = state;
		const clearOwner = (): void => {
			if (warmUpRetry === state) warmUpRetry = null;
		};
		const stale = (): boolean =>
			state.cancelled || activeLease !== lease || lease.retired || sessionSnapshot?.generation !== generation;
		const attemptAt = (attempt: number): void => {
			const delay = warmUpRetryDelay(attempt);
			if (delay === undefined) {
				clearOwner();
				console.error(
					`Intercom could not reconnect for workflow stage "${stageName}" after ${attempt} attempts; queued stage messages remain undelivered until an Intercom call succeeds.`,
				);
				return;
			}
			const timer = setTimeout(() => {
				state.timer = null;
				if (stale()) {
					clearOwner();
					return;
				}
				void loadHeavy(ctx).then(clearOwner, (error: unknown) => {
					if (stale()) {
						clearOwner();
						return;
					}
					// A non-recoverable failure is already reported by loadHeavy's own
					// rejection handler; retrying it would only repeat that diagnostic.
					if (!isRecoverableIntercomDisconnect(error)) {
						clearOwner();
						return;
					}
					attemptAt(attempt + 1);
				});
			}, delay);
			timer.unref?.();
			state.timer = timer;
		};
		attemptAt(0);
	}
  let typedContactSupervisorRegistered = hasSubagentIntercomEnv();
  const activateTypedContactSupervisor = (): void => {
    const activeTools = pi.getActiveTools();
    if (!activeTools.includes("contact_supervisor")) pi.setActiveTools([...activeTools, "contact_supervisor"]);
  };
  const registerTypedContactSupervisor = (): void => {
    if (!typedContactSupervisorRegistered) {
      typedContactSupervisorRegistered = true;
      pi.registerTool({
        name: "contact_supervisor",
        label: "Contact Supervisor",
        description: "Subagent-only tool for contacting the supervisor agent that delegated this task.",
        promptSnippet: "Subagent-only: contact the supervisor for decisions, interviews, or meaningful updates.",
        parameters: Type.Object({
          reason: Type.String({ enum: ["need_decision", "progress_update", "interview_request"] }),
          message: Type.Optional(Type.String()),
          interview: Type.Optional(Type.Unknown()),
        }),
        execute: (...args) => executeHeavyTool(loadHeavy, "contact_supervisor", args),
        renderResult: (...args) => renderHeavyToolResult(loadedHeavy?.heavy ?? null, "contact_supervisor", args),
      });
    }
    activateTypedContactSupervisor();
  };
  pi.on("session_start", async (event, ctx) => {
    const typedIdentity = ctx.subagentPolicy?.intercom;
    if (typedIdentity) {
      if (typedIdentity.sessionName && typeof pi.setSessionName === "function") pi.setSessionName(typedIdentity.sessionName);
      registerTypedContactSupervisor();
    } else if (inheritedDelegatedSessionName && typeof pi.setSessionName === "function") {
      pi.setSessionName(inheritedDelegatedSessionName);
    }
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
    cancelWarmUpRetry();
    if (ctx.orchestrationContext?.kind === "workflow-stage" && ctx.orchestrationContext.pendingStageDelivery !== undefined) {
      const stageName = ctx.orchestrationContext.workflowStageName;
      try {
        await loadHeavy(ctx);
      } catch (error) {
        // Eager stage warm-up is Intercom's own initiative, not the user's.
        // Letting a recoverable disconnect escape would make the host runner
        // report a `session_start` extension error and paint "Client
        // disconnected" over a stage that is still running. Recovery is not
        // left to chance either: this branch hands the failure to a bounded
        // retry owner, because a stage carrying queued messages parks on
        // `pendingStageDelivery.ready()` until a replay delivers them.
        // Everything else still escapes.
        if (!isRecoverableIntercomDisconnect(error)) throw error;
        scheduleWarmUpRetry(ctx, lease, generation, stageName);
      }
    } else if (loadedHeavy) {
      await ensureSessionStartReplayed(loadedHeavy.heavy, lease);
    }
  });
	pi.on("session_shutdown", async (event, ctx) => {
		const lease = activeLease;
		const generation = ++lifecycleGeneration;
		retireLifecycleLease(lease, { event, ctx, generation });
		cancelWarmUpRetry();
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
	pi.events.on(SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT, (payload) => {
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
		const request = payload as SupervisorAuthorizationRequest;
		if (typeof request.childName !== "string" || !request.childName.trim() || request.completion) return;
		request.completion = loadHeavy(latestLifecycleContext())
			.then(async (handle) => {
				handle.assertCurrent();
				const forwarded: SupervisorAuthorizationRequest = { childName: request.childName };
				await dispatchEventHandlers(handle.heavy, SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT, forwarded);
				if (!forwarded.completion) throw new Error("Intercom supervisor authorization provider is unavailable");
				return await forwarded.completion;
			})
			.catch((error: unknown) => {
				// Supervisor authorization is advisory. `requestSupervisorAuthorization`
				// already resolves `undefined` when the parent runtime is gone, and a
				// runtime with no provider simply omits supervisor metadata rather than
				// exposing a broken channel. A recoverable broker disconnect is the same
				// situation: rejecting instead aborts the launch and makes
				// "Client disconnected" the subagent's entire run result, which is the
				// leak this fix exists to close. The child connects lazily anyway, so it
				// requests its own capability once the broker is back. Every other
				// failure — including a claimed provider that failed — still aborts.
				if (isRecoverableIntercomDisconnect(error)) return undefined;
				throw error;
			});
	});
	pi.events.on(PENDING_STAGE_UNDELIVERABLE_EVENT, (payload) => {
		if (!isPendingStageUndeliverableRelay(payload) || payload.handled === true) return;
		payload.handled = true;
		const forwarded = { ...payload, handled: false, completion: undefined };
		payload.completion = loadHeavy(latestLifecycleContext())
			.then(async (handle) => {
				handle.assertCurrent();
				await dispatchEventHandlers(handle.heavy, PENDING_STAGE_UNDELIVERABLE_EVENT, forwarded);
				handle.assertCurrent();
				return forwarded.handled === true && forwarded.completion !== undefined
					? await forwarded.completion
					: false;
			})
			.catch((error) => {
				reportRelayFailure(PENDING_STAGE_UNDELIVERABLE_EVENT, error);
				return false;
			});
	});
	for (const eventName of [
		SUBAGENT_CONTROL_INTERCOM_EVENT,
		SUBAGENT_RESULT_INTERCOM_EVENT,
		PENDING_STAGE_ROUTE_EVENT,
	] as const) {
		pi.events.on(eventName, (payload) => {
			const completion = loadHeavy(latestLifecycleContext()).then(async (handle) => {
				handle.assertCurrent();
				await dispatchEventHandlers(handle.heavy, eventName, payload);
				handle.assertCurrent();
				if (eventName === PENDING_STAGE_ROUTE_EVENT && payload && typeof payload === "object") {
					const routeCompletion = (payload as { completion?: Promise<void> }).completion;
					if (routeCompletion !== undefined && routeCompletion !== completion) await routeCompletion;
				}
			});
			if (eventName === PENDING_STAGE_ROUTE_EVENT && payload && typeof payload === "object") {
				(payload as { completion?: Promise<void> }).completion = completion;
			}
			void completion.catch((error) => {
				rejectLazyResultRelay(pi, eventName, payload, error);
				reportRelayFailure(eventName, error);
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
Sessions belong to an intercom group and can ONLY message sessions in the same group; cross-group sends are rejected by the broker. Ungrouped sessions share the "default" group.
For send, live session names and exact full session IDs remain supported. Workflow-stage targets use \`workflow:<rootRunId>/<segment>[/<segment>...]\`; \`*\` matches one segment and \`**\` any depth. Use \`intercom list\` inside the invocation group to see live, pending, and possible future targets with queued counts. \`workflow:<rootRunId>/**\` reaches live stages now and remains sticky for every future stage until root termination; valid targets outside the known set queue with a \`notInKnownSet\` warning and settle undeliverable at terminal only if never delivered. Use \`ask\` only on live targets.
Usage:
  intercom({ action: "list" })                    → List sessions in your group
  intercom({ action: "list", group: "name" })     → Read-only peek at another group's sessions
  intercom({ action: "join", group: "name" })     → Join or create a named group
  intercom({ action: "leave" })                   → Return to your resolved home group
  intercom({ action: "send", to: "session-name", message: "..." })  → Send message (own group only)
  intercom({ action: "ask", to: "session-name", message: "..." })   → Ask and wait for reply
  intercom({ action: "reply", message: "..." })                      → Reply to the active or exact pending ask
  intercom({ action: "pending" })                                      → List unresolved inbound asks
  intercom({ action: "status" })                  → Show connection status and your group

"default" is the shared group; "true" and "auto" are reserved for subagent auto-groups. Joining does not grant cross-group access; contact_supervisor remains the only cross-group path.`,
		promptSnippet: "Use to coordinate with other local agent sessions in your intercom group: list peers, send updates, ask for help, or check intercom connectivity. Groups are isolated; you can only message sessions in your own group.",
		parameters: Type.Object({
			action: Type.String({ description: "Action: 'list', 'join', 'leave', 'send', 'ask', 'reply', 'pending', or 'status'" }),
			to: Type.Optional(Type.String({ description: "Live session name, exact full session ID, or `workflow:<rootRunId>/<segment>[/<segment>...]` path; `*` matches one segment and `**` any depth. Send queues sticky pending/future delivery and `workflow:<rootRunId>/**` broadcasts to live and future stages; use `ask` only on live targets (for 'send', 'ask', or targeted 'reply')" })),
			message: Type.Optional(Type.String({ description: "Message to send (for 'send', 'ask', or 'reply' action)" })),
			attachments: Type.Optional(Type.Array(Type.Object({
				type: Type.Union([Type.Literal("file"), Type.Literal("snippet"), Type.Literal("context")]),
				name: Type.String(),
				content: Type.String(),
				language: Type.Optional(Type.String()),
			}))),
			replyTo: Type.Optional(Type.String({ description: "Exact pending-ask message ID; disambiguates concurrent asks, including asks from one sender" })),
			group: Type.Optional(Type.String({ description: "Group name for 'join'; read-only group filter for 'list'/'status'. 'send'/'ask' are locked to your own group." })),
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
