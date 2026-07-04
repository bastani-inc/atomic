import type { ManagedBashJob } from "../tools/bash-async-jobs.js";

export type AsyncJobStatus = "running" | "completed" | "failed";

export interface AsyncJobDeliveryDetails {
	jobId: string;
	type: "bash";
	status: AsyncJobStatus;
	command: string;
	exitCode?: number | null;
	fullOutputPath?: string;
	wallTimeMs?: number;
}

export interface AsyncJobDeliveryMessage {
	customType: "async-job-result";
	content: string;
	display: true;
	details: AsyncJobDeliveryDetails;
}

export type AsyncJobDeliveryCallback = (message: AsyncJobDeliveryMessage) => void | Promise<void>;

export type AsyncJobDeliveryHandler = (message: AsyncJobDeliveryMessage) => void | Promise<void>;

export interface ManagedAsyncBashJob extends ManagedBashJob {
	status: AsyncJobStatus;
}
