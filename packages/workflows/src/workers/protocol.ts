import type { PoolMutation, PoolWork } from "../durable/journal/sql-pool-queue.js";
import type { PoolUsageReport } from "../durable/journal/sql-pool-usage.js";
import type { RunResult } from "../runs/foreground/executor-types.js";
import type { WorkflowSerializableValue } from "../shared/types.js";
import type { WorkerDefinitionSource } from "./definitions.js";
import type { AdmissionConfiguration } from "./resource-admission.js";

export interface WorkerStart {
	readonly journalPath: string;
	readonly root: string;
	readonly definitions: readonly WorkerDefinitionSource[];
	readonly admission?: AdmissionConfiguration;
}
export type WorkerRequest = { readonly id: number } & (
	| { readonly kind: "ready" | "claim" | "renew" | "budget" }
	| { readonly kind: "commit"; readonly operation: string; readonly mutation: PoolMutation }
	| { readonly kind: "usage"; readonly reports: readonly PoolUsageReport[] }
	| { readonly kind: "complete"; readonly result: RunResult }
);
export interface WorkerReply {
	readonly id: number;
	readonly value?: WorkflowSerializableValue | PoolWork;
	readonly error?: string;
}
