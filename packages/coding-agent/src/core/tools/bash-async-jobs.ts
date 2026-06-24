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
}

const managedBashJobs = new Map<string, ManagedBashJob>();

export function createManagedBashJob(command: string, cwd: string, timeoutSeconds?: number, requestedTimeoutSeconds?: number): ManagedBashJob {
	const jobId = `bash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const job: ManagedBashJob = { jobId, command, cwd, status: "running", output: "", startedAt: Date.now(), timeoutSeconds, requestedTimeoutSeconds };
	managedBashJobs.set(jobId, job);
	return job;
}

export function getManagedBashJob(jobId: string): ManagedBashJob | undefined {
	const job = managedBashJobs.get(jobId);
	return job ? { ...job } : undefined;
}
