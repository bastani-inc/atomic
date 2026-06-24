import { DEFAULT_MAX_BYTES, formatSize } from "./truncate.ts";

export interface BashAsyncOutputTarget {
	output: string;
}

export function createAsyncOutputAppender(job: BashAsyncOutputTarget): (chunk: Buffer) => void {
	let outputBytes = 0;
	let truncated = false;
	return (chunk) => {
		if (truncated) return;
		const text = chunk.toString();
		outputBytes += Buffer.byteLength(text);
		if (outputBytes > DEFAULT_MAX_BYTES) {
			const remaining = Math.max(0, DEFAULT_MAX_BYTES - Buffer.byteLength(job.output));
			job.output += text.slice(0, remaining);
			job.output += `\n[Output truncated at ${formatSize(DEFAULT_MAX_BYTES)} for async job polling]`;
			truncated = true;
			return;
		}
		job.output += text;
	};
}
