/**
 * Real `@dbos-inc/dbos-sdk` handle factory.
 *
 * Wraps the DBOS static executor into the {@link DbosSdkHandle} seam used by
 * {@link DbosDurableBackend}. Kept separate from the backend adapter so both
 * files stay focused.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import type { WorkflowSerializableValue } from "../shared/types.js";
import type { DbosSdkHandle, DbosStepRecord, DbosWorkflowInfo } from "./dbos-backend.js";
import { claimMetadataStepName, classifyLatestMetadata, encodeMetadata, metadataStepName } from "./dbos-metadata.js";
import { type DbosOwnerFence, isDatabaseExecutor } from "./dbos-owner-fence.js";
import { getDbosProcessOwner } from "./dbos-process-owner.js";
import type { DbosRowAuthority } from "./dbos-row-guard.js";

interface DbosWorkflowHandle {
	readonly workflowID?: string;
	getStatus(): Promise<DbosStatus | null>;
	getResult(): Promise<WorkflowSerializableValue>;
}

interface DbosStatus {
	readonly workflowID?: string;
	readonly workflowId?: string;
	readonly workflowName?: string;
	readonly name?: string;
	readonly status?: string;
	readonly createdAt?: number;
	readonly input?: readonly WorkflowSerializableValue[];
	readonly output?: WorkflowSerializableValue;
}

/**
 * Unique executor identity for this Atomic process. Multiple concurrent Atomic
 * sessions share one DBOS database; a per-process id keeps DBOS-level recovery
 * and workflow ownership scoped to the process that actually runs the work.
 */
export function getAtomicExecutorId(): string {
	const owner = getDbosProcessOwner();
	owner.executorId ??= `atomic-db-${crypto.randomUUID()}`;
	return owner.executorId;
}

export interface DbosLogger {
	info(value: unknown, metadata?: object): void;
	debug(value: unknown, metadata?: object): void;
	warn(value: unknown, metadata?: object): void;
	error(value: unknown, metadata?: object): void;
}

export interface DbosConfiguration {
	readonly name: string;
	readonly systemDatabaseUrl?: string;
	readonly systemDatabasePool?: import("pg").Pool;
	readonly runAdminServer: boolean;
	readonly executorID: string;
	readonly logger: DbosLogger;
}

export interface DbosStatic {
	setConfig(config: DbosConfiguration): void;
	launch(): Promise<void>;
	shutdown(): Promise<void>;
	registerWorkflow<Args extends readonly WorkflowSerializableValue[]>(
		fn: (...args: Args) => Promise<WorkflowSerializableValue>,
		config?: { readonly name?: string },
	): (...args: Args) => Promise<WorkflowSerializableValue>;
	startWorkflow<Args extends readonly WorkflowSerializableValue[]>(
		target: (...args: Args) => Promise<WorkflowSerializableValue>,
		params?: { readonly workflowID?: string },
	): (...args: Args) => Promise<DbosWorkflowHandle>;
	retrieveWorkflow(workflowId: string): DbosWorkflowHandle;
	resumeWorkflow(workflowId: string): Promise<DbosWorkflowHandle>;
	cancelWorkflow(workflowId: string, options?: { readonly cancelChildren?: boolean }): Promise<void>;
	listWorkflows(input: Record<string, WorkflowSerializableValue>): Promise<readonly DbosStatus[]>;
	deleteWorkflows(workflowIds: string[], deleteChildren?: boolean): Promise<void>;
}

export function createRealDbosHandle(
	dbos: DbosStatic,
	mainWorkflow: (
		name: string,
		inputs: Record<string, WorkflowSerializableValue>,
	) => Promise<WorkflowSerializableValue>,
	checkpointWorkflow: (
		workflowId: string,
		stepName: string,
		output: WorkflowSerializableValue,
	) => Promise<WorkflowSerializableValue>,
	fence?: DbosOwnerFence,
	previousExecutorIds: readonly string[] = [],
): DbosSdkHandle {
	const checkpointId = (workflowId: string, stepName: string): string => `${workflowId}:checkpoint:${stepName}`;
	async function stepRecord(status: DbosStatus, prefix: string): Promise<DbosStepRecord | undefined> {
		if (status.status !== "SUCCESS") return undefined;
		const id = status.workflowID ?? status.workflowId ?? "";
		if (!id.startsWith(prefix)) return undefined;
		const stepName = id.slice(prefix.length);
		if (stepName.length === 0) return undefined;
		// DBOS listings use safeParse: strings may be raw text from a decoding
		// failure. Keep strict getResult errors for ambiguous/missing outputs;
		// reuse decoded non-strings (including checkpoint envelopes) in bulk.
		const output =
			status.output === undefined || typeof status.output === "string"
				? await dbos.retrieveWorkflow(id).getResult()
				: status.output;
		return { stepName, output, completedAt: status.createdAt };
	}
	const raw: DbosSdkHandle = {
		launch: () => dbos.launch(),
		shutdown: () => dbos.shutdown(),
		async startWorkflow(workflowId, name, inputs) {
			if (fence !== undefined) {
				const existing = await raw.retrieveWorkflow(workflowId);
				if (existing !== undefined) {
					if (existing.name !== name || !isDeepStrictEqual(existing.inputs, inputs))
						throw new Error("Workflow root identity changed during admission");
					return;
				}
			}
			try {
				await dbos.startWorkflow(mainWorkflow, { workflowID: workflowId })(name, { ...inputs });
			} catch (err) {
				if (!isDbosDuplicateWorkflowError(err)) throw err;
			}
		},
		async retrieveWorkflow(workflowId) {
			const statuses = await dbos.listWorkflows({ workflowIDs: [workflowId], loadInput: true, limit: 1 });
			const status = statuses[0];
			if (status === undefined) return undefined;
			return statusToInfo(status, workflowId);
		},
		async cancelWorkflow(workflowId) {
			await dbos.cancelWorkflow(workflowId, { cancelChildren: true });
		},
		async resumeWorkflow(workflowId) {
			if (fence === undefined) await dbos.resumeWorkflow(workflowId);
			else if ((await raw.retrieveWorkflow(workflowId)) === undefined)
				throw new Error("Workflow root is unavailable for resume");
		},
		async listAllWorkflows() {
			const statuses = await dbos.listWorkflows({
				workflowName: "atomicWorkflowHandle",
				loadInput: true,
				sortDesc: true,
			});
			return statuses.map((s) => statusToInfo(s, s.workflowID ?? s.workflowId ?? ""));
		},
		async listStepRecords(workflowId) {
			const prefix = `${workflowId}:checkpoint:`;
			const statuses = await dbos.listWorkflows({ workflow_id_prefix: prefix, loadOutput: true, sortDesc: false });
			const records: DbosStepRecord[] = [];
			for (const status of statuses) {
				const record = await stepRecord(status, prefix);
				if (record !== undefined) records.push(record);
			}
			return records;
		},
		async readStepRecord(workflowId, stepName) {
			const prefix = `${workflowId}:checkpoint:`;
			const id = checkpointId(workflowId, stepName);
			const statuses = await dbos.listWorkflows({ workflowIDs: [id], loadOutput: true, limit: 1 });
			const status = statuses[0];
			return status !== undefined && (status.workflowID ?? status.workflowId) === id
				? stepRecord(status, prefix)
				: undefined;
		},
		async recordStepOutput(workflowId, stepName, output) {
			if (fence !== undefined) {
				const id = checkpointId(workflowId, stepName);
				const existing = (await dbos.listWorkflows({ workflowIDs: [id], limit: 1 }))[0];
				if (
					existing?.status !== undefined &&
					["PENDING", "ENQUEUED", "CANCELLED", "ERROR", "DELAYED"].includes(existing.status)
				)
					await dbos.deleteWorkflows([id], false);
			}
			let handle: DbosWorkflowHandle;
			try {
				handle = await dbos.startWorkflow(checkpointWorkflow, { workflowID: checkpointId(workflowId, stepName) })(
					workflowId,
					stepName,
					output,
				);
			} catch (err) {
				if (!isDbosDuplicateWorkflowError(err)) throw err;
				handle = dbos.retrieveWorkflow(checkpointId(workflowId, stepName));
			}
			// Await completion so the record is durable and readable before the
			// caller's flush boundary; duplicates resolve to the first stored output.
			await handle.getResult();
		},
		async deleteWorkflowData(workflowId) {
			const prefix = `${workflowId}:checkpoint:`;
			const checkpointIds: string[] = [];
			const pageSize = 1_000;
			for (let offset = 0; ; offset += pageSize) {
				const page = await dbos.listWorkflows({ workflow_id_prefix: prefix, limit: pageSize, offset });
				checkpointIds.push(
					...page.map((status) => status.workflowID ?? status.workflowId ?? "").filter((id) => id.length > 0),
				);
				if (page.length < pageSize) break;
			}
			await dbos.deleteWorkflows([...new Set([workflowId, ...checkpointIds])], true);
		},
	};
	if (fence === undefined) return raw;
	const claims = new AsyncLocalStorage<{ authority: DbosRowAuthority }>();
	const rowAuthority = (workflowId: string, current: ReturnType<typeof classifyLatestMetadata>): DbosRowAuthority => ({
		root: workflowId,
		actor: fence.executorId,
		...(current.kind === "current"
			? { owner: current.metadata.ownerExecutorId, generation: current.generation }
			: {}),
		enroll:
			current.kind === "unavailable" ||
			(current.kind === "current" && isDatabaseExecutor(current.metadata.ownerExecutorId)),
	});
	const mutate = async (
		workflowId: string,
		callback: () => Promise<void>,
		step?: { name: string; output: WorkflowSerializableValue },
	): Promise<void> =>
		fence.write(workflowId, async () => {
			const current = classifyLatestMetadata(await raw.listStepRecords(workflowId), workflowId);
			const claimed = claims.getStore();
			if (
				claimed === undefined &&
				current.kind === "current" &&
				current.metadata.ownerExecutorId !== fence.executorId
			)
				throw new Error("Workflow database ownership changed; stale executor writes are refused");
			let output =
				step === undefined
					? undefined
					: classifyLatestMetadata([{ stepName: step.name, output: step.output }], workflowId);
			let persistedStep = step;
			if (
				step !== undefined &&
				output?.kind === "current" &&
				current.kind === "current" &&
				!step.name.endsWith(":claim") &&
				output.metadata.ownerExecutorId === fence.executorId &&
				output.generation <= current.generation
			) {
				const updatedAt = Math.max(current.generation + 1, output.metadata.updatedAt, Date.now());
				persistedStep = {
					name: metadataStepName(updatedAt),
					output: encodeMetadata({ ...output.metadata, updatedAt }),
				};
				output = classifyLatestMetadata(
					[{ stepName: persistedStep.name, output: persistedStep.output }],
					workflowId,
				);
			}
			const authority = claimed?.authority ?? rowAuthority(workflowId, current);
			const capability =
				output?.kind === "current" && step?.name.endsWith(":claim")
					? {
							...authority,
							claim: output.metadata.transitionClaimId,
							checkpoint: checkpointId(workflowId, step.name),
						}
					: authority;
			const record = persistedStep;
			await fence.withRowAuthority(
				capability,
				record === undefined ? callback : () => raw.recordStepOutput(workflowId, record.name, record.output),
			);
			if (claimed !== undefined && output?.kind === "current")
				claimed.authority = {
					...capability,
					owner: output.metadata.ownerExecutorId,
					generation: output.generation,
				};
		});
	return {
		...raw,
		executorId: fence.executorId,
		generationLost: () => fence.invalidated,
		forkGeneration: () => {
			const next = getDbosProcessOwner().createExecutorFence?.();
			if (next === undefined) throw new Error("Workflow ownership fence cannot create a recovery generation");
			void fence.close().catch(() => {});
			return createRealDbosHandle(dbos, mainWorkflow, checkpointWorkflow, next, [
				...previousExecutorIds,
				fence.executorId,
			]);
		},
		adoptPreviousGeneration: async (workflowId) => {
			if (previousExecutorIds.length === 0) return undefined;
			return await fence.write(
				workflowId,
				async () => {
					const current = classifyLatestMetadata(await raw.listStepRecords(workflowId), workflowId);
					if (current.kind !== "current" || current.metadata.ownerExecutorId === fence.executorId)
						return undefined;
					const previousExecutorId = current.metadata.ownerExecutorId;
					if (previousExecutorId === undefined || !previousExecutorIds.includes(previousExecutorId))
						throw new Error("Workflow database ownership changed; stale executor writes are refused");
					const metadata = {
						...current.metadata,
						ownerExecutorId: fence.executorId,
						transitionClaimId: crypto.randomUUID(),
						updatedAt: Math.max(Date.now(), current.metadata.updatedAt + 1),
					};
					const adopted = await fence.recover(previousExecutorId, async () => {
						await fence.withRowAuthority(
							{
								...rowAuthority(workflowId, current),
								claim: metadata.transitionClaimId,
								checkpoint: checkpointId(workflowId, claimMetadataStepName(current.generation)),
							},
							() =>
								raw.recordStepOutput(
									workflowId,
									claimMetadataStepName(current.generation),
									encodeMetadata(metadata),
								),
						);
						return metadata;
					});
					if (adopted === undefined) throw new Error("Workflow previous execution generation is still active");
					return adopted;
				},
				true,
			);
		},
		enrollLegacyWorkflow: async (workflowId, modelOwner) =>
			fence.write(
				workflowId,
				async () => {
					const current = classifyLatestMetadata(await raw.listStepRecords(workflowId), workflowId);
					if (
						current.kind !== "current" ||
						(isDatabaseExecutor(current.metadata.ownerExecutorId) &&
							current.metadata.legacyRecoveryPending !== true) ||
						!["running", "paused", "blocked"].includes(current.metadata.status) ||
						(current.metadata.rootWorkflowId !== undefined && current.metadata.rootWorkflowId !== workflowId)
					)
						return undefined;
					const metadata = {
						...current.metadata,
						modelOwner,
						ownerExecutorId: fence.executorId,
						status: "blocked" as const,
						resumable: true,
						legacyRecoveryPending: true as const,
						updatedAt: Math.max(Date.now(), current.metadata.updatedAt + 1),
					};
					const retry = isDatabaseExecutor(current.metadata.ownerExecutorId);
					const transitionClaimId = crypto.randomUUID();
					const stepName = retry
						? claimMetadataStepName(current.generation)
						: metadataStepName(Math.max(current.generation + 1, metadata.updatedAt));
					const persist = () =>
						fence.withRowAuthority(
							{
								...rowAuthority(workflowId, current),
								enroll: true,
								...(retry ? { claim: transitionClaimId, checkpoint: checkpointId(workflowId, stepName) } : {}),
							},
							() =>
								raw.recordStepOutput(
									workflowId,
									stepName,
									encodeMetadata({ ...metadata, ...(retry ? { transitionClaimId } : {}) }),
								),
						);
					if (retry) {
						const recovered = await fence.recover(current.metadata.ownerExecutorId!, async () => {
							await persist();
							return true;
						});
						if (recovered !== true) return undefined;
					} else await persist();
					return metadata;
				},
				true,
			),
		ownerLiveness: (executorId) => fence.liveness(executorId),
		withWorkflowClaim: (workflowId, callback) =>
			fence.write(
				workflowId,
				async () => {
					const authoritative = classifyLatestMetadata(await raw.listStepRecords(workflowId), workflowId);
					const claim = () =>
						claims.run(
							{ authority: { ...rowAuthority(workflowId, authoritative), claim: crypto.randomUUID() } },
							callback,
						);
					if (
						authoritative.kind === "current" &&
						authoritative.metadata.status === "running" &&
						authoritative.metadata.ownerExecutorId !== fence.executorId
					) {
						return (await fence.recover(authoritative.metadata.ownerExecutorId, claim)) ?? false;
					}
					return await claim();
				},
				true,
			),
		startWorkflow: (id, name, inputs) => mutate(id, () => raw.startWorkflow(id, name, inputs)),
		cancelWorkflow: (id) => mutate(id, () => raw.cancelWorkflow(id)),
		resumeWorkflow: (id) => mutate(id, () => raw.resumeWorkflow(id)),
		recordStepOutput: (id, step, output) =>
			mutate(id, () => raw.recordStepOutput(id, step, output), { name: step, output }),
		deleteWorkflowData: (id) => mutate(id, () => raw.deleteWorkflowData(id)),
	};
}

function isDbosDuplicateWorkflowError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /duplicate|conflict|already/i.test(msg);
}

function statusToInfo(status: DbosStatus, fallbackId: string): DbosWorkflowInfo {
	const info: DbosWorkflowInfo = {
		workflowId: status.workflowID ?? status.workflowId ?? fallbackId,
		name: status.workflowName ?? status.name ?? "atomicWorkflowHandle",
		status: status.status ?? "PENDING",
		createdAt: status.createdAt ?? Date.now(),
	};
	if (status.input !== undefined && status.input.length >= 2) {
		const inputs = status.input[1];
		if (typeof inputs === "object" && inputs !== null && !Array.isArray(inputs)) {
			return {
				...info,
				name: typeof status.input[0] === "string" ? status.input[0] : info.name,
				inputs: inputs as import("./types.js").WorkflowSerializableObject,
			};
		}
	}
	return info;
}
