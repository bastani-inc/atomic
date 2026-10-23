import type { PoolMutation, PoolWork } from "../durable/journal/sql-pool-queue.js";
import type { RunResult } from "../runs/foreground/executor-types.js";
import type { WorkflowSerializableValue } from "../shared/types.js";
import type { WorkerDefinitionSource } from "./definitions.js";

export interface WorkerStart {
	readonly journalPath: string;
	readonly root: string;
	readonly definitions: readonly WorkerDefinitionSource[];
}
export type WorkerRequest = { readonly id: number } & (
	| { readonly kind: "ready" | "claim" | "renew" }
	| { readonly kind: "commit"; readonly operation: string; readonly mutation: PoolMutation }
	| { readonly kind: "complete"; readonly result: RunResult }
);
export interface WorkerReply {
	readonly id: number;
	readonly value?: WorkflowSerializableValue | PoolWork;
	readonly error?: string;
}
