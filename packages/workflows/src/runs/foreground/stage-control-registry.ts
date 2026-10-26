/**
 * Live stage-control registry — runtime-only handle table keyed by
 * `runId + stageId`. Snapshots in `StoreSnapshot` are JSON-cloned and
 * cannot carry function/AgentSession references, so live "attach a
 * pane to this stage" wiring lives here instead.
 *
 * The registry exposes:
 *  - `StageControlHandle` — per-stage prompt/steer/follow-up/pause/resume
 *    surface used by the attached chat pane.
 *  - `WorkflowRunControlHandle` — per-run aggregate used by `/workflow pause`
 *    and `/workflow resume` to fan an action across the stages that are
 *    actually pausable right now.
 *
 * A completed stage may keep its chat handle alive while being detached from
 * run-level pause/resume control. That lets the chat stay interactive without
 * letting a finished stage keep blocking or pausing downstream work.
 *
 * The registry does not know about Pi SDK details; it talks to the
 * stage-runner via a small interface so tests can fake it without a real
 * `AgentSession`.
 *
 * cross-ref:
 *   - src/runs/foreground/stage-runner.ts (InternalStageContext)
 *   - src/runs/foreground/executor.ts (registers/unregisters handles)
 *   - pi docs/sdk.md (AgentSession.prompt/steer/followUp/abort)
 */

import type { AgentSession, AgentSessionEvent, SessionStore } from "@bastani/atomic";
import { createSessionScopedSingleton } from "../../shared/session-scoped-singleton.js";
import type { StageDeliveryActivityEvent } from "./stage-delivery-activity.js";
import type { StageQueuedUserMessages } from "./stage-queued-user-messages.js";
import type { StageUserMessageDeliveryAction } from "./stage-runner-types.js";

export type StageControlStatus =
	| "pending"
	| "running"
	| "awaiting_input"
	| "paused"
	| "blocked"
	| "completed"
	| "failed"
	| "skipped";

export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

/** Where a stage's session runs when it is not this process: a local worker's attempt. */
export interface StagePlacement {
	readonly kind: "local-worker";
	readonly workId: string;
	readonly generation: number;
}

/**
 * Per-stage interactive surface exposed to the attached chat pane.
 *
 * Implementations wrap an `InternalStageContext` (which lazily creates
 * the underlying Pi SDK `AgentSession`) and add controlled pause/resume
 * semantics that the raw SDK does not provide.
 */
export interface StageControlHandle {
	readonly runId: string;
	readonly stageId: string;
	readonly stageName: string;
	readonly status: StageControlStatus;
	readonly sessionId: string | undefined;
	readonly sessionStore?: import("@bastani/atomic").SessionStore;
	readonly sessionFile: string | undefined;
	readonly isStreaming: boolean;
	/** True after the executor has released the live SDK session behind this handle. */
	readonly isDisposed?: boolean;
	readonly messages: AgentSession["messages"];
	/** Live coding-agent session when available, used by embedded chat/footer UI. */
	readonly agentSession?: AgentSession;
	/** Replayable in-flight tool starts/partial updates for stage-chat remounts. */
	pendingToolExecutionEvents?(): readonly AgentSessionEvent[];
	/**
	 * The assistant message still streaming, for a handle without an `agentSession` (a stage
	 * on a local worker). Handles with a session expose it through the session instead.
	 */
	streamingMessage?(): NonNullable<NonNullable<AgentSession["agent"]>["state"]["streamingMessage"]> | undefined;
	/** Set when the stage's session runs in another process. */
	readonly placement?: StagePlacement;
	/**
	 * Pending steering/follow-up text on this stage's session, kept current from
	 * `queue_update` for the handle's whole lifetime so a detached graph node and
	 * a remounted stage chat can both read it. Deliberately independent of
	 * `agentSession`: an adapter-backed runtime that publishes the ordinary
	 * events keeps queue-aware UI.
	 */
	queuedUserMessages?(): StageQueuedUserMessages;
	/** Ensure the SDK session exists. Cheap when already attached. */
	ensureAttached(): Promise<void>;
	/**
	 * Deliver through the idle-aware session primitive and report the action.
	 * `beforeDelivery` must run synchronously after async setup and immediately
	 * before the underlying SDK admits or queues the message.
	 */
	sendUserMessage?(
		text: string,
		options?: import("../../shared/types.js").StageSendUserMessageOptions,
		beforeDelivery?: () => void,
	): Promise<StageUserMessageDeliveryAction>;

	/** Send a prompt. Use only when the stage is idle / not streaming. */
	prompt(text: string): Promise<void>;
	/** Steer the current streaming operation (interrupt mid-turn). */
	steer(text: string): Promise<void>;
	/** Queue a follow-up after the current operation completes. */
	followUp(text: string): Promise<void>;
	/**
	 * True controlled pause. Aborts the current Pi op without finalizing
	 * the stage as failed; the original `prompt()` awaiter is held until
	 * `resume()` is called.
	 */
	pause(): Promise<void>;
	/**
	 * Release a paused stage. If `message` is provided it is sent as the
	 * next user message before resuming. `beforeResume` guards final admission.
	 */
	resume(message?: string, beforeResume?: () => void): Promise<undefined | StageUserMessageDeliveryAction>;
	/**
	 * Subscribe to AgentSession events. The pending-listener semantics
	 * from `InternalStageContext.subscribe` apply: listeners registered
	 * before the session exists are buffered and bound on first attach.
	 */
	subscribe(listener: AgentSessionEventListener): () => void;
	/**
	 * Subscribe to workflow-owned delivery lifecycle facts. Present only for
	 * handles backed by a live stage runner. An accepted idle delivery reports
	 * `delivery_start` before the public `agent_start` is published, letting an
	 * attached chat show Working for the whole turn.
	 */
	subscribeDeliveryActivity?(listener: (event: StageDeliveryActivityEvent) => void): () => void;
	/** Release the underlying SDK session and unregister this direct chat handle. */
	dispose?(): void | Promise<void>;
	/**
	 * Present on a handle whose live session can be dropped once the stage is
	 * complete and saved, then reopened from its transcript on demand.
	 */
	readonly releaseGate?: StageSessionReleaseGate;
}

export interface StageSessionReleaseGate {
	/**
	 * The store holding the stage's saved transcript once the stage is complete and that
	 * transcript reopens without the live session; undefined until then.
	 */
	savedForReopen(): Promise<SessionStore | undefined>;
	/** Synchronous: true while no subscriber, message, turn, queue, or pause work needs the live session. */
	idle(): boolean;
}

/** Tentative ownership used until final message admission. */
export interface DetachedStageHandleLease {
	readonly handle: StageControlHandle;
	/** Keep the handle registered after admission; false when it was displaced. */
	commit(): boolean;
	/** Release tentative ownership and dispose an unclaimed provisional handle. */
	release(): Promise<void>;
}

/**
 * Per-run aggregate. Fans pause/resume to currently-running stage
 * handles. Backed by the same `StageControlRegistry`.
 */
export interface WorkflowRunControlHandle {
	readonly runId: string;
	/** Stage handles still participating in run-level workflow control. */
	stages(): readonly StageControlHandle[];
	/** Currently paused stage handles. */
	pausedStages(): readonly StageControlHandle[];
	/**
	 * Pause every currently running stage (or the specific stage when
	 * `stageId` is supplied). Returns every handle whose pause state changed,
	 * including cascade-blocked descendants; keeping the array return preserves
	 * existing slash-command iteration ergonomics.
	 */
	pause(stageId?: string): Promise<readonly StageControlHandle[]>;
	/**
	 * Resume every paused stage (or the specific stage when `stageId`
	 * is supplied). `message`, if given, is forwarded to each resumed
	 * stage as the next user message.
	 */
	resume(stageId?: string, message?: string): Promise<readonly StageControlHandle[]>;
}

export interface StageControlRegistry {
	/** Changes whenever cleanup invalidates pending asynchronous handle acquisition. */
	readonly generation: number;
	/**
	 * Register a stage handle. The returned disposer removes the chat handle
	 * entirely. Stage completion should normally call `detachControl()` first so
	 * run-level pause/resume stops seeing the stage while any open chat pane can
	 * keep using its direct handle reference.
	 */
	register(handle: StageControlHandle): () => void;
	/**
	 * Atomically resolve an existing non-disposed handle for `runId + stageId`
	 * or create one via `create`, register it, and immediately detach it from
	 * run-level pause/resume control. Used by the post-mortem stage-chat
	 * resolver so repeated attach/send calls single-flight onto one detached
	 * writer per real stage instead of racing competing sessions.
	 */
	getOrCreateDetached(runId: string, stageId: string, create: () => StageControlHandle): StageControlHandle;
	/**
	 * Acquire tentative ownership of a detached handle. A newly-created handle
	 * stays provisional until one lease commits or an ordinary consumer claims
	 * it through `claim()` / `getOrCreateDetached()`.
	 */
	acquireDetached(runId: string, stageId: string, create: () => StageControlHandle): DetachedStageHandleLease;
	/** Inspect without claiming a provisional detached handle. */
	peek(runId: string, stageId: string): StageControlHandle | undefined;
	/** Resolve and permanently claim a provisional detached handle. */
	claim(runId: string, stageId: string): StageControlHandle | undefined;
	/**
	 * Remove this stage from run-level pause/resume aggregates while keeping
	 * `get()` chat attachment live until the registration disposer runs.
	 */
	detachControl(runId: string, stageId: string, handle?: StageControlHandle): boolean;
	/** Resolve one stage handle by run + stage id, including detached chats. */
	get(runId: string, stageId: string): StageControlHandle | undefined;
	/** Owning store retained after a live handle is removed, until the registry is cleared. */
	getSessionStore(runId: string, stageId: string): SessionStore | undefined;
	/** Resolve all currently-registered chat handles for a run. */
	forRun(runId: string): readonly StageControlHandle[];
	/** True when this run currently has a registration map. */
	has(runId: string): boolean;
	/** Build a run-level control aggregate. Cheap; not memoised. */
	run(runId: string): WorkflowRunControlHandle;
	/**
	 * Drop registrations and invoke each handle's optional dispose hook. With a
	 * run ID, release only that run; otherwise clear the host session boundary.
	 */
	clear(runId?: string): Promise<void>;
	/**
	 * Drop only handles detached from run-level control (`controlsDependencies`
	 * false), disposing them through the background-dispose path. Live executor
	 * handles that still own workflow execution stay registered. Emptied run
	 * maps are pruned.
	 */
	clearDetached(): Promise<void>;
	/**
	 * Dispose and unregister this run's completed stage handles whose saved
	 * transcript reopens on demand and that nothing is using: no mounted chat,
	 * detached lease, message, turn, queue, or pause work. The remaining handles
	 * stay registered; a released stage reopens through the post-mortem loader.
	 */
	releaseIdle(runId: string): Promise<void>;
	/**
	 * Observe stages `releaseIdle` disposed. Each listener runs once per released
	 * stage after its session is gone, so it can leave a route that reopens the
	 * stage on demand. Returns the unsubscribe function.
	 */
	onStageReleased(listener: (stage: ReleasedStage) => void): () => void;
}

/** What remains of a stage whose session was released: ids only, never a session or store. */
export interface ReleasedStage {
	readonly runId: string;
	readonly stageId: string;
	readonly stageName: string;
	readonly sessionId: string;
}

/**
 * In-memory implementation. Handles live in a `Map<runId, Map<stageId, handle>>`
 * so per-run lookups stay cheap as workflows scale.
 */
export function createStageControlRegistry(): StageControlRegistry {
	type RegistryEntry = {
		handle: StageControlHandle;
		controlsDependencies: boolean;
		permanent: boolean;
		readonly leases: Set<symbol>;
		/** Bumped whenever a consumer acquires the handle, so an in-flight release can tell it was claimed. */
		epoch: number;
		disposal?: Promise<void>;
	};

	const _byRun = new Map<string, Map<string, RegistryEntry>>();
	const pendingDisposals = new Set<Promise<void>>();
	const sessionStores = new Map<string, Map<string, SessionStore>>();
	const releaseListeners = new Set<(stage: ReleasedStage) => void>();
	let generation = 0;
	function rememberSessionStore(
		handle: StageControlHandle,
		store: SessionStore | undefined = handle.sessionStore,
	): void {
		if (store === undefined) return;
		let stores = sessionStores.get(handle.runId);
		if (stores === undefined) {
			stores = new Map();
			sessionStores.set(handle.runId, stores);
		}
		stores.set(handle.stageId, store);
	}

	function ensureRun(runId: string): Map<string, RegistryEntry> {
		let runMap = _byRun.get(runId);
		if (!runMap) {
			runMap = new Map();
			_byRun.set(runId, runMap);
		}
		return runMap;
	}

	function controlledEntries(runId: string): RegistryEntry[] {
		const runMap = _byRun.get(runId);
		if (!runMap) return [];
		return [...runMap.values()].filter((entry) => entry.controlsDependencies);
	}

	function disposeEntry(entry: RegistryEntry): Promise<void> {
		if (entry.disposal !== undefined) return entry.disposal;
		try {
			entry.disposal = Promise.resolve(entry.handle.dispose?.());
		} catch (error) {
			entry.disposal = Promise.reject(error);
		}
		const disposal = entry.disposal;
		pendingDisposals.add(disposal);
		void disposal.then(
			() => pendingDisposals.delete(disposal),
			() => {},
		);
		return entry.disposal;
	}

	async function disposeEntries(entries: RegistryEntry[]): Promise<void> {
		const disposals = new Set([...entries.map(disposeEntry), ...pendingDisposals]);
		const results = await Promise.allSettled(disposals);
		for (const disposal of disposals) pendingDisposals.delete(disposal);
		const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (errors.length > 0) throw new AggregateError(errors, errors.map(String).join("; "));
	}

	function disposeEntryInBackground(entry: RegistryEntry, message: string): void {
		void disposeEntry(entry).catch((err: unknown) => console.warn(message, err));
	}

	async function releaseIdleEntry(runId: string, stageId: string, entry: RegistryEntry): Promise<void> {
		const gate = entry.handle.releaseGate;
		if (gate === undefined || entry.disposal !== undefined) return;
		const epoch = entry.epoch;
		const savedIn = await gate.savedForReopen();
		if (savedIn === undefined) return;
		// Nothing below may await before the entry is removed: a consumer that
		// claimed, leased, or messaged the handle during the transcript check
		// must see it released or keep it, never half of each.
		const runMap = _byRun.get(runId);
		if (runMap?.get(stageId) !== entry || entry.epoch !== epoch || entry.leases.size > 0) return;
		if (entry.disposal !== undefined || !gate.idle()) return;
		const { stageName, sessionId } = entry.handle;
		rememberSessionStore(entry.handle, savedIn);
		runMap.delete(stageId);
		if (runMap.size === 0) _byRun.delete(runId);
		await disposeEntry(entry);
		if (sessionId === undefined) return;
		for (const listener of [...releaseListeners]) {
			try {
				listener({ runId, stageId, stageName, sessionId });
			} catch (error) {
				console.warn("atomic-workflows: released stage listener failed", error);
			}
		}
	}

	function makeRunHandle(runId: string): WorkflowRunControlHandle {
		return {
			runId,
			stages(): readonly StageControlHandle[] {
				return controlledEntries(runId).map((entry) => entry.handle);
			},
			pausedStages(): readonly StageControlHandle[] {
				return controlledEntries(runId)
					.map((entry) => entry.handle)
					.filter((h) => h.status === "paused");
			},
			async pause(stageId?: string): Promise<readonly StageControlHandle[]> {
				const runMap = _byRun.get(runId);
				if (!runMap) return [];
				const controlEntries = controlledEntries(runId);
				const targets = stageId
					? [runMap.get(stageId)]
							.filter((entry): entry is RegistryEntry => entry?.controlsDependencies === true)
							.map((entry) => entry.handle)
					: controlEntries
							.map((entry) => entry.handle)
							.filter((h) => h.status === "running" || h.status === "pending");
				const before = new Map(controlEntries.map((entry) => [entry.handle.stageId, entry.handle.status]));
				for (const handle of targets) {
					if (handle.status === "paused") continue;
					if (handle.status === "completed" || handle.status === "failed" || handle.status === "skipped") continue;
					await handle.pause();
				}
				return controlledEntries(runId)
					.map((entry) => entry.handle)
					.filter((handle) => {
						const previous = before.get(handle.stageId);
						return previous !== handle.status && (handle.status === "paused" || handle.status === "blocked");
					});
			},
			async resume(stageId?: string, message?: string): Promise<readonly StageControlHandle[]> {
				const runMap = _byRun.get(runId);
				if (!runMap) return [];
				const controlEntries = controlledEntries(runId);
				const before = new Map(controlEntries.map((entry) => [entry.handle.stageId, entry.handle.status]));
				const targets = stageId
					? [runMap.get(stageId)]
							.filter((entry): entry is RegistryEntry => entry?.controlsDependencies === true)
							.map((entry) => entry.handle)
					: controlEntries.map((entry) => entry.handle).filter((h) => h.status === "paused");
				for (const handle of targets) {
					if (handle.status !== "paused") continue;
					await handle.resume(message);
				}
				return controlledEntries(runId)
					.map((entry) => entry.handle)
					.filter((handle) => {
						const previous = before.get(handle.stageId);
						return (previous === "paused" || previous === "blocked") && previous !== handle.status;
					});
			},
		};
	}

	return {
		get generation() {
			return generation;
		},
		register(handle: StageControlHandle): () => void {
			rememberSessionStore(handle);
			const runMap = ensureRun(handle.runId);
			const displaced = runMap.get(handle.stageId);
			runMap.set(handle.stageId, {
				handle,
				controlsDependencies: true,
				permanent: true,
				leases: new Set(),
				epoch: 0,
			});
			if (displaced !== undefined && displaced.handle !== handle && !displaced.permanent) {
				disposeEntryInBackground(displaced, "atomic-workflows: displaced provisional stage handle dispose failed");
			}
			return () => {
				const existing = _byRun.get(handle.runId);
				if (!existing) return;
				if (existing.get(handle.stageId)?.handle === handle) {
					rememberSessionStore(handle);
					existing.delete(handle.stageId);
				}
				if (existing.size === 0) _byRun.delete(handle.runId);
			};
		},
		getOrCreateDetached(runId: string, stageId: string, create: () => StageControlHandle): StageControlHandle {
			const runMap = ensureRun(runId);
			const existing = runMap.get(stageId);
			if (existing !== undefined && existing.handle.isDisposed !== true) {
				existing.permanent = true;
				existing.epoch += 1;
				return existing.handle;
			}
			if (existing !== undefined) {
				runMap.delete(stageId);
				disposeEntryInBackground(existing, "atomic-workflows: stale stage handle dispose failed");
			}
			const handle = create();
			runMap.set(handle.stageId, {
				handle,
				controlsDependencies: false,
				permanent: true,
				leases: new Set(),
				epoch: 0,
			});
			return handle;
		},
		acquireDetached(runId: string, stageId: string, create: () => StageControlHandle): DetachedStageHandleLease {
			const runMap = ensureRun(runId);
			let entry = runMap.get(stageId);
			if (entry?.handle.isDisposed === true) {
				runMap.delete(stageId);
				disposeEntryInBackground(entry, "atomic-workflows: stale stage handle dispose failed");
				entry = undefined;
			}
			if (entry === undefined) {
				entry = {
					handle: create(),
					controlsDependencies: false,
					permanent: false,
					leases: new Set(),
					epoch: 0,
				};
				runMap.set(stageId, entry);
			}
			const leasedEntry = entry;
			leasedEntry.epoch += 1;
			const token = Symbol("detached-stage-handle-lease");
			leasedEntry.leases.add(token);
			let settled = false;
			return {
				handle: leasedEntry.handle,
				commit() {
					if (settled) return false;
					if (runMap.get(stageId) !== leasedEntry || leasedEntry.disposal !== undefined) {
						return false;
					}
					settled = true;
					leasedEntry.leases.delete(token);
					leasedEntry.permanent = true;
					return true;
				},
				async release() {
					if (settled) return;
					settled = true;
					leasedEntry.leases.delete(token);
					if (runMap.get(stageId) !== leasedEntry) {
						if (leasedEntry.disposal !== undefined) await leasedEntry.disposal;
						return;
					}
					if (leasedEntry.permanent || leasedEntry.leases.size > 0) return;
					runMap.delete(stageId);
					if (runMap.size === 0) _byRun.delete(runId);
					await disposeEntry(leasedEntry);
				},
			};
		},
		detachControl(runId: string, stageId: string, handle?: StageControlHandle): boolean {
			const entry = _byRun.get(runId)?.get(stageId);
			if (!entry) return false;
			if (handle !== undefined && entry.handle !== handle) return false;
			rememberSessionStore(entry.handle);
			if (!entry.controlsDependencies) return false;
			entry.controlsDependencies = false;
			return true;
		},
		peek(runId: string, stageId: string): StageControlHandle | undefined {
			return _byRun.get(runId)?.get(stageId)?.handle;
		},
		claim(runId: string, stageId: string): StageControlHandle | undefined {
			const entry = _byRun.get(runId)?.get(stageId);
			if (entry !== undefined) {
				entry.permanent = true;
				entry.epoch += 1;
			}
			return entry?.handle;
		},
		get(runId: string, stageId: string): StageControlHandle | undefined {
			return _byRun.get(runId)?.get(stageId)?.handle;
		},
		getSessionStore(runId: string, stageId: string): SessionStore | undefined {
			return _byRun.get(runId)?.get(stageId)?.handle.sessionStore ?? sessionStores.get(runId)?.get(stageId);
		},
		forRun(runId: string): readonly StageControlHandle[] {
			const runMap = _byRun.get(runId);
			if (!runMap) return [];
			return [...runMap.values()].map((entry) => entry.handle);
		},
		has(runId: string): boolean {
			return _byRun.has(runId);
		},
		run(runId: string): WorkflowRunControlHandle {
			return makeRunHandle(runId);
		},
		async clear(runId?: string): Promise<void> {
			if (runId === undefined) generation += 1;
			const entries =
				runId === undefined
					? [..._byRun.values()].flatMap((runMap) => [...runMap.values()])
					: [...(_byRun.get(runId)?.values() ?? [])];
			if (runId === undefined) {
				_byRun.clear();
				sessionStores.clear();
			} else {
				_byRun.get(runId)?.clear();
				_byRun.delete(runId);
				sessionStores.delete(runId);
			}
			await disposeEntries(entries);
		},
		async clearDetached(): Promise<void> {
			const entries: RegistryEntry[] = [];
			generation += 1;
			for (const [runId, runMap] of [..._byRun]) {
				for (const [stageId, entry] of [...runMap]) {
					if (entry.controlsDependencies) continue;
					rememberSessionStore(entry.handle);
					runMap.delete(stageId);
					entries.push(entry);
				}
				if (runMap.size === 0) _byRun.delete(runId);
			}
			await disposeEntries(entries);
		},
		async releaseIdle(runId: string): Promise<void> {
			for (const [stageId, entry] of [...(_byRun.get(runId) ?? [])]) {
				try {
					await releaseIdleEntry(runId, stageId, entry);
				} catch (error) {
					console.warn("atomic-workflows: completed stage session release failed", error);
				}
			}
		},
		onStageReleased(listener: (stage: ReleasedStage) => void): () => void {
			releaseListeners.add(listener);
			return () => {
				releaseListeners.delete(listener);
			};
		},
	};
}

/**
 * Process-wide registry. Tests and embedders SHOULD prefer passing an
 * explicit instance via `RunOpts.stageControlRegistry`; the singleton
 * is the default consumer surface used by the extension factory.
 */
const SESSION_KEY = "workflows:stage-control:v1";
const singleton = createSessionScopedSingleton(SESSION_KEY, createStageControlRegistry);

export const stageControlRegistry: StageControlRegistry = singleton.facade;

export function adoptStageControlRegistry(
	scope: object,
	preserveCurrentWhenTargetExists = false,
): StageControlRegistry {
	return singleton.adopt(scope, {
		preserveCurrentWhenTargetExists: preserveCurrentWhenTargetExists ? () => true : undefined,
	});
}

export function currentStageControlRegistry(): StageControlRegistry {
	return singleton.current();
}
