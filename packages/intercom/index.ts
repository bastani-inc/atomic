import { forwardReleaseObservation } from "./broker/released-child-receipts.js";
import { reportOwnedIntercomDiagnostic } from "./diagnostics.js";
import { APP_NAME, type ExtensionAPI, type ExtensionContext, getEnvValue, type SessionStartEvent, type ToolDefinition } from "@bastani/atomic";
import { Type } from "typebox";
import { getExtensionContextOwner } from "./context-owner.js";
import { renderContactSupervisorCall, renderIntercomCall, renderIntercomToolResult } from "./result-renderers.js";
import { renderIntercomCustomMessage } from "./ui/inline-message.js";
import { executeHeavyTool, runHeavyCommand, type HeavyHandle } from "./lazy-tool-execution.js";
import { contactSupervisorCallMayDetach, intercomCallMayDetach } from "./detachable-calls.js";
import { assertCurrentLifecycleLease, createLifecycleLease, retainSettledLifecycleCleanup, retireLifecycleLease, SerializedLifecycleForwarder, type LifecycleLease } from "./lifecycle-lease.js";
import { rejectLazyResultRelay } from "./lazy-subagent-ack.js";
import { isIntercomBrokerTimeout, isRecoverableIntercomDisconnect } from "./recoverable-disconnect.js";
import { reconnectDelayMs } from "./reconnect-backoff.js";
import {
	INTERCOM_STARTUP_JOIN_EVENT,
	type IntercomStartupJoinRequest,
	joinsIntercomAtStartup,
	STARTUP_JOIN_DELAY_MS,
	STARTUP_JOIN_RETRIES,
	startupJoinFromEnv,
} from "./startup-join.js";
import {
	type AwaitIntercomPeerRequest,
	hasIntercomHistory,
	INTERCOM_RECOVERY_PEERS_EVENT,
	type IntercomRecoveryPeersRequest,
	awaitRestoredIntercomPeers,
	isAwaitIntercomPeerRequest,
	isAcknowledgeReleasedChildWakeRequest,
	isDropReleasedChildrenRequest,
	isMarkEndedChildrenRequest,
	isReleaseRestoringChildRequest,
	isReserveReleasedChildrenRequest,
	isReserveRestoringChildRequest,
	planIntercomRecoveryReplay,
	type AcknowledgeReleasedChildWakeRequest,
	type DropReleasedChildrenRequest,
	type MarkEndedChildrenRequest,
	type ReleaseRestoringChildRequest,
	type ReserveReleasedChildrenRequest,
	type ReserveRestoringChildRequest,
	SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT,
	SUBAGENT_AWAIT_INTERCOM_PEER_EVENT,
	SUBAGENT_DROP_RELEASED_CHILDREN_EVENT,
	SUBAGENT_MARK_ENDED_CHILDREN_EVENT,
	SUBAGENT_RELEASE_RESTORING_CHILD_EVENT,
	SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT,
	SUBAGENT_RESERVE_RESTORING_CHILD_EVENT,
} from "./session-recovery.js";
import type { SessionInfo } from "./types.js";
import { answerReleasedReplyFormatRequests } from "./released-reply-format.js";
import { intercomScriptAccess } from "./codemode-access.js";
import { ASK_DESCRIPTION, ASK_PROMPT_SNIPPET, ASK_USAGE, askIdSchema, askWaitSchema } from "./ask-wait.js";
import { RETURN_PATH_TOOL_NOTE } from "./group.js";
import { INTERCOM_INBOX_REPLAY_EVENT, type IntercomInboxReplayRequest, unconsumedIntercomInbox } from "./durable-inbox.js";
import {
	createForwardedHandlerMap,
	createHeavyProxy,
	dispatchEventHandlers,
	dispatchHandlers,
	type CapturedHeavy,
	type ForwardedEventMap,
	type ToolRenderResultArgs,
} from "./lazy-heavy-proxy.js";

export { IntercomReachUnsupportedError, isIntercomReachUnsupportedError } from "./reach-errors.js";
export {
	IntercomReleasedChildError,
	type IntercomReleasedChildErrorCode,
	isIntercomReleasedChildError,
	isReleasedChildErrorCode,
	isReleasedChildReservationError,
	isUnknownReleasedChildError,
	RELEASED_CHILD_ERROR_CODES,
	ReleasedChildReservationError,
	rehydrateIntercomReleasedChildError,
	type SerializedIntercomReleasedChildError,
	serializeIntercomReleasedChildError,
	UnknownReleasedChildError,
} from "./broker/released-child-errors.js";
export {
	IntercomReleasedReplyError,
	type IntercomReleasedReplyErrorCode,
	type IntercomReleasedReplyErrorFields,
	isIntercomReleasedReplyError,
	isReleasedReplyAnsweredError,
	isReleasedReplyErrorCode,
	isReleasedReplyInFlightError,
	isRetryableIntercomReleasedReplyError,
	RELEASED_REPLY_ERROR_CODES,
	ReleasedReplyAnsweredError,
	ReleasedReplyInFlightError,
	readSerializedIntercomReleasedReplyError,
	rehydrateIntercomReleasedReplyError,
	type SerializedIntercomReleasedReplyError,
	serializeIntercomReleasedReplyError,
} from "./broker/released-reply-errors.js";
export {
	INTERCOM_RECIPIENT_GONE_ERROR_CODES,
	IntercomRecipientGoneError,
	type IntercomRecipientGoneErrorCode,
	type IntercomRecipientGoneErrorFields,
	isIntercomRecipientGoneError,
	isIntercomRecipientGoneErrorCode,
	isRetryableIntercomRecipientGoneError,
	isSubagentRecipientDisconnectedError,
	isSubagentRecipientEndedError,
	isSubagentRecipientOwnerSuspendedError,
	readSerializedIntercomRecipientGoneError,
	rehydrateIntercomRecipientGoneError,
	type SerializedIntercomRecipientGoneError,
	SUBAGENT_ENDED_OUTCOMES,
	type SubagentEndedOutcome,
	type SubagentRecipientDisconnectedCode,
	SubagentRecipientDisconnectedError,
	type SubagentRecipientEndedCode,
	type SubagentRecipientOwnerSuspendedCode,
	SubagentRecipientEndedError,
	SubagentRecipientOwnerSuspendedError,
	serializeIntercomRecipientGoneError,
	subagentEndedCode,
} from "./broker/recipient-gone-errors.js";
export {
	type IntercomHostedSessionRequestType,
	IntercomHostedSessionTimeoutError,
	type IntercomHostedSessionTimeoutCode,
	type IntercomHostedSessionTimeoutFields,
	type IntercomHostedSessionTimeoutPhase,
	isIntercomHostedSessionTimeoutError,
} from "./hosted-session-timeout-error.js";
export {
	HOSTED_SESSION_ERROR_CODES,
	HostedSessionRequestError,
	IntercomHostedSessionError,
	type IntercomHostedSessionErrorCode,
	type IntercomHostedSessionErrorFields,
	isHostedSessionErrorCode,
	isHostedSessionRequestError,
	isIntercomHostedSessionError,
	isNotHostedSessionError,
	NotHostedSessionError,
	readSerializedIntercomHostedSessionError,
	rehydrateIntercomHostedSessionError,
	type SerializedIntercomHostedSessionError,
	serializeIntercomHostedSessionError,
} from "./broker/hosted-session-errors.js";

type LifecycleSnapshot<K extends keyof ForwardedEventMap> = {
	event: ForwardedEventMap[K];
	ctx: ExtensionContext;
};
type ShutdownSnapshot = LifecycleSnapshot<"session_shutdown"> & { generation: number; diagnosticRoute: DiagnosticRoute };
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
const SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT = "subagent:supervisor-authorization";
interface SupervisorAuthorizationRequest {
	childName?: string;
	completion?: Promise<unknown>;
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

/** Formatting a diagnostic must never replace the failure or its acknowledgement. */
function diagnosticDetail(error: unknown): string {
	try {
		return String(error instanceof Error ? error.message : error);
	} catch {
		return "Unprintable error";
	}
}

type DiagnosticRoute = ExtensionContext | "console" | "silent";

/** Snapshot routing before awaits can invalidate the owner's guarded getters. */
function captureDiagnosticRoute(ctx: ExtensionContext | undefined): DiagnosticRoute {
	try {
		// RPC has UI too, but only a terminal owns pane diagnostics. Keep the
		// context, not its raw UI: late TUI notifications must still be guarded.
		return ctx?.hasUI && ctx.mode === "tui" ? ctx : "console";
	} catch {
		return "silent";
	}
}

/** Report against the captured owner, not whichever session is current after an await. */
function reportDiagnostic(
	route: DiagnosticRoute,
	message: string,
	error: unknown,
	level: "warning" | "error",
	consoleMessage = message,
): void {
	if (route === "console") {
		if (!reportOwnedIntercomDiagnostic()) console.error(consoleMessage, error);
		return;
	}
	if (route === "silent") return;
	try {
		route.ui.notify(message, level);
	} catch {
		// A retired TUI context or unavailable UI never authorizes console fallback.
	}
}

/**
 * Diagnostics for a background Intercom event relay.
 *
 * A recoverable broker disconnect is not a relay failure the user can act on:
 * the lazy heavy attempt has already been discarded, so the next relay or tool
 * call reconnects on its own. Rendering it would dump an alarming
 * "Intercom event relay failed ... Client disconnected" into the session UI for
 * work nobody requested. Every other failure — protocol, authentication,
 * configuration, a non-recoverable import, or a terminal relay error — is still
 * reported. The caller-facing acknowledgement is emitted either way, so a
 * waiting relay never hangs on this decision.
 */
function reportRelayFailure(route: DiagnosticRoute, eventName: string, error: unknown): void {
	if (isRecoverableIntercomDisconnect(error)) return;
	const prefix = `Intercom event relay failed (${eventName}):`;
	const detail = diagnosticDetail(error);
	reportDiagnostic(route, `${prefix} ${detail}`, error, "error", prefix);
}

/**
 * How long a broker must keep timing out before a background relay reports it.
 *
 * Under load one saturated broker times out every relay in flight at once, and each of those is
 * recovered by the retries behind it. Only a broker that is still silent after this long is an outage
 * the user can act on, and it is reported once until a relay succeeds again.
 */
const BROKER_OUTAGE_REPORT_AFTER_MS = 60_000;

class BrokerOutage {
	private startedAt: number | null = null;
	private reported = false;

	/** True exactly once per outage: on the first timeout seen after it has lasted long enough. */
	timedOut(now: number): boolean {
		this.startedAt ??= now;
		if (this.reported || now - this.startedAt < BROKER_OUTAGE_REPORT_AFTER_MS) return false;
		this.reported = true;
		return true;
	}

	recovered(): void {
		this.startedAt = null;
		this.reported = false;
	}
}

export default function intercom(pi: ExtensionAPI, options: LightweightIntercomOptions = {}) {
  const inheritedDelegatedSessionName = readSubagentEnv("INTERCOM_SESSION_NAME");
  let heavyAttempt: HeavyAttempt | null = null;
  let loadedHeavy: IntercomHeavyHandle | null = null;
  const heavyReplyWaitMayDetach = (name: string, params: { action?: string; reason?: string }): boolean => {
    if (loadedHeavy === null) return true;
    const predicate = loadedHeavy.heavy.tools.get(name)?.detachable;
    return typeof predicate === "function" ? predicate(params) : predicate === true;
  };
  let sessionSnapshot: SessionSnapshot | null = null;
	// Event subscriptions outlive shutdown replay state; never use this owner to load heavy state.
	let shutdownDiagnosticRoute: DiagnosticRoute | undefined;
	let lifecycleGeneration = 0;
	let nextLeaseId = 1;
	let activeLease = createLifecycleLease<ShutdownSnapshot>(nextLeaseId++);
	let replayedGeneration = 0;
	let replayAttempt: ReplayAttempt | null = null;
	const brokerOutage = new BrokerOutage();
	function reportBackgroundRelayFailure(route: DiagnosticRoute, eventName: string, error: unknown): void {
		if (isIntercomBrokerTimeout(error) && brokerOutage.timedOut(Date.now())) {
			const prefix = `Intercom broker has not answered for over ${BROKER_OUTAGE_REPORT_AFTER_MS / 1000}s; background relays keep retrying (${eventName}):`;
			reportDiagnostic(route, `${prefix} ${diagnosticDetail(error)}`, error, "error", prefix);
			return;
		}
		reportRelayFailure(route, eventName, error);
	}
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
	async function loadHeavy(ctx?: ExtensionContext, { quiet = false }: { quiet?: boolean } = {}): Promise<IntercomHeavyHandle> {
		let diagnosticRoute: DiagnosticRoute = quiet ? "silent" : captureDiagnosticRoute(ctx);
		let diagnosticOwner = ctx && getExtensionContextOwner(ctx);
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
		let replayCtx: ExtensionContext | null = null;
		promise = (async (): Promise<IntercomHeavyHandle> => {
			const captured: CapturedHeavy = {
				tools: new Map(), commands: new Map(), handlers: createForwardedHandlerMap(),
				shortcuts: new Map(), eventHandlers: new Map(),
			};
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
					const prefix = "Intercom failed to clean rejected lazy candidate:";
					const detail = diagnosticDetail(cleanupError);
					reportDiagnostic(shutdown?.diagnosticRoute ?? diagnosticRoute, `${prefix} ${detail}`, cleanupError, "error", prefix);
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
				await ensureSessionStartReplayed(captured, lease, (replayContext) => {
					// Dispatch wrappers differ even for the same (possibly already stale) owner.
					const owner = getExtensionContextOwner(replayContext);
					if (!quiet && owner !== diagnosticOwner) {
						diagnosticRoute = captureDiagnosticRoute(replayContext);
						diagnosticOwner = owner;
					}
					replayCtx = replayContext;
				});
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
					const message = diagnosticDetail(error);
					reportDiagnostic(
						diagnosticRoute,
						`Intercom heavy initialization failed; a later call will retry: ${message}`,
						error,
						"warning",
					);
				}
			},
		);
		return promise;
	}
	/**
	 * An admitted child registers on Intercom before its first turn, so its supervisor and peers can list and steer it
	 * and what they send it is in hand when that turn starts. A host that runs the child's start (`startup`) keeps
	 * the start waiting through a broker that is briefly unreachable, retrying until the child registers or its start
	 * is given up. Without one, a recoverable disconnect does not end the launch: the child connects on its next
	 * Intercom use, as before. Everything else escapes.
	 */
	async function registerAdmittedChild(ctx: ExtensionContext, lease: IntercomLease, generation: number): Promise<void> {
		const startup = ctx.subagentPolicy?.startup;
		const current = () => activeLease === lease && !lease.retired && sessionSnapshot?.generation === generation;
		// A start given up while another extension held it never registers: its session is disposed unused, and must not
		// take the sends held for the child's retry.
		const givenUp = (): boolean => startup?.signal.aborted === true;
		if (givenUp()) return;
		startup?.enterStep("registering-intercom");
		for (let attempt = 0; ; attempt += 1) {
			try {
				await loadHeavy(ctx);
				break;
			} catch (error) {
				if (!isRecoverableIntercomDisconnect(error)) throw error;
				const delayMs = startup === undefined ? undefined : reconnectDelayMs(attempt);
				if (delayMs === undefined || !current() || givenUp()) return;
				const waited = await new Promise<boolean>((resolve) => {
					const onAbort = () => {
						clearTimeout(timer);
						resolve(false);
					};
					const timer = setTimeout(() => {
						startup?.signal.removeEventListener("abort", onAbort);
						resolve(true);
					}, delayMs);
					timer.unref?.();
					startup?.signal.addEventListener("abort", onAbort, { once: true });
				});
				if (!waited || !current()) return;
			}
		}
		if (current()) startup?.enterStep("creating-session");
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
        exposure: "model-only",
        detachable: (params) => contactSupervisorCallMayDetach(params) && heavyReplyWaitMayDetach("contact_supervisor", params),
        detachmentRequiresReady: true,
        label: "Contact Supervisor",
        description: "Subagent-only tool for contacting the supervisor agent that delegated this task.",
        promptSnippet: "Subagent-only: contact the supervisor for decisions, interviews, or meaningful updates.",
        parameters: Type.Object({
          reason: Type.String({ enum: ["need_decision", "progress_update", "interview_request"] }),
          message: Type.Optional(Type.String()),
          interview: Type.Optional(Type.Unknown()),
        }),
        execute: (...args) => executeHeavyTool(loadHeavy, "contact_supervisor", args),
        renderCall: renderContactSupervisorCall,
        renderResult: (...args) => renderHeavyToolResult(loadedHeavy?.heavy ?? null, "contact_supervisor", args),
      });
    }
    activateTypedContactSupervisor();
  };
	type StartupJoin = {
		lease: IntercomLease;
		generation: number;
		timer: ReturnType<typeof setTimeout> | null;
		waitingForTrust: boolean;
		/** The session's first turn has started, so its folder's trust is decided and no longer holds the join back. */
		settled: boolean;
	};
	let startupJoin: StartupJoin | null = null;
	function cancelStartupJoin(): void {
		if (startupJoin?.timer) clearTimeout(startupJoin.timer);
		startupJoin = null;
	}
	function projectTrusted(ctx: ExtensionContext): boolean {
		try {
			return typeof ctx.isProjectTrusted !== "function" || ctx.isProjectTrusted();
		} catch {
			return false;
		}
	}
	async function joinAtStartup(ctx: ExtensionContext): Promise<void> {
		const handle = await loadHeavy(ctx, { quiet: true });
		handle.assertCurrent();
		const request: IntercomStartupJoinRequest = {};
		await dispatchEventHandlers(handle.heavy, INTERCOM_STARTUP_JOIN_EVENT, request);
		if (!request.completion) throw new Error("Intercom cannot join at startup");
		await request.completion;
	}
	/**
	 * Joins Intercom in the background a few seconds after the session has started, so neither its first frame nor its
	 * first prompt waits for the broker or competes with loading Intercom. A join that cannot reach the broker stays
	 * silent and is retried on the reconnect backoff a few times; the session then joins on its next Intercom use. A
	 * session whose folder is not trusted, whose trust may still be being decided, joins only once the folder is trusted,
	 * which it checks on the same backoff, or when its first turn starts: before that no other session can start a turn
	 * in it. The timers never keep the process alive, and a session that ends or is replaced drops its join.
	 */
	function scheduleStartupJoin(
		ctx: ExtensionContext,
		lease: IntercomLease,
		generation: number,
		attempt = 0,
		startupSettled = false,
	): void {
		cancelStartupJoin();
		const join: StartupJoin = { lease, generation, timer: null, waitingForTrust: false, settled: startupSettled };
		const current = () =>
			startupJoin === join && activeLease === lease && !lease.retired && sessionSnapshot?.generation === generation;
		startupJoin = join;
		join.timer = setTimeout(() => {
			join.timer = null;
			if (!current()) return;
			if (!join.settled && !projectTrusted(ctx)) {
				if (attempt < STARTUP_JOIN_RETRIES) scheduleStartupJoin(ctx, lease, generation, attempt + 1);
				if (startupJoin) startupJoin.waitingForTrust = true;
				return;
			}
			joinAtStartup(ctx).then(
				() => {
					if (startupJoin === join) startupJoin = null;
				},
				() => {
					if (!current()) return;
					if (attempt >= STARTUP_JOIN_RETRIES) startupJoin = null;
					else scheduleStartupJoin(ctx, lease, generation, attempt + 1, join.settled);
				},
			);
		}, attempt === 0 ? STARTUP_JOIN_DELAY_MS : reconnectDelayMs(attempt - 1));
		join.timer.unref?.();
	}
  pi.on("session_start", async (event, ctx) => {
    const typedIdentity = ctx.subagentPolicy?.intercom;
    if (typedIdentity) {
      if (typedIdentity.sessionName && typeof pi.setSessionName === "function") await pi.setSessionName(typedIdentity.sessionName);
      registerTypedContactSupervisor();
    } else if (inheritedDelegatedSessionName && typeof pi.setSessionName === "function") {
      await pi.setSessionName(inheritedDelegatedSessionName);
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
		shutdownDiagnosticRoute = undefined;
    if (typedIdentity) {
      await registerAdmittedChild(ctx, lease, generation);
      return;
    }
    if (loadedHeavy) await ensureSessionStartReplayed(loadedHeavy.heavy, lease);
    if (
      startupJoinFromEnv() !== false &&
      !hasSubagentIntercomEnv() &&
      !inheritedDelegatedSessionName &&
      joinsIntercomAtStartup(ctx, () => (typeof pi.getActiveTools === "function" ? pi.getActiveTools() : []))
    ) {
      scheduleStartupJoin(ctx, lease, generation);
    }
  });
	pi.on("session_shutdown", async (event, ctx) => {
		cancelStartupJoin();
		const lease = activeLease;
		const generation = ++lifecycleGeneration;
		const diagnosticRoute = captureDiagnosticRoute(ctx);
		retireLifecycleLease(lease, { event, ctx, generation, diagnosticRoute });
		shutdownDiagnosticRoute = diagnosticRoute;
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
		const pending = startupJoin;
		if (pending && !pending.settled && pending.lease === activeLease && sessionSnapshot?.generation === pending.generation) {
			if (pending.waitingForTrust) scheduleStartupJoin(sessionSnapshot.ctx, pending.lease, pending.generation, 0, true);
			else pending.settled = true;
		}
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
	// The heavy lifecycle binds a reply context when its intercom message enters the model's context.
	pi.on("message_start", async (event, ctx) => {
		if (activeLease.retired) return;
		const heavy = loadedHeavy?.heavy;
		if (heavy) await lifecycleForward.enqueue(() => dispatchHandlers(heavy, "message_start", event, ctx));
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
	pi.events.on(SUBAGENT_AWAIT_INTERCOM_PEER_EVENT, (payload) => {
		if (!payload || typeof payload !== "object" || !isAwaitIntercomPeerRequest(payload) || payload.completion) return;
		const forwarded: AwaitIntercomPeerRequest = {
			name: payload.name,
			timeoutMs: payload.timeoutMs,
			...(payload.group === undefined ? {} : { group: payload.group }),
		};
		payload.completion = loadHeavy(latestLifecycleContext())
			.then(async (handle) => {
				handle.assertCurrent();
				await dispatchEventHandlers(handle.heavy, SUBAGENT_AWAIT_INTERCOM_PEER_EVENT, forwarded);
				return forwarded.completion ? await forwarded.completion : false;
			})
			.catch(() => false);
	});
	// #3760: a resume restoring a child asks the broker, through this session's connection, to hold its sends.
	pi.events.on(SUBAGENT_RESERVE_RESTORING_CHILD_EVENT, (payload) => {
		if (!isReserveRestoringChildRequest(payload) || payload.completion) return;
		const forwarded: ReserveRestoringChildRequest = {
			capability: payload.capability,
			aliases: [...payload.aliases],
			...(payload.group === undefined ? {} : { group: payload.group }),
			...(payload.dormant === true ? { dormant: true } : {}),
			...(payload.holdMs === undefined ? {} : { holdMs: payload.holdMs }),
		};
		payload.completion = loadHeavy(latestLifecycleContext()).then(async (handle) => {
			handle.assertCurrent();
			await dispatchEventHandlers(handle.heavy, SUBAGENT_RESERVE_RESTORING_CHILD_EVENT, forwarded);
			if (!forwarded.completion) throw new Error("Intercom cannot hold sends for a restoring subagent");
			await forwarded.completion;
		});
	});
	answerReleasedReplyFormatRequests(pi.events);
	// #4326: the owner reserves its released children by name, in bulk, on its own broker connection.
	pi.events.on(SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, (payload) => {
		if (!isReserveReleasedChildrenRequest(payload) || payload.completion) return;
		const forwarded: ReserveReleasedChildrenRequest = { children: payload.children };
		payload.completion = loadHeavy(latestLifecycleContext()).then(async (handle) => {
			handle.assertCurrent();
			await dispatchEventHandlers(handle.heavy, SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, forwarded);
			if (!forwarded.completion) throw new Error("Intercom cannot reserve released subagents");
			await forwarded.completion;
		});
	});
	// A reservation lives on the connection that made it: without a loaded Intercom there is nothing to drop or to
	// extend, and loading it just to say so would only report a failure at shutdown. #4639: an ended child's report
	// lives on the connection too; the owner reports again whenever Intercom connects.
	for (const [eventName, isRequest] of [
		[SUBAGENT_DROP_RELEASED_CHILDREN_EVENT, isDropReleasedChildrenRequest],
		[SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT, isAcknowledgeReleasedChildWakeRequest],
		[SUBAGENT_MARK_ENDED_CHILDREN_EVENT, isMarkEndedChildrenRequest],
	] as const) {
		pi.events.on(eventName, (payload) => {
			if (!isRequest(payload) || payload.completion) return;
			const forwarded: DropReleasedChildrenRequest | AcknowledgeReleasedChildWakeRequest | MarkEndedChildrenRequest = {
				...payload,
			};
			if (eventName === SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT) forwardReleaseObservation(payload, forwarded);
			const handle = loadedHeavy;
			payload.completion = !handle
				? Promise.resolve()
				: (async () => {
						try {
							handle.assertCurrent();
						} catch {
							// This Intercom generation ended, and its reservations with it.
							return;
						}
						try {
							await dispatchEventHandlers(handle.heavy, eventName, forwarded);
							await forwarded.completion;
						} catch (error) {
							// A lost connection took its reservations with it; a broker's refusal is the caller's to see.
							if (!isRecoverableIntercomDisconnect(error)) throw error;
						}
					})();
		});
	}
	pi.events.on(SUBAGENT_RELEASE_RESTORING_CHILD_EVENT, (payload) => {
		if (!isReleaseRestoringChildRequest(payload) || payload.completion) return;
		const forwarded: ReleaseRestoringChildRequest = {
			capability: payload.capability,
			...(payload.gone === undefined ? {} : { gone: payload.gone }),
			...(payload.refusal === undefined ? {} : { refusal: payload.refusal }),
		};
		// A hold lives on the connection that made it, so a session that never loaded Intercom, or whose Intercom has
		// ended, holds nothing to release; loading it just to say so would only report a failure at shutdown.
		const handle = loadedHeavy;
		payload.completion = !handle
			? Promise.resolve()
			: (async () => {
					try {
						handle.assertCurrent();
						await dispatchEventHandlers(handle.heavy, SUBAGENT_RELEASE_RESTORING_CHILD_EVENT, forwarded);
						await forwarded.completion;
					} catch {
						// The connection is gone, and its holds with it.
					}
				})();
	});
	async function recoveryPeers(ctx: ExtensionContext): Promise<SessionInfo[] | undefined> {
		try {
			const handle = await loadHeavy(ctx);
			handle.assertCurrent();
			const forwarded: IntercomRecoveryPeersRequest = {};
			await dispatchEventHandlers(handle.heavy, INTERCOM_RECOVERY_PEERS_EVENT, forwarded);
			return forwarded.completion ? await forwarded.completion : undefined;
		} catch {
			return undefined;
		}
	}
	/**
	 * #3761: replay the messages this session saved on arrival but never showed, after the transcript is visible.
	 * They pass #3760's interrupted-card decision: from a connected or restored sender they are shown and may start a
	 * turn; from a sender that is gone they appear once as history in the recovery notice; while Intercom cannot be
	 * reached, or a relaunched sender has not reconnected, they are deferred to the next resume.
	 */
	async function replayIntercomInbox(
		ctx: ExtensionContext,
		peers: readonly SessionInfo[] | undefined,
	): Promise<readonly string[]> {
		try {
			const restored = await awaitRestoredIntercomPeers(pi.events, ctx.sessionManager.getSessionId());
			const handle = await loadHeavy(ctx);
			handle.assertCurrent();
			const forwarded: IntercomInboxReplayRequest = { peers, restored };
			await dispatchEventHandlers(handle.heavy, INTERCOM_INBOX_REPLAY_EVENT, forwarded);
			return (await forwarded.completion) ?? [];
		} catch {
			// The saved messages stay unshown and the next resume decides about them again.
			return [];
		}
	}
	pi.on("session_recovery_restore", async (_event, ctx) => {
		const peers = hasIntercomHistory(ctx.sessionManager.getEntries()) ? await recoveryPeers(ctx) : undefined;
		if (unconsumedIntercomInbox(ctx.sessionManager.getBranch()).length === 0) return undefined;
		const notices = await replayIntercomInbox(ctx, peers);
		return notices.length > 0 ? { notices: [...notices] } : undefined;
	});
	pi.on("session_recovery_replay", async (event, ctx) => {
		if (!event.pending.some((delivery) => delivery.customType === "intercom_message")) return undefined;
		const peers = await recoveryPeers(ctx);
		const restored = await awaitRestoredIntercomPeers(pi.events, ctx.sessionManager.getSessionId());
		return planIntercomRecoveryReplay(event.pending, peers, restored);
	});
	for (const eventName of [SUBAGENT_CONTROL_INTERCOM_EVENT, SUBAGENT_RESULT_INTERCOM_EVENT] as const) {
		pi.events.on(eventName, (payload) => {
			const ctx = latestLifecycleContext();
			const diagnosticRoute = ctx ? captureDiagnosticRoute(ctx) : shutdownDiagnosticRoute ?? "console";
			const loaded = loadHeavy(ctx);
			void loaded.catch(() => {});
			const completion = (async (): Promise<void> => {
				const handle = await loaded;
				handle.assertCurrent();
				await dispatchEventHandlers(handle.heavy, eventName, payload);
				handle.assertCurrent();
			})();
			void completion.then(
				() => brokerOutage.recovered(),
				(error) => {
					rejectLazyResultRelay(pi, eventName, payload, error);
					reportBackgroundRelayFailure(diagnosticRoute, eventName, error);
				},
			);
		});
	}
	// Heavy Intercom state stays unloaded until the model or user invokes an
	// Intercom tool, command, shortcut, or relay that needs it.
	pi.registerTool({
		name: "intercom",
		exposure: "model-only",
		scriptAccess: intercomScriptAccess,
		detachable: (params) => intercomCallMayDetach(params) && heavyReplyWaitMayDetach("intercom", params),
		detachmentRequiresReady: true,
		label: "Intercom",
		description: `Send a message to another local agent session running on this machine.
Use this to communicate findings, request help, or coordinate work with other sessions.
Sessions belong to an intercom group and can ONLY message sessions in the same group; cross-group sends are rejected by the broker, ${RETURN_PATH_TOOL_NOTE}. Ungrouped sessions share the "default" group; with multi-node routing on, a project group (project:<owner>/<repo>).
For send, live session names, exact full session IDs, and unique 8-hex session UUID prefixes remain supported. \`send\` also takes a name glob (\`subagent-worker-*\`, or \`*\` for every session visible in your groups except you) and \`subagents:*\` (every running, released or paused subagent this session launched) or \`subagents:<runId>/*\` (those of one run); each recipient gets its own direct send, the result lists every recipient's outcome, a glob matching no session is an error naming close names, a name glob (\`*\` included) matching more than one session needs \`broadcast: true\` (without it the send is refused with the list of matches; \`subagents:\` targets broadcast without it), and patterns never reach outside your groups.
${ASK_DESCRIPTION}
For send/ask/reply, Intercom retries recoverable disconnects internally up to three times with the same operation identity. Each new tool call is a new operation. If recovery ends with an unknown delivery outcome, do not repeat it automatically.
Usage:
  intercom({ action: "list" })                    → List sessions in your group
  intercom({ action: "list", group: "name" })     → Read-only peek at another group's sessions
  intercom({ action: "join", group: "name" })     → Join or create a named group
  intercom({ action: "leave" })                   → Return to your resolved home group
  intercom({ action: "send", to: "session-name", message: "..." })  → Send message (own group only)
  intercom({ action: "send", to: "subagent-worker-*", message: "...", broadcast: true }) → Send to every matching session
  intercom({ action: "send", to: "subagents:*", message: "..." })   → Send to every subagent you launched
${ASK_USAGE}
  intercom({ action: "reply", message: "..." })                      → Reply to the active or exact pending ask
  intercom({ action: "pending" })                                      → List unresolved inbound asks and your pending asks
  intercom({ action: "status" })                  → Show connection status and your group

"default" is the shared group; "true" and "auto" are reserved for subagent auto-groups. Joining does not grant cross-group access; contact_supervisor remains the only cross-group path.`,
		promptSnippet: `Use to coordinate with other local agent sessions in your intercom group. ${ASK_PROMPT_SNIPPET} Send/ask/reply retry reconnects internally; do not automatically repeat an unknown delivery outcome.`,
		parameters: Type.Object({
			action: Type.String({ description: "Action: 'list', 'join', 'leave', 'send', 'ask', 'reply', 'pending', 'cancel', or 'status'" }),
			to: Type.Optional(Type.String({ description: "Live session name, exact full session ID, or unique 8-hex session UUID prefix. Send also takes a session-name glob (`subagent-worker-*`, `*`) or `subagents:*` / `subagents:<runId>/*` for the subagents this session launched; ask needs one exact target (for 'send', 'ask', or targeted 'reply')" })),
			message: Type.Optional(Type.String({ description: "Message to send (for 'send', 'ask', or 'reply' action)" })),
			broadcast: Type.Optional(Type.Boolean({ description: "For 'send' to a session-name glob: true to reach every match. Without it, a glob that matches more than one session is refused with the list of matches. `subagents:` targets broadcast without it." })),
			attachments: Type.Optional(Type.Array(Type.Object({
				type: Type.Union([Type.Literal("file"), Type.Literal("snippet"), Type.Literal("context")]),
				name: Type.String(),
				content: Type.String(),
				language: Type.Optional(Type.String()),
			}))),
			wait: Type.Optional(askWaitSchema),
			askId: Type.Optional(askIdSchema),
			replyTo: Type.Optional(Type.String({ description: "Exact pending-ask message ID or unique 8-hex UUID prefix; disambiguates concurrent asks, including asks from one sender" })),
			group: Type.Optional(Type.String({ description: "Group name for 'join'; read-only group filter for 'list'/'status'. 'send'/'ask' are locked to your own group." })),
		}),
		execute: (...args) => {
			const invocationLease = activeLease;
			return executeHeavyTool((ctx) => {
				// Reconnect backoff must not move an old call into a new session.
				assertLease(invocationLease);
				return loadHeavy(ctx);
			}, "intercom", args);
		},
		renderResult: (...args) => renderHeavyToolResult(loadedHeavy?.heavy ?? null, "intercom", args),
		renderCall: renderIntercomCall,
	});
	pi.registerMessageRenderer?.("intercom_message", renderIntercomCustomMessage);
	pi.registerToolRenderer?.((toolName, next) => {
		const registered = next();
		if (registered?.renderCall || registered?.renderResult || registered?.renderShell === "self") return registered;
		if (toolName === "contact_supervisor") {
			return {
				...registered,
				renderCall: renderContactSupervisorCall,
				renderResult: (...args) => renderHeavyToolResult(loadedHeavy?.heavy ?? null, "contact_supervisor", args),
			};
		}
		if (toolName === "intercom") {
			return {
				...registered,
				renderCall: renderIntercomCall,
				renderResult: (...args) => renderHeavyToolResult(loadedHeavy?.heavy ?? null, "intercom", args),
			};
		}
		return registered;
	});
	if (hasSubagentIntercomEnv()) {
		pi.registerTool({
			name: "contact_supervisor",
			exposure: "model-only",
			detachable: (params) => contactSupervisorCallMayDetach(params) && heavyReplyWaitMayDetach("contact_supervisor", params),
			detachmentRequiresReady: true,
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
			renderCall: renderContactSupervisorCall,
		});
	}

	pi.registerCommand("intercom", {
		description: "Open session intercom overlay",
		handler: (args, ctx) => runHeavyCommand(loadHeavy, args, ctx),
	});
}
