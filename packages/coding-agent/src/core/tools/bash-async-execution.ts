import type { AsyncJobManager } from "../async/job-manager.js";
import type { AsyncJobDeliveryHandler } from "../async/types.js";
import { invalidateNativeSearchCache } from "./search-native.js";
import { createAsyncOutputAppender } from "./bash-async-output.js";
import { createManagedBashJob, formatAsyncJobError } from "./bash-async-jobs.js";
import type { BashOperations, BashToolDetails } from "./bash.js";

interface StartAsyncBashCommandOptions {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	pty?: boolean;
	timeoutSeconds: number;
	requestedTimeoutSeconds?: number;
	signal?: AbortSignal;
	operations: BashOperations;
	manager?: AsyncJobManager;
	deliveryHandler?: AsyncJobDeliveryHandler;
	sessionId?: symbol;
}

export async function startAsyncBashCommand(options: StartAsyncBashCommandOptions): Promise<{
	content: Array<{ type: "text"; text: string }>;
	details: BashToolDetails;
}> {
	if (options.manager?.atCapacity) throw new Error("Background job limit reached. Wait for running jobs to finish or cancel one.");
	const job = createManagedBashJob(options.command, options.cwd, options.timeoutSeconds, options.requestedTimeoutSeconds);
	options.manager?.registerBashJob(job, options.deliveryHandler, options.sessionId);
	const appendAsyncOutput = createAsyncOutputAppender(job, { persistAfterBytes: 12_000 });
	const onParentAbort = () => {
		options.manager?.acknowledgeDeliveries([job.jobId]);
		job.abortController?.abort();
	};
	if (options.signal?.aborted) onParentAbort();
	else options.signal?.addEventListener("abort", onParentAbort, { once: true });
	void (async () => {
		let error: Error | string | undefined;
		let exitCode: number | null | undefined;
		try {
			exitCode = (await options.operations.exec(options.command, options.cwd, {
				onData: appendAsyncOutput.append,
				timeout: options.timeoutSeconds,
				env: options.env,
				pty: options.pty,
				signal: job.abortController?.signal,
			})).exitCode;
		} catch (execError) {
			error = execError instanceof Error ? execError : String(execError);
		}
		try {
			await appendAsyncOutput.close();
		} catch (closeError) {
			error ??= closeError instanceof Error ? closeError : String(closeError);
		}
		if (error !== undefined) {
			job.status = "failed";
			job.error = job.abortController?.signal.aborted ? "aborted" : formatAsyncJobError(error);
		} else {
			job.exitCode = exitCode;
			job.status = exitCode && exitCode !== 0 ? "failed" : "completed";
		}
		job.endedAt = Date.now();
		invalidateNativeSearchCache();
		options.manager?.completeBashJob(job);
		options.signal?.removeEventListener("abort", onParentAbort);
	})();
	return {
		content: [{ type: "text", text: `Started async bash command ${job.jobId}: ${options.command}\nPoll with bash({ command: "__atomic_bash_job ${job.jobId}" }); cancel with bash({ command: "__atomic_bash_job_cancel ${job.jobId}" })` }],
		details: {
			async: { jobId: job.jobId, type: "bash", state: "running", command: options.command, status: "running" },
			timeoutSeconds: options.timeoutSeconds,
			...(options.requestedTimeoutSeconds !== undefined ? { requestedTimeoutSeconds: options.requestedTimeoutSeconds } : {}),
		},
	};
}
