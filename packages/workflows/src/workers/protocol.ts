import type { CreateAgentSessionOptions } from "@bastani/atomic";
import type { PoolControl, PoolMutation, PoolWork } from "../durable/journal/sql-pool-queue.js";
import type { PoolUsageReport } from "../durable/journal/sql-pool-usage.js";
import type { RunResult } from "../runs/foreground/executor-types.js";
import type { RunSnapshot } from "../shared/store-types.js";
import type { WorkflowSerializableValue } from "../shared/types.js";
import type { WorkerDefinitionSource } from "./definitions.js";
import type { AdmissionConfiguration } from "./resource-admission.js";

export type WorkerStageDelivery = NonNullable<
	NonNullable<CreateAgentSessionOptions["orchestrationContext"]>["pendingStageDelivery"]
>;
export type WorkerDeliver = Parameters<WorkerStageDelivery["deliverPending"]>[0];
export type WorkerRecipient = Parameters<WorkerStageDelivery["deliverPending"]>[1];
export interface WorkerStart {
	readonly journalPath: string;
	readonly root: string;
	readonly definitions: readonly WorkerDefinitionSource[];
	readonly admission?: AdmissionConfiguration;
}
export type WorkerRequest = { readonly id: number } & (
	| { readonly kind: "ready" | "claim" | "renew" | "budget" | "control" }
	| { readonly kind: "controlled"; readonly revision: number }
	| { readonly kind: "activity"; readonly runs: readonly RunSnapshot[] }
	| { readonly kind: "route"; readonly runId: string }
	| {
			readonly kind: "delivery" | "delivery-ready";
			readonly runId: string;
			readonly stageId: string;
			readonly stageName: string;
			readonly recipient?: WorkerRecipient;
			readonly sessionId?: string;
	  }
	| { readonly kind: "delivery-ack"; readonly deliveryId: string; readonly error?: string }
	| { readonly kind: "commit"; readonly operation: string; readonly mutation: PoolMutation }
	| { readonly kind: "usage"; readonly reports: readonly PoolUsageReport[] }
	| { readonly kind: "complete"; readonly result: RunResult }
);
export interface WorkerReply {
	readonly id: number;
	readonly value?: WorkflowSerializableValue | PoolWork | PoolControl;
	readonly error?: string;
	readonly delivery?: {
		readonly id: string;
		readonly from: Parameters<WorkerDeliver>[0];
		readonly message: Parameters<WorkerDeliver>[1];
	};
}
