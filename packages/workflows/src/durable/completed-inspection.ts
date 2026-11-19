import type { SessionStore } from "@bastani/atomic";
import { createPostMortemStageHandle } from "../runs/foreground/postmortem-stage-chat.js";
import {
	stageControlRegistry as defaultStageControlRegistry,
	disposeAfterStageHolds,
	type StageControlHandle,
	type StageControlRegistry,
} from "../runs/foreground/stage-control-registry.js";
import type { StageAdapters } from "../runs/foreground/stage-runner.js";
import { continueStageRecord, ownsStageRecord, stageRecordOwner } from "../shared/stage-record-owner.js";
import { stageSessionStore } from "../shared/stage-session-store.js";
import { currentStageUiBroker, type StageUiBroker } from "../shared/stage-ui-broker.js";
import type { Store } from "../shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import { publishRunForOwner, runAttachmentOwner } from "../shared/workflow-run-ownership.js";
import type { DurableWorkflowBackend } from "./backend.js";
import { completedWorkflowRunSnapshots, resolveCompletedWorkflow } from "./completed-catalog.js";
import { bindRunDurableBackend } from "./run-owner-backend.js";
import type { ResumableWorkflowEntry } from "./types.js";

export type OpenCompletedDurableResult =
	| {
			readonly ok: true;
			readonly runId: string;
			readonly workflowId: string;
			readonly name: string;
			readonly message: string;
	  }
	| { readonly ok: false; readonly reason: "not_found" | "malformed" | "stale" | "active"; readonly message: string };

export interface OpenCompletedDurableDeps {
	readonly durableBackend: DurableWorkflowBackend;
	readonly store: Store;
	readonly adapters?: StageAdapters;
	readonly stageControlRegistry?: StageControlRegistry;
	readonly stageUiBroker?: StageUiBroker;
	readonly cwd?: string;
	readonly defaultSessionDir?: string;
	readonly sessionStore?: SessionStore;
	/** Seed lifecycle dedupe state before historical snapshots become observable. */
	readonly beforeRestore?: (snapshots: readonly RunSnapshot[]) => void;
}

/**
 * Inspection never owns a chat handle: the registry does. Holding either the handle or its
 * unregister closure here would keep a handle the registry already dropped (host session
 * switch, shutdown, release) reachable, along with any session it reopened.
 */
const completedChatRegistrations = new WeakMap<StageControlRegistry, Map<string, WeakRef<StageControlHandle>>>();
const completedChatUnregisters = new WeakMap<StageControlHandle, () => void>();

/**
 * Open a completed durable workflow as an immutable run snapshot. The only
 * mutable surface is a lazily reopened stage chat, which appends follow-up
 * conversation to its retained Atomic session without dispatching the workflow.
 */
export async function openCompletedDurableWorkflow(
	workflowId: string,
	deps: OpenCompletedDurableDeps,
	catalog?: readonly ResumableWorkflowEntry[],
): Promise<OpenCompletedDurableResult> {
	const selectedStore = await stageSessionStore(
		{ sessionStore: deps.sessionStore ?? deps.adapters?.sessionStore, cwd: deps.cwd },
		deps.defaultSessionDir,
	);
	const resolved = await resolveCompletedWorkflow(workflowId, deps.durableBackend, catalog, selectedStore);
	if (resolved.kind === "not_found") {
		return failure("not_found", `No completed durable workflow found for id: ${workflowId}`);
	}
	if (resolved.kind === "malformed") {
		return failure("malformed", resolved.message);
	}
	if (resolved.kind === "stale") {
		return failure(
			"stale",
			`Completed workflow ${resolved.entry.workflowId} is stale or missing durable checkpoint/session data and cannot be opened.`,
		);
	}

	// The selected run may belong to a different journal than the store's default. Take its finish order from
	// the same handle as the historical graph, not from the time of this inspection or a later journal write.
	const finishSequence = deps.durableBackend.getWorkflow(resolved.entry.workflowId)?.finishSequence;
	const snapshots = await completedWorkflowRunSnapshots(deps.durableBackend, resolved.entry, selectedStore);
	const existing = [resolved.snapshot, ...snapshots]
		.map((run) => deps.store.run(run.id))
		.find((run) => run !== undefined && run.status !== "completed");
	if (existing !== undefined) {
		return failure(
			"active",
			`Workflow ${existing.id} is already active in this session; open it with /workflows ${existing.id} instead.`,
		);
	}
	const snapshot = snapshots.find((run) => run.id === resolved.snapshot.id) ?? resolved.snapshot;
	deps.beforeRestore?.(snapshots);
	for (const restored of snapshots) {
		const previous = deps.store.run(restored.id);
		if (previous !== undefined) {
			keepInspectedChatOwners(
				previous,
				restored,
				deps.stageControlRegistry ?? defaultStageControlRegistry,
				selectedStore,
			);
			deps.store.removeRun(previous.id);
		}
		let run = restored;
		if (restored.id === snapshot.id) {
			run = { ...restored, finishSequence: finishSequence ?? restored.endedAt };
			bindRunDurableBackend(run, deps.durableBackend);
		}
		deps.store.recordRunStart(previous ? publishRunForOwner(run, runAttachmentOwner(previous)) : run);
		registerCompletedChatHandles(restored, deps, selectedStore);
	}
	const hasReopenableStage = snapshots.some((run) => run.stages.some((stage) => stage.sessionId !== undefined));
	return {
		ok: true,
		runId: snapshot.id,
		workflowId: snapshot.id,
		name: snapshot.name,
		message: `Opened completed durable workflow "${snapshot.name}" (${snapshot.id}) for read-only inspection${hasReopenableStage ? " and follow-up chat" : ""}.`,
	};
}

function failure(reason: "not_found" | "malformed" | "stale" | "active", message: string): OpenCompletedDurableResult {
	return { ok: false, reason, message };
}

function sameStoredChat(
	handle: StageControlHandle | undefined,
	stage: StageSnapshot,
	store: SessionStore,
): handle is StageControlHandle {
	return (
		handle !== undefined &&
		!handle.isDisposed &&
		stage.sessionId !== undefined &&
		handle.sessionId === stage.sessionId &&
		handle.sessionStore === store
	);
}

function keepInspectedChatOwners(
	previous: RunSnapshot,
	restored: RunSnapshot,
	registry: StageControlRegistry,
	store: SessionStore,
): void {
	if (!registry.has(previous.id)) return;
	const prior = new Map(previous.stages.map((stage) => [stage.id, stage]));
	for (const stage of restored.stages) {
		const held = registry.peek(previous.id, stage.id);
		if (!sameStoredChat(held, stage, store) || !held.stageRecord) continue;
		const row = prior.get(stage.id);
		const source = registry.registrationSource?.(held)?.record ?? stageRecordOwner(held.stageRecord);
		if (row && ownsStageRecord(source, row)) continueStageRecord(row, stage);
	}
}

function registerCompletedChatHandles(
	snapshot: RunSnapshot,
	deps: OpenCompletedDurableDeps,
	sessionStore: SessionStore,
): void {
	if (deps.adapters?.agentSession === undefined) return;
	const registry = deps.stageControlRegistry ?? defaultStageControlRegistry;
	const registrations = completedChatRegistrations.get(registry) ?? new Map();
	completedChatRegistrations.set(registry, registrations);
	const desiredKeys = new Set(
		snapshot.stages
			.filter((stage) => stage.sessionId !== undefined)
			.map((stage) => completedChatKey(snapshot.id, stage.id)),
	);
	for (const key of [...registrations.keys()]) {
		if (!key.startsWith(`${snapshot.id}:`) || desiredKeys.has(key)) continue;
		removeCompletedChatRegistration(registrations, key);
	}
	for (const stage of snapshot.stages) {
		if (stage.sessionId === undefined) continue;
		const key = completedChatKey(snapshot.id, stage.id);
		const existing = registry.peek(snapshot.id, stage.id);
		if (
			sameStoredChat(existing, stage, sessionStore) &&
			(!existing.stageRecord || ownsStageRecord(stageRecordOwner(existing.stageRecord), stage))
		)
			continue;
		const handle = createPostMortemStageHandle(
			snapshot.id,
			stage,
			stage.sessionId,
			deps.adapters,
			deps.cwd,
			deps.defaultSessionDir,
			sessionStore,
			{ store: deps.store, record: stage, stageUiBroker: deps.stageUiBroker ?? currentStageUiBroker() },
		);
		completedChatUnregisters.set(handle, registry.register(handle));
		registrations.set(key, new WeakRef(handle));
		registry.detachControl(snapshot.id, stage.id, handle);
	}
}

function completedChatKey(runId: string, stageId: string): string {
	return `${runId}:${stageId}`;
}

function removeCompletedChatRegistration(registrations: Map<string, WeakRef<StageControlHandle>>, key: string): void {
	const handle = registrations.get(key)?.deref();
	registrations.delete(key);
	if (handle === undefined) return;
	completedChatUnregisters.get(handle)?.();
	void Promise.resolve(disposeAfterStageHolds(handle)).catch((error: Error) => {
		console.warn("atomic-workflows: completed chat handle dispose failed", error);
	});
}
