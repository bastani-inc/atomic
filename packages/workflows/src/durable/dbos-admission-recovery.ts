import { isDeepStrictEqual } from "node:util";
import { boundedAdmission, dbosAdmissionContext } from "./dbos-admission.js";
import type { DbosSdkHandle } from "./dbos-backend.js";
import { classifyLatestMetadata, encodeMetadata } from "./dbos-metadata.js";
import type { DurableWorkflowMetadata } from "./types.js";

/** Repair only an admission this process knows failed before author execution.
 * Missing metadata without that retained identity is deliberately not repairable.
 */
export async function reconcileDbosAdmission(
	sdk: DbosSdkHandle,
	metadata: DurableWorkflowMetadata,
	repairMissing: boolean,
	checkReady?: () => Promise<void>,
): Promise<boolean> {
	return await boundedAdmission(
		(signal) =>
			dbosAdmissionContext.run(signal, async () => {
				await checkReady?.();
				signal.throwIfAborted();
				const id = metadata.workflowId;
				const info = await sdk.retrieveWorkflow(id);
				const records = await sdk.listStepRecords(id);
				signal.throwIfAborted();
				// Existing records always win. Never replace malformed state or infer
				// whether an uncheckpointed external side effect actually happened.
				const matches = (candidate: {
					readonly name: string;
					readonly inputs?: DurableWorkflowMetadata["inputs"];
				}) => candidate.name === metadata.name && isDeepStrictEqual(candidate.inputs, metadata.inputs);
				if (info !== undefined && !matches(info)) return false;
				if (records.length > 0) {
					const current = classifyLatestMetadata(records, id);
					return info !== undefined && current.kind === "current" && matches(current.metadata);
				}
				if (!repairMissing || metadata.completedCheckpoints > 0 || metadata.pendingPrompts > 0) return false;
				await sdk.startWorkflow(id, metadata.name, metadata.inputs);
				signal.throwIfAborted();
				const accepted = await sdk.retrieveWorkflow(id);
				signal.throwIfAborted();
				if (accepted === undefined || !matches(accepted)) return false;
				// A raced start may belong to another invocation. Validate its saved
				// identity, not merely the duplicate-safe start acknowledgement.
				const latest = await sdk.listStepRecords(id);
				signal.throwIfAborted();
				if (latest.length > 0) {
					const current = classifyLatestMetadata(latest, id);
					return current.kind === "current" && matches(current.metadata);
				}
				// A deterministic first-writer-wins record allows an uncertain response
				// to be inspected on the next attempt without inventing another run id.
				await sdk.recordStepOutput(
					id,
					"__atomic_metadata:0:admission-recovery",
					encodeMetadata({
						...metadata,
						status: "blocked",
						resumable: true,
						updatedAt: Date.now(),
					}),
				);
				signal.throwIfAborted();
				return true;
			}),
		dbosAdmissionContext.getStore(),
	);
}
