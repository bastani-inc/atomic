import type { ManagedAsyncBashJob, AsyncJobDeliveryMessage } from "./types.js";

const INLINE_OUTPUT_LIMIT = 12_000;
const LARGE_OUTPUT_PREVIEW_LIMIT = 4_000;

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return text.slice(0, maxChars).trimEnd();
}

function jobOutput(job: ManagedAsyncBashJob): string {
	const output = job.output.trimEnd();
	if (output.length > 0) return output;
	return job.error ? `(no output)\n\n${job.error}` : "(no output)";
}

function statusLine(job: ManagedAsyncBashJob): string | undefined {
	if (job.error) return `Error: ${job.error}`;
	if (job.exitCode !== undefined && job.exitCode !== null && job.exitCode !== 0) {
		return `Command exited with code ${job.exitCode}`;
	}
	return undefined;
}

export function formatAsyncResultForFollowUp(job: ManagedAsyncBashJob): AsyncJobDeliveryMessage {
	const elapsedMs = (job.endedAt ?? Date.now()) - job.startedAt;
	const header = `Async bash job ${job.jobId} ${job.status}: ${job.command}`;
	const body = jobOutput(job);
	const status = statusLine(job);
	const inline = [header, body, status].filter((part): part is string => part !== undefined && part.length > 0).join("\n\n");
	let content = inline;
	if (inline.length > INLINE_OUTPUT_LIMIT && job.fullOutputPath) {
		const preview = truncateText(body, LARGE_OUTPUT_PREVIEW_LIMIT);
		content = [header, preview, `[Output truncated for async follow-up. Full output: ${job.fullOutputPath}]`, status]
			.filter((part): part is string => part !== undefined && part.length > 0)
			.join("\n\n");
	}
	return {
		customType: "async-job-result",
		content,
		display: true,
		details: {
			jobId: job.jobId,
			type: "bash",
			status: job.status,
			command: job.command,
			exitCode: job.exitCode,
			fullOutputPath: job.fullOutputPath,
			wallTimeMs: elapsedMs,
		},
	};
}
