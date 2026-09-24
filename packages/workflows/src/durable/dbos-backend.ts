/** DBOS-backed durable backend adapter. */

import { isDeepStrictEqual } from "node:util";
import { raceAbort } from "../shared/abort.js";
import type { WorkflowSerializableValue } from "../shared/types.js";
import {
	type DurableInactiveDeleteResult,
	type DurableWorkflowBackend,
	type DurableWorkflowCatalogEntries,
	type DurableWorkflowHydrationResult,
	InMemoryDurableBackend,
	replacePendingStageMessagesForRun,
	type WorkflowRegistrationInput,
} from "./backend.js";
import { DurableNestedTopologyError } from "./boundary-topology.js";
import {
	boundedAdmission,
	type DbosDependencyError,
	dbosAdmissionContext,
	isDbosDependencyError,
} from "./dbos-admission.js";
import { reconcileDbosAdmission } from "./dbos-admission-recovery.js";
import { classifyCheckpointPayload, encodeCheckpoint } from "./dbos-envelope.js";
import {
	claimMetadataStepName,
	classifyLatestMetadata,
	encodeMetadata,
	isMetadataStep,
	metadataStepName,
	parseCurrentMetadataRecord,
} from "./dbos-metadata.js";
import { DbosPromptReservationTracker, isDbosPromptStateStep } from "./dbos-prompt-reservations.js";
import { transitionDbosWorkflowStatus } from "./dbos-status-transition.js";
import { classifyDbosDeletionTombstone, DBOS_DELETION_STEP, encodeDbosDeletionTombstone } from "./dbos-tombstone.js";
import { inactivePromptReservationToken, type PromptReservationToken } from "./prompt-reservation-state.js";
import { isLiveRunningWorkflow } from "./resume-eligibility.js";
import type {
	DurableCheckpoint,
	WorkflowSerializableObject as DurableInputs,
	DurableWorkflowFailureMetadata,
	DurableWorkflowHandle,
	DurableWorkflowStatus,
	ResumableWorkflowEntry,
} from "./types.js";
// ---------------------------------------------------------------------------
// SDK abstraction
// ---------------------------------------------------------------------------

/**
 * Abstraction over the real `@dbos-inc/dbos-sdk` so the adapter is testable
 * without Postgres. The real factory (`createRealDbosHandle`) wraps the SDK;
 * tests supply a mock.
 */
export interface DbosSdkHandle {
	readonly launch: () => Promise<void>;
	readonly shutdown: () => Promise<void>;
	readonly startWorkflow: (
		workflowId: string,
		name: string,
		inputs: Readonly<Record<string, WorkflowSerializableValue>>,
	) => Promise<void>;
	readonly retrieveWorkflow: (workflowId: string) => Promise<DbosWorkflowInfo | undefined>;
	readonly cancelWorkflow: (workflowId: string) => Promise<void>;
	readonly resumeWorkflow: (workflowId: string) => Promise<void>;
	/** List all workflows (any status) with loaded inputs. */
	readonly listAllWorkflows: () => Promise<readonly DbosWorkflowInfo[]>;
	/** List all completed checkpoint step-records for a workflow. */
	readonly listStepRecords: (workflowId: string) => Promise<readonly DbosStepRecord[]>;
	/** Read one exact checkpoint record when the SDK supports targeted lookup. */
	readonly readStepRecord?: (workflowId: string, stepName: string) => Promise<DbosStepRecord | undefined>;
	/** Record a checkpoint step output (envelope) to DBOS. */
	readonly recordStepOutput: (
		workflowId: string,
		stepName: string,
		output: WorkflowSerializableValue,
	) => Promise<void>;
	/** Permanently delete a root workflow and all prefix checkpoint records. */
	readonly deleteWorkflowData: (workflowId: string) => Promise<void>;
}

export interface DbosWorkflowInfo {
	readonly workflowId: string;
	readonly name: string;
	readonly status: string;
	readonly createdAt: number;
	readonly inputs?: DurableInputs;
}

/** A completed checkpoint stored in DBOS, returned by `listStepRecords`. */
export interface DbosStepRecord {
	readonly stepName: string;
	readonly output: WorkflowSerializableValue;
	readonly completedAt?: number;
}

import { getDbosProcessOwner } from "./dbos-process-owner.js";
import { createRealDbosHandle, type DbosLogger, type DbosStatic, getAtomicExecutorId } from "./dbos-sdk-handle.js";
import { explicitDbosSystemDatabaseUrl } from "./dbos-system-database-url.js";
// ---------------------------------------------------------------------------
// Real SDK handle factory (lazy import, no top-level dependency)
// ---------------------------------------------------------------------------

export interface ConfiguredDbosDurability {
	readonly backend: DbosDurableBackend;
	readonly launch: () => Promise<void>;
	readonly shutdown: () => Promise<void>;
}

const SILENT_DBOS_LOGGER: DbosLogger = {
	info() {},
	debug() {},
	warn() {},
	error() {},
};

/**
 * Effective system database URL: explicit config wins over
 * `DBOS_SYSTEM_DATABASE_URL`, then the caller-selected URL. Values are trimmed so
 * env-injected URLs (secrets managers, env files) with trailing
 * whitespace/newlines connect cleanly, and a whitespace-only value means "not set".
 */
export function effectiveSystemDatabaseUrl(
	configUrl: string | undefined,
	envUrl: string | undefined = explicitDbosSystemDatabaseUrl(),
): string | undefined {
	const url = (configUrl ?? envUrl)?.trim();
	return url === undefined || url.length === 0 ? undefined : url;
}

/** Configure and register DBOS workflows without launching the executor. */
export async function configureDbosDurableBackend(config?: {
	readonly systemDatabaseUrl?: string;
}): Promise<ConfiguredDbosDurability> {
	const sdk = await importDbosSdk();
	const owner = getDbosProcessOwner();
	const existing = owner.wrappers;
	let launch = owner.active?.launch ?? (() => sdk.launch());
	let checkReady: (() => Promise<void>) | undefined;
	// The SDK forbids setConfig after launch. Recover original wrappers first.
	if (existing === undefined) {
		const url = effectiveSystemDatabaseUrl(config?.systemDatabaseUrl);
		const { configureAdmissionDatabase } = await import("./dbos-admission-config.js");
		const database = configureAdmissionDatabase(sdk, {
			name: "atomic-workflows",
			...(url === undefined ? {} : { systemDatabaseUrl: url }),
			runAdminServer: false,
			// Unique per process: concurrent Atomic sessions share one database, and
			// DBOS-level pending-workflow recovery must stay scoped to the owner.
			executorID: getAtomicExecutorId(),
			logger: SILENT_DBOS_LOGGER,
		});
		launch = database.launch;
		checkReady = database.checkReady;
	}
	const mainWorkflow =
		existing?.mainWorkflow ??
		sdk.registerWorkflow(async (_name: string, inputs: DurableInputs) => inputs, {
			name: "atomicWorkflowHandle",
		});
	const checkpointWorkflow =
		existing?.checkpointWorkflow ??
		sdk.registerWorkflow(
			async (_workflowId: string, _stepName: string, output: WorkflowSerializableValue) => output,
			{ name: "atomicWorkflowCheckpoint" },
		);
	if (existing === undefined) {
		owner.wrappers = { mainWorkflow, checkpointWorkflow };
	}
	return {
		backend: new DbosDurableBackend(createRealDbosHandle(sdk, mainWorkflow, checkpointWorkflow), {
			checkReady,
		}),
		launch,
		shutdown: () => sdk.shutdown(),
	};
}

export async function importDbosSdk(): Promise<DbosStatic> {
	try {
		// Keep a literal lazy import so builtin bundling includes the SDK and its
		// transitive JS dependencies. Compiled Bun cannot load unregistered bare
		// imports (including the SDK's ESM dependencies) from disk builtins.
		const mod = await import("@dbos-inc/dbos-sdk");
		const dbos = (mod as { readonly DBOS?: DbosStatic }).DBOS;
		if (dbos === undefined) throw new Error("@dbos-inc/dbos-sdk did not export DBOS");
		return dbos;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`@dbos-inc/dbos-sdk could not be loaded: ${msg}`);
	}
}
// ---------------------------------------------------------------------------
// Backend adapter
// ---------------------------------------------------------------------------

/**
 * DBOS-backed durable backend. Wraps a {@link DbosSdkHandle} to implement the
 * {@link DurableWorkflowBackend} interface. Writes are serialized per durable
 * root workflow, with an in-memory mirror for synchronous queries. A fresh
 * process hydrates its mirror from DBOS via {@link hydrateWorkflow} /
 * {@link hydrateResumableWorkflows} before resume/replay reads.
 *
 * cross-ref: issue #1498 — DBOS read-side hydration.
 */
export class DbosDurableBackend implements DurableWorkflowBackend {
	public readonly persistent = true;
	private readonly mem = new InMemoryDurableBackend();
	private readonly sdk: DbosSdkHandle;
	private readonly invalid = new Set<string>();
	private readonly current = new Set<string>();
	private readonly locallyRegistered = new Set<string>();
	private readonly promptReservations: DbosPromptReservationTracker;
	private readonly executorId: string;
	private readonly writeQueues = new Map<string, Promise<void>>();
	private readonly writeErrors = new Map<string, Error[]>();
	private readonly onUnavailable?: (error: DbosDependencyError) => void;
	private readonly checkReady?: () => Promise<void>;
	private admissionUnavailable = false;
	private readonly unavailableAdmissions = new Set<string>();
	private readonly unavailableCheckpoints = new Set<string>();
	private readonly pendingRecoveryAdmissions = new Set<string>();
	private readonly admissionMetadataAttempted = new Set<string>();
	private readonly admissionSettlements = new Map<string, Promise<void>>();
	private readonly admissionRecoveries = new Map<string, Promise<void>>();
	private readonly admissionRecoveryControllers = new Map<string, AbortController>();

	constructor(
		sdk: DbosSdkHandle,
		options?: {
			readonly executorId?: string;
			readonly onUnavailable?: (error: DbosDependencyError) => void;
			readonly checkReady?: () => Promise<void>;
		},
	) {
		this.sdk = sdk;
		this.executorId = options?.executorId ?? getAtomicExecutorId();
		this.onUnavailable = options?.onUnavailable;
		this.checkReady = options?.checkReady;
		this.promptReservations = new DbosPromptReservationTracker({
			pendingPrompts: (workflowId) => this.mem.getWorkflow(workflowId)?.pendingPrompts ?? 0,
			adjustPendingPrompts: (workflowId, delta) => this.mem.adjustPendingPrompts(workflowId, delta),
			persist: (workflowId, stepName, output) => {
				this.enqueueWrite(workflowId, () => this.sdk.recordStepOutput(workflowId, stepName, output));
			},
		});
	}

	isAdmissionUnavailable(workflowId: string): boolean {
		return this.unavailableAdmissions.has(workflowId);
	}
	isCheckpointUnavailable(workflowId: string): boolean {
		return this.unavailableCheckpoints.has(workflowId);
	}
	isWorkflowRecoveryPending(workflowId: string): boolean {
		return this.pendingRecoveryAdmissions.has(workflowId);
	}

	settleWorkflowAdmission(workflowId: string): Promise<void> {
		return this.admissionSettlements.get(workflowId) ?? Promise.resolve();
	}
	hasWorkflowAdmissionSettlement(workflowId: string): boolean {
		return this.admissionSettlements.has(workflowId);
	}

	admitWorkflow(
		workflowId: string,
		registration: WorkflowRegistrationInput | undefined,
		signal: AbortSignal,
	): Promise<void> {
		const pending = this.performAdmission(workflowId, registration, signal);
		this.admissionSettlements.set(workflowId, pending);
		void pending.then(
			() => {
				if (this.admissionSettlements.get(workflowId) === pending) this.admissionSettlements.delete(workflowId);
			},
			() => {},
		);
		// Keep extensible startup drains on executor admission, not control acknowledgement.
		return pending.then(async () => {
			await dbosAdmissionContext.run(signal, () => this.flush(workflowId));
			signal.throwIfAborted();
			this.admissionMetadataAttempted.delete(workflowId);
		});
	}

	private async performAdmission(
		workflowId: string,
		registration: WorkflowRegistrationInput | undefined,
		signal: AbortSignal,
	): Promise<void> {
		this.admissionMetadataAttempted.delete(workflowId);
		try {
			await raceAbort(
				dbosAdmissionContext.run(signal, async () => {
					signal.throwIfAborted();
					// Executor ownership stays ready for mirror-backed control and older
					// generations' shutdown. Only new admission needs fresh SQL health.
					if (this.admissionUnavailable) await this.checkReady?.();
					signal.throwIfAborted();
					if (registration !== undefined) this.registerWorkflow(registration);
					else this.setWorkflowStatus(workflowId, "running");
					await this.flushWrites(workflowId);
					signal.throwIfAborted();
				}),
				signal,
			);
			this.admissionUnavailable = false;
			this.unavailableAdmissions.delete(workflowId);
			this.unavailableCheckpoints.delete(workflowId);
			this.pendingRecoveryAdmissions.delete(workflowId);
		} catch (error) {
			if (isDbosDependencyError(error)) {
				this.admissionMetadataAttempted.delete(workflowId);
				this.admissionUnavailable = true;
				// Another root's successful admission must not enable cleanup of this identity.
				this.unavailableAdmissions.add(workflowId);
				this.onUnavailable?.(error);
				if (
					registration !== undefined &&
					this.mem.getWorkflow(workflowId) === undefined &&
					!this.invalid.has(workflowId)
				) {
					// Readiness may reject before registration creates its local mirror.
					// Retain validated invocation identity without scheduling a database write.
					this.mem.registerWorkflow({ ...registration, status: "failed", resumable: true });
					this.locallyRegistered.add(workflowId);
				}
			}
			throw error;
		}
	}

	async cancelUnadmittedWorkflow(workflowId: string, signal: AbortSignal): Promise<void> {
		if (!this.admissionMetadataAttempted.delete(workflowId) || this.isAdmissionUnavailable(workflowId)) return;
		if (this.mem.getWorkflow(workflowId)?.status !== "cancelled") return;
		// The aborted admission may still own a pending queue. Its signal fences
		// subsequent writes; cancellation must use a fresh, independently bounded path.
		await dbosAdmissionContext.run(signal, async () => {
			signal.throwIfAborted();
			await this.sdk.cancelWorkflow(workflowId);
			signal.throwIfAborted();
			await this.writeMetadata(workflowId);
		});
	}

	registerWorkflow(handle: WorkflowRegistrationInput): void {
		if (this.invalid.has(handle.workflowId)) {
			throw new DurableNestedTopologyError(`workflow ${handle.workflowId} contains malformed current DBOS records`);
		}
		this.invalid.delete(handle.workflowId);
		this.current.add(handle.workflowId);
		this.locallyRegistered.add(handle.workflowId);
		const pendingPrompts = this.promptReservations.registerWorkflow(
			handle.workflowId,
			handle.pendingPrompts,
			this.mem.getWorkflow(handle.workflowId)?.pendingPrompts ?? 0,
		);
		this.mem.registerWorkflow({ ...handle, pendingPrompts });
		this.enqueueWrite(handle.workflowId, async () => {
			dbosAdmissionContext.getStore()?.throwIfAborted();
			await this.sdk.startWorkflow(handle.workflowId, handle.name, handle.inputs);
			dbosAdmissionContext.getStore()?.throwIfAborted();
			if (dbosAdmissionContext.getStore()) this.admissionMetadataAttempted.add(handle.workflowId);
			await this.writeMetadata(handle.workflowId);
		});
	}

	async persistPendingStageMessages(
		workflowId: string,
		messages: readonly import("../shared/store-types.js").PendingStageMessage[],
		logicalRunId = workflowId,
	): Promise<boolean> {
		let persisted = false;
		await this.enqueueWrite(workflowId, async () => {
			if (!this.isWorkflowLoadable(workflowId)) return;
			const handle = this.mem.getWorkflow(workflowId);
			const value = this.mem.toMetadata(workflowId);
			if (handle === undefined || value === undefined) return;
			const updatedAt = Math.max(Date.now(), handle.updatedAt + 1);
			const pendingStageMessages = replacePendingStageMessagesForRun(
				handle.pendingStageMessages ?? [],
				logicalRunId,
				messages,
			);
			const metadata = {
				...this.promptReservations.metadata(workflowId, value),
				pendingStageMessages,
				ownerExecutorId: this.executorId,
				updatedAt,
			};
			await this.sdk.recordStepOutput(workflowId, metadataStepName(updatedAt), encodeMetadata(metadata));
			this.mem.registerWorkflow({ ...handle, pendingStageMessages, updatedAt });
			persisted = true;
		});
		return persisted;
	}

	recordCheckpoint(checkpoint: DurableCheckpoint): void {
		if (!this.isWorkflowLoadable(checkpoint.workflowId)) return;
		this.mem.recordCheckpoint(checkpoint);
		this.enqueueWrite(checkpoint.workflowId, () => this.persistCheckpoint(checkpoint));
	}

	async recordCheckpointAsync(
		checkpoint: DurableCheckpoint,
		options?: { readonly signal?: AbortSignal },
	): Promise<void> {
		if (!this.isWorkflowLoadable(checkpoint.workflowId)) return;
		await boundedAdmission(
			(signal) =>
				dbosAdmissionContext.run(signal, async () => {
					await this.enqueueWrite(checkpoint.workflowId, async () => {
						if (signal.aborted || !this.isWorkflowLoadable(checkpoint.workflowId)) return;
						const persist = (async () => {
							await this.persistCheckpointRecord(checkpoint);
							if (signal.aborted || !this.isWorkflowLoadable(checkpoint.workflowId)) return;
							this.mem.recordCheckpoint(checkpoint);
							await this.writeMetadata(checkpoint.workflowId);
						})();
						try {
							await raceAbort(persist, signal);
						} catch (error) {
							// Release the queue on cancellation/deadline. The operation retains
							// its aborted context, so late SDK completion cannot append metadata.
							if (!signal.aborted) throw error;
						}
					});
					signal.throwIfAborted();
				}),
			options?.signal ?? dbosAdmissionContext.getStore(),
			undefined,
			"Workflow database checkpoint timed out. Restore PostgreSQL and inspect the run before resuming; external outcomes may be unknown.",
		).catch((error: unknown) => {
			if (isDbosDependencyError(error)) {
				this.unavailableCheckpoints.add(checkpoint.workflowId);
				const errors = this.writeErrors.get(checkpoint.workflowId);
				if (errors !== undefined)
					this.writeErrors.set(
						checkpoint.workflowId,
						errors.filter((entry) => entry !== error),
					);
			}
			throw error;
		});
	}

	async recordAdditiveCheckpointBestEffort(checkpoint: DurableCheckpoint): Promise<boolean> {
		if (!this.isWorkflowLoadable(checkpoint.workflowId)) return true;
		// Encode before the best-effort storage boundary: malformed topology or
		// serialization must remain authoritative errors rather than be ignored.
		const encoded = encodeCheckpoint(checkpoint);
		if (this.unavailableCheckpoints.has(checkpoint.workflowId)) return false;
		return await this.enqueueBestEffortWrite(checkpoint.workflowId, async () => {
			if (!this.isWorkflowLoadable(checkpoint.workflowId)) return;
			await this.sdk.recordStepOutput(checkpoint.workflowId, checkpoint.checkpointId, encoded);
			this.mem.recordCheckpoint(checkpoint);
		});
	}

	private async persistCheckpoint(checkpoint: DurableCheckpoint): Promise<void> {
		await this.persistCheckpointRecord(checkpoint);
		await this.writeMetadata(checkpoint.workflowId);
	}

	private async persistCheckpointRecord(checkpoint: DurableCheckpoint): Promise<void> {
		await this.sdk.recordStepOutput(checkpoint.workflowId, checkpoint.checkpointId, encodeCheckpoint(checkpoint));
	}

	getToolOutput(workflowId: string, argsHash: string): WorkflowSerializableValue | undefined {
		return this.mem.getToolOutput(workflowId, argsHash);
	}
	getToolCheckpoint(workflowId: string, argsHash: string) {
		return this.mem.getToolCheckpoint(workflowId, argsHash);
	}
	getUiResponse(workflowId: string, promptHash: string): WorkflowSerializableValue | undefined {
		return this.mem.getUiResponse(workflowId, promptHash);
	}
	getStageOutput(workflowId: string, replayKey: string): WorkflowSerializableValue | undefined {
		return this.mem.getStageOutput(workflowId, replayKey);
	}
	getStageSession(workflowId: string, replayKey: string) {
		return this.mem.getStageSession(workflowId, replayKey);
	}
	listCheckpoints(workflowId: string): readonly DurableCheckpoint[] {
		return this.mem.listCheckpoints(workflowId);
	}
	getWorkflow(workflowId: string): DurableWorkflowHandle | undefined {
		return this.mem.getWorkflow(workflowId);
	}
	getLoadableWorkflow(workflowId: string): DurableWorkflowHandle | undefined {
		return this.isWorkflowLoadable(workflowId) ? this.mem.getWorkflow(workflowId) : undefined;
	}

	setWorkflowStatus(
		workflowId: string,
		status: DurableWorkflowStatus,
		pendingPrompts?: number,
		resumable?: boolean,
		failure?: DurableWorkflowFailureMetadata,
	): void {
		if (status === "cancelled" || status === "completed" || resumable === false) {
			this.admissionRecoveryControllers
				.get(workflowId)
				?.abort(new Error("Workflow recovery superseded by terminal control."));
		}
		if (!this.isWorkflowLoadable(workflowId)) return;
		if (pendingPrompts !== undefined) {
			this.promptReservations.setBaseline(workflowId, pendingPrompts);
		}
		this.mem.setWorkflowStatus(workflowId, status, pendingPrompts, resumable, failure);
		this.enqueueWrite(workflowId, async () => {
			if (!this.isWorkflowLoadable(workflowId)) return;
			dbosAdmissionContext.getStore()?.throwIfAborted();
			// A continuation already has authoritative metadata before resume starts.
			// Cancellation during that SDK call must still settle the known identity.
			if (status === "running" && dbosAdmissionContext.getStore()) this.admissionMetadataAttempted.add(workflowId);
			if (status === "cancelled") await this.sdk.cancelWorkflow(workflowId);
			else if (status === "running") await this.sdk.resumeWorkflow(workflowId);
			dbosAdmissionContext.getStore()?.throwIfAborted();
			await this.writeMetadata(workflowId);
		});
	}

	async transitionWorkflowStatus(
		workflowId: string,
		expected: readonly DurableWorkflowStatus[],
		status: DurableWorkflowStatus,
		pendingPrompts?: number,
		resumable?: boolean,
		expectedUpdatedAt?: number,
	): Promise<boolean> {
		let records: readonly DbosStepRecord[] = [];
		return await transitionDbosWorkflowStatus({
			expectedStatuses: expected,
			status,
			flush: () => this.flush(workflowId),
			expectedUpdatedAt,
			local: () => this.getLoadableWorkflow(workflowId),
			read: async () => {
				records = await this.sdk.listStepRecords(workflowId);
				return classifyLatestMetadata(records, workflowId);
			},
			reconcile: (entry) => {
				// Metadata stores the reservation baseline, not the live prompt count.
				const pendingPrompts = this.promptReservations.hydrate(
					workflowId,
					entry.pendingPrompts,
					records,
					entry.promptReservationEpoch,
				);
				this.applyMetadata(workflowId, { ...entry, pendingPrompts });
			},
			claim: (authoritative, generation) =>
				this.claimStatusTransition(workflowId, authoritative, generation, status, pendingPrompts, resumable),
			write: async () => {
				this.setWorkflowStatus(workflowId, status, pendingPrompts, resumable);
				await this.flush(workflowId);
			},
		});
	}

	/**
	 * The transition's metadata write IS the claim: every racer that observed
	 * first record, and a unique transition claim id identifies the winner even
	 * for concurrent callers sharing one executor. The claim itself carries the
	 * requested status metadata, so a crash cannot expose an intermediate state
	 * with stale resumability.
	 */
	private async claimStatusTransition(
		workflowId: string,
		authoritative: import("./types.js").DurableWorkflowMetadata,
		generation: number,
		status: DurableWorkflowStatus,
		pendingPrompts?: number,
		resumable?: boolean,
	): Promise<boolean> {
		const stepName = claimMetadataStepName(generation);
		const transitionClaimId = crypto.randomUUID();
		const claim: import("./types.js").DurableWorkflowMetadata = {
			...authoritative,
			status,
			...(pendingPrompts !== undefined ? { pendingPrompts } : {}),
			...(resumable !== undefined ? { resumable } : {}),
			ownerExecutorId: this.executorId,
			transitionClaimId,
			updatedAt: Math.max(Date.now(), authoritative.updatedAt + 1),
		};
		await this.sdk.recordStepOutput(workflowId, stepName, encodeMetadata(claim));
		dbosAdmissionContext.getStore()?.throwIfAborted();
		const record = this.sdk.readStepRecord
			? await this.sdk.readStepRecord(workflowId, stepName)
			: (await this.sdk.listStepRecords(workflowId)).find((candidate) => candidate.stepName === stepName);
		if (record === undefined) return false;
		return parseCurrentMetadataRecord(record, workflowId)?.transitionClaimId === transitionClaimId;
	}

	adjustPendingPrompts(workflowId: string, delta: number): void {
		if (!this.isWorkflowLoadable(workflowId)) return;
		this.promptReservations.adjust(workflowId, delta);
	}

	promptReservationScope(workflowId: string): { readonly rootWorkflowId: string; readonly scope: string } {
		return { rootWorkflowId: workflowId, scope: "root" };
	}

	pendingPromptToken(workflowId: string, reservationId: string): PromptReservationToken | undefined {
		return this.isWorkflowLoadable(workflowId) ? this.promptReservations.token(workflowId, reservationId) : undefined;
	}

	reservePendingPrompt(workflowId: string, reservationId: string): PromptReservationToken {
		if (!this.isWorkflowLoadable(workflowId)) return inactivePromptReservationToken(reservationId);
		return this.promptReservations.reserve(workflowId, reservationId);
	}

	releasePendingPrompt(workflowId: string, reservationId: string, token: PromptReservationToken): void {
		if (this.isWorkflowLoadable(workflowId)) this.promptReservations.release(workflowId, reservationId, token);
	}
	listResumableWorkflows(): readonly ResumableWorkflowEntry[] {
		// A running workflow with a fresh heartbeat is genuinely executing in SOME
		// session; it is never a resume target (double dispatch). Only crashed
		// (stale-heartbeat) running workflows remain listed.
		return this.mem
			.listResumableWorkflows()
			.filter(
				(entry) =>
					!this.invalid.has(entry.workflowId) &&
					!isLiveRunningWorkflow({ status: entry.status, updatedAt: entry.updatedAt }),
			);
	}

	listCompletedWorkflows(): readonly ResumableWorkflowEntry[] {
		return this.mem.listCompletedWorkflows().filter((entry) => !this.invalid.has(entry.workflowId));
	}

	toMetadata(workflowId: string) {
		return this.invalid.has(workflowId) ? undefined : this.mem.toMetadata(workflowId);
	}

	async prepareWorkflowCatalog(): Promise<DurableWorkflowCatalogEntries> {
		await this.hydrateResumableWorkflows();
		const catalog = await this.mem.prepareWorkflowCatalog();
		return {
			resumable: this.listResumableWorkflows(),
			completed: this.listCompletedWorkflows(),
			inspectableIds: catalog.inspectableIds?.filter((id) => !this.invalid.has(id)),
		};
	}
	async deleteWorkflow(workflowId: string): Promise<void> {
		this.admissionRecoveryControllers.get(workflowId)?.abort(new Error("Workflow deleted during recovery."));
		this.invalid.add(workflowId);
		this.current.delete(workflowId);
		this.locallyRegistered.delete(workflowId);
		this.unavailableCheckpoints.delete(workflowId);
		this.pendingRecoveryAdmissions.delete(workflowId);
		this.admissionSettlements.delete(workflowId);
		this.promptReservations.delete(workflowId);
		await this.mem.deleteWorkflow(workflowId);
		await this.enqueueWrite(workflowId, async () => {
			await this.sdk.deleteWorkflowData(workflowId);
			await this.sdk.recordStepOutput(workflowId, DBOS_DELETION_STEP, encodeDbosDeletionTombstone(workflowId));
		});
	}

	async deleteWorkflowIfInactive(workflowId: string): Promise<DurableInactiveDeleteResult> {
		await this.flush(workflowId);
		// Rejected registration can leave only an inactive local mirror. Do not
		// manufacture metadata/tombstones for an identity DBOS never accepted.
		// Any durable evidence (including malformed records), or an uncertain
		// admission outcome, must retain the authoritative deletion guards below.
		if (
			this.locallyRegistered.has(workflowId) &&
			!this.isAdmissionUnavailable(workflowId) &&
			this.mem.getWorkflow(workflowId)?.status !== "running" &&
			(await this.sdk.listStepRecords(workflowId)).length === 0 &&
			(await this.sdk.retrieveWorkflow(workflowId)) === undefined
		) {
			this.current.delete(workflowId);
			this.locallyRegistered.delete(workflowId);
			this.admissionSettlements.delete(workflowId);
			this.promptReservations.delete(workflowId);
			await this.mem.deleteWorkflow(workflowId);
			return { ok: true };
		}
		await this.hydrateWorkflow(workflowId);
		const handle = this.getLoadableWorkflow(workflowId);
		if (handle === undefined) return { ok: false, reason: "not_found" };
		if (handle.status === "running") return { ok: false, reason: "running" };
		const guarded = await this.transitionWorkflowStatus(workflowId, [handle.status], handle.status);
		if (!guarded) return { ok: false, reason: "running" };
		await this.deleteWorkflow(workflowId);
		await this.flush(workflowId);
		return { ok: true };
	}
	isWorkflowLoadable(workflowId: string): boolean {
		return !this.invalid.has(workflowId) && (this.locallyRegistered.has(workflowId) || this.current.has(workflowId));
	}
	reset(): void {
		for (const controller of this.admissionRecoveryControllers.values())
			controller.abort(new Error("Workflow backend reset."));
		this.admissionRecoveries.clear();
		this.admissionRecoveryControllers.clear();
		this.mem.reset();
		this.invalid.clear();
		this.current.clear();
		this.locallyRegistered.clear();
		this.promptReservations.clear();
		this.writeQueues.clear();
		this.writeErrors.clear();
		this.admissionUnavailable = false;
		this.unavailableAdmissions.clear();
		this.admissionMetadataAttempted.clear();
		this.admissionSettlements.clear();
		this.unavailableCheckpoints.clear();
		this.pendingRecoveryAdmissions.clear();
	}

	async flush(workflowId?: string): Promise<void> {
		await this.flushWrites(workflowId);
	}

	private async flushWrites(workflowId?: string): Promise<void> {
		const workflowIds =
			workflowId === undefined
				? [...new Set([...this.writeQueues.keys(), ...this.writeErrors.keys()])]
				: [workflowId];
		await Promise.all(workflowIds.map(async (id) => await this.writeQueues.get(id)));
		for (const id of workflowIds) {
			const errors = this.writeErrors.get(id);
			if (errors === undefined || errors.length === 0) continue;
			this.writeErrors.delete(id);
			throw errors[0];
		}
	}

	async hydrateWorkflow(workflowId: string): Promise<void> {
		await this.hydrateWorkflowForInspection(workflowId);
	}
	async hydrateWorkflowForInspection(workflowId: string): Promise<DurableWorkflowHydrationResult> {
		if (this.locallyRegistered.has(workflowId)) {
			const records = await this.sdk.listStepRecords(workflowId);
			for (const record of records) {
				if (
					isMetadataStep(record.stepName) ||
					isDbosPromptStateStep(record.stepName) ||
					record.stepName === DBOS_DELETION_STEP
				) {
					continue;
				}
				const classified = classifyCheckpointPayload(workflowId, record.stepName, record.output);
				if (classified.kind === "unknown") {
					await this.suppressWorkflow(workflowId);
					return { kind: "malformed" };
				}
				this.mem.recordCheckpoint(classified.checkpoint);
			}
			const handle = this.getLoadableWorkflow(workflowId);
			return handle === undefined ? { kind: "malformed" } : { kind: "current", handle };
		}
		const info = await this.sdk.retrieveWorkflow(workflowId);
		if (info !== undefined) return await this.hydrateInfo(info);
		const records = await this.sdk.listStepRecords(workflowId);
		const deletion = classifyDbosDeletionTombstone(records, workflowId);
		if (deletion === "absent" && records.length === 0) return { kind: "absent" };
		await this.suppressWorkflow(workflowId);
		if (deletion === "absent") return { kind: "malformed" };
		return { kind: deletion === "current" ? "deleted" : "malformed" };
	}
	async hydrateResumableWorkflows(): Promise<void> {
		const all = await this.sdk.listAllWorkflows();
		for (const info of all) {
			if (this.locallyRegistered.has(info.workflowId)) continue;
			await this.hydrateInfo(info);
		}
	}

	reconcileWorkflowAdmission(workflowId: string, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		if (!this.unavailableAdmissions.has(workflowId) && !this.unavailableCheckpoints.has(workflowId))
			return Promise.resolve();
		const existing = this.admissionRecoveries.get(workflowId);
		if (existing !== undefined) return signal === undefined ? existing : raceAbort(existing, signal);
		const controller = new AbortController();
		this.admissionRecoveryControllers.set(workflowId, controller);
		const pending = boundedAdmission(
			(admissionSignal) =>
				dbosAdmissionContext.run(admissionSignal, async () => {
					const metadata = this.mem.toMetadata(workflowId);
					if (metadata === undefined) return;
					if (metadata.resumable === false || metadata.status === "cancelled" || metadata.status === "completed")
						return;
					if (
						!(await reconcileDbosAdmission(
							this.sdk,
							this.promptReservations.metadata(workflowId, metadata),
							this.unavailableAdmissions.has(workflowId),
							this.checkReady,
						))
					) {
						await this.suppressWorkflow(workflowId);
						return;
					}
					admissionSignal.throwIfAborted();
					const info = await this.sdk.retrieveWorkflow(workflowId);
					if (info === undefined) return;
					const result = await this.hydrateInfo(info, metadata);
					if (result.kind !== "current") return;
					admissionSignal.throwIfAborted();
					// Repair only our stopped executor, never a newer foreign owner.
					if (result.handle.status === "running" && result.handle.ownerExecutorId === this.executorId) {
						await this.transitionWorkflowStatus(
							workflowId,
							["running"],
							"blocked",
							undefined,
							true,
							result.handle.updatedAt,
						);
					}
					admissionSignal.throwIfAborted();
					// Definition/input validation can still refuse resume after reconciliation.
					// Retain the same-ID route until an executor is successfully admitted.
					if (this.getWorkflow(workflowId)?.status === "blocked") this.pendingRecoveryAdmissions.add(workflowId);
					this.locallyRegistered.delete(workflowId);
					this.unavailableAdmissions.delete(workflowId);
					this.unavailableCheckpoints.delete(workflowId);
					this.admissionSettlements.delete(workflowId);
				}),
			signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]),
		);
		this.admissionRecoveries.set(workflowId, pending);
		void pending
			.finally(() => {
				if (this.admissionRecoveries.get(workflowId) !== pending) return;
				this.admissionRecoveries.delete(workflowId);
				this.admissionRecoveryControllers.delete(workflowId);
			})
			.catch(() => {});
		return pending;
	}

	private async hydrateInfo(
		info: DbosWorkflowInfo,
		expected?: Pick<DurableWorkflowHandle, "name" | "inputs">,
	): Promise<DurableWorkflowHydrationResult> {
		const records = await this.sdk.listStepRecords(info.workflowId);
		dbosAdmissionContext.getStore()?.throwIfAborted();
		const deletion = classifyDbosDeletionTombstone(records, info.workflowId);
		if (deletion !== "absent") {
			await this.suppressWorkflow(info.workflowId);
			return { kind: deletion === "current" ? "deleted" : "malformed" };
		}
		const metadata = classifyLatestMetadata(records, info.workflowId);
		if (
			metadata.kind !== "current" ||
			(expected !== undefined &&
				(metadata.metadata.name !== expected.name || !isDeepStrictEqual(metadata.metadata.inputs, expected.inputs)))
		) {
			await this.suppressWorkflow(info.workflowId);
			return { kind: "malformed" };
		}
		const checkpoints: DurableCheckpoint[] = [];
		for (const record of records) {
			if (
				isMetadataStep(record.stepName) ||
				isDbosPromptStateStep(record.stepName) ||
				record.stepName === DBOS_DELETION_STEP
			)
				continue;
			const classified = classifyCheckpointPayload(info.workflowId, record.stepName, record.output);
			if (classified.kind === "unknown") {
				await this.suppressWorkflow(info.workflowId);
				return { kind: "malformed" };
			}
			checkpoints.push(classified.checkpoint);
		}
		// This concrete in-memory deletion is synchronous. Publish its replacement
		// in the same turn so terminal control cannot interleave with an empty mirror.
		void this.mem.deleteWorkflow(info.workflowId);
		this.invalid.delete(info.workflowId);
		this.current.add(info.workflowId);
		this.applyMetadata(info.workflowId, metadata.metadata);
		for (const checkpoint of checkpoints) this.mem.recordCheckpoint(checkpoint);
		const current = this.mem.getWorkflow(info.workflowId);
		if (current === undefined) {
			await this.suppressWorkflow(info.workflowId);
			return { kind: "malformed" };
		}
		const pendingPrompts = this.promptReservations.hydrate(
			info.workflowId,
			metadata.metadata.pendingPrompts,
			records,
			metadata.metadata.promptReservationEpoch,
		);
		// Re-register instead of setWorkflowStatus: hydration is a read-side
		// reconstruction and must preserve the authoritative updatedAt, which
		// doubles as the cross-session liveness heartbeat for running handles.
		this.applyMetadata(info.workflowId, {
			...metadata.metadata,
			pendingPrompts,
			completedCheckpoints: current.completedCheckpoints,
		});
		const handle = this.getLoadableWorkflow(info.workflowId);
		if (handle !== undefined) return { kind: "current", handle };
		await this.suppressWorkflow(info.workflowId);
		return { kind: "malformed" };
	}

	private async suppressWorkflow(workflowId: string): Promise<void> {
		this.invalid.add(workflowId);
		this.current.delete(workflowId);
		this.pendingRecoveryAdmissions.delete(workflowId);
		this.promptReservations.delete(workflowId);
		await this.mem.deleteWorkflow(workflowId);
	}

	private enqueueWrite(workflowId: string, fn: () => Promise<void>): Promise<void> {
		const signal = dbosAdmissionContext.getStore();
		if (signal?.aborted) return Promise.resolve();
		const previous = this.writeQueues.get(workflowId) ?? Promise.resolve();
		const next = previous.then(async () => {
			if (!signal?.aborted) await fn();
		});
		const tracked = next.catch((err) => {
			const error = err instanceof Error ? err : new Error(String(err));
			const errors = this.writeErrors.get(workflowId) ?? [];
			errors.push(error);
			this.writeErrors.set(workflowId, errors);
			// The next readiness/flush boundary for this workflow surfaces the fatal persistence error.
		});
		this.trackWriteQueue(workflowId, tracked);
		return next;
	}

	private async enqueueBestEffortWrite(workflowId: string, fn: () => Promise<void>): Promise<boolean> {
		const previous = this.writeQueues.get(workflowId) ?? Promise.resolve();
		const next = previous.then(fn, fn);
		this.trackWriteQueue(
			workflowId,
			next.catch(() => undefined),
		);
		return await next.then(
			() => true,
			() => false,
		);
	}

	private trackWriteQueue(workflowId: string, queue: Promise<void>): void {
		this.writeQueues.set(workflowId, queue);
		void queue.finally(() => {
			if (this.writeQueues.get(workflowId) === queue) this.writeQueues.delete(workflowId);
		});
	}

	private async writeMetadata(workflowId: string): Promise<void> {
		const value = this.mem.toMetadata(workflowId);
		if (value === undefined) return;
		const metadata = {
			...this.promptReservations.metadata(workflowId, value),
			// Ownership provenance: consulted for `running` handles to distinguish a
			// workflow live in another Atomic session from a crashed one.
			ownerExecutorId: this.executorId,
		};
		await this.sdk.recordStepOutput(workflowId, metadataStepName(metadata.updatedAt), encodeMetadata(metadata));
	}

	private applyMetadata(workflowId: string, metadata: import("./types.js").DurableWorkflowMetadata): void {
		if (metadata.workflowId !== workflowId) return;
		this.mem.registerWorkflow(metadata);
	}
}

// Metadata encoding/classification lives in dbos-metadata.ts to keep this adapter focused.
