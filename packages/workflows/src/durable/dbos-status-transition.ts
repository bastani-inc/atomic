import type { DbosMetadataCompatibility } from "./dbos-metadata.js";
import type { DurableCheckpointEntry, DurableWorkflowHandle, DurableWorkflowStatus } from "./types.js";
import { isAbsorbingDurableStatus } from "./workflow-status-transition.js";

interface DbosStatusTransitionInput {
  readonly expectedStatuses: readonly DurableWorkflowStatus[];
  readonly status: DurableWorkflowStatus;
  readonly flush: () => Promise<void>;
  readonly read: () => Promise<DbosMetadataCompatibility>;
  readonly local: () => DurableWorkflowHandle | undefined;
  readonly reconcile: (entry: DurableCheckpointEntry) => void;
  readonly write: () => Promise<void>;
}

/**
 * Serialize local writes around authoritative generations and verify the
 * persisted result. DBOS metadata classification makes terminal generations
 * absorbing, so a stale nonterminal append cannot reopen a completed run.
 */
export async function transitionDbosWorkflowStatus(input: DbosStatusTransitionInput): Promise<boolean> {
  await input.flush();
  const authoritative = await input.read();
  const local = input.local();
  if (local === undefined || authoritative.kind !== "current"
    || !input.expectedStatuses.includes(authoritative.entry.status)) {
    if (authoritative.kind === "current") input.reconcile(authoritative.entry);
    return false;
  }

  try {
    await input.write();
  } catch (error) {
    const persisted = await input.read();
    if (persisted.kind === "current"
      && isAbsorbingDurableStatus(persisted.entry.status, persisted.entry.resumable)) {
      input.reconcile(persisted.entry);
      return false;
    }
    throw error;
  }
  const persisted = await input.read();
  if (persisted.kind !== "current" || persisted.entry.status !== input.status) {
    if (persisted.kind === "current") input.reconcile(persisted.entry);
    return false;
  }
  return true;
}
