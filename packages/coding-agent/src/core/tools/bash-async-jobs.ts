import { rmSync } from "node:fs";

export interface ManagedBashJob {
	jobId: string;
	command: string;
	cwd: string;
	status: "running" | "completed" | "failed";
	output: string;
	fullOutputPath?: string;
	exitCode?: number | null;
	error?: string;
	startedAt: number;
	endedAt?: number;
	timeoutSeconds?: number;
	requestedTimeoutSeconds?: number;
	abortController?: AbortController;
}

export const MAX_MANAGED_BASH_JOBS = 100;
export const COMPLETED_JOB_TTL_MS = 30 * 60 * 1000;
const managedBashJobs = new Map<string, ManagedBashJob>();
export function formatAsyncJobError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (message.startsWith("timeout:")) return `Command timed out after ${message.slice("timeout:".length)} seconds`;
	return message;
}
function deleteJobOutput(job: ManagedBashJob): void {
	if (!job.fullOutputPath) return;
	try { rmSync(job.fullOutputPath, { force: true }); } catch { /* best-effort temp cleanup */ }
}

function cleanupManagedBashJobs(now = Date.now()): void {
	for (const [jobId, job] of managedBashJobs) if (job.status !== "running" && job.endedAt !== undefined && now - job.endedAt > COMPLETED_JOB_TTL_MS) { deleteJobOutput(job); managedBashJobs.delete(jobId); }
	while (managedBashJobs.size > MAX_MANAGED_BASH_JOBS) {
		const oldest = [...managedBashJobs.values()].sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt))[0];
		if (!oldest) break;
		if (oldest.status === "running") oldest.abortController?.abort(); else deleteJobOutput(oldest);
		managedBashJobs.delete(oldest.jobId);
	}
}

export function createManagedBashJob(command: string, cwd: string, timeoutSeconds?: number, requestedTimeoutSeconds?: number): ManagedBashJob {
	cleanupManagedBashJobs();
	const jobId = `bash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const job: ManagedBashJob = { jobId, command, cwd, status: "running", output: "", startedAt: Date.now(), timeoutSeconds, requestedTimeoutSeconds, abortController: new AbortController() };
	managedBashJobs.set(jobId, job);
	cleanupManagedBashJobs();
	return job;
}

/**
 * Remove a managed job that never actually started executing (for example when
 * async-manager registration fails after the map insert). Without this, the
 * entry would stay "running" forever: TTL cleanup only evicts settled jobs, so
 * the zombie would linger until the max-jobs overflow forcibly removed it.
 */
export function discardManagedBashJob(jobId: string): void {
	const job = managedBashJobs.get(jobId);
	if (!job) return;
	deleteJobOutput(job);
	managedBashJobs.delete(jobId);
}

export function listManagedBashJobIds(): string[] {
	return [...managedBashJobs.keys()];
}

export function getManagedBashJob(jobId: string): ManagedBashJob | undefined {
	cleanupManagedBashJobs();
	const job = managedBashJobs.get(jobId);
	if (!job) return undefined;
	const { abortController: _abortController, ...snapshot } = job;
	return { ...snapshot };
}

export function abortManagedBashJob(jobId: string): ManagedBashJob | undefined {
	const job = managedBashJobs.get(jobId);
	if (!job) return undefined;
	job.abortController?.abort();
	return job;
}
