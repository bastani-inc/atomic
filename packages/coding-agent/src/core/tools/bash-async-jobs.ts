export interface ManagedBashJob {
	jobId: string;
	command: string;
	cwd: string;
	status: "running" | "completed" | "failed";
	output: string;
	exitCode?: number | null;
	error?: string;
	startedAt: number;
	endedAt?: number;
	timeoutSeconds?: number;
	requestedTimeoutSeconds?: number;
	abortController?: AbortController;
}

const MAX_MANAGED_BASH_JOBS = 100;
const COMPLETED_JOB_TTL_MS = 30 * 60 * 1000;
const managedBashJobs = new Map<string, ManagedBashJob>();

function cleanupManagedBashJobs(now = Date.now()): void {
	for (const [jobId, job] of managedBashJobs) if (job.status !== "running" && job.endedAt !== undefined && now - job.endedAt > COMPLETED_JOB_TTL_MS) managedBashJobs.delete(jobId);
	while (managedBashJobs.size > MAX_MANAGED_BASH_JOBS) {
		const oldest = [...managedBashJobs.values()].filter((job) => job.status !== "running").sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt))[0];
		if (!oldest) break;
		managedBashJobs.delete(oldest.jobId);
	}
}

export function createManagedBashJob(command: string, cwd: string, timeoutSeconds?: number, requestedTimeoutSeconds?: number): ManagedBashJob {
	cleanupManagedBashJobs();
	const jobId = `bash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const job: ManagedBashJob = { jobId, command, cwd, status: "running", output: "", startedAt: Date.now(), timeoutSeconds, requestedTimeoutSeconds, abortController: new AbortController() };
	managedBashJobs.set(jobId, job);
	return job;
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
