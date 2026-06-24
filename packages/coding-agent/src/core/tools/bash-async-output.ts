import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_NAME } from "../../config.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "./truncate.ts";

export interface BashAsyncOutputTarget {
	output: string;
	fullOutputPath?: string;
}

export interface BashAsyncOutputAppender {
	append(chunk: Buffer): void;
	close(): Promise<void>;
}

function outputPath(): string {
	return join(tmpdir(), `${APP_NAME}-bash-async-${randomBytes(8).toString("hex")}.log`);
}

export function createAsyncOutputAppender(job: BashAsyncOutputTarget): BashAsyncOutputAppender {
	let outputBytes = 0;
	let truncated = false;
	let fullOutputStream: WriteStream | undefined;
	let bufferedChunks: Buffer[] = [];

	const ensureFullOutputStream = (): WriteStream => {
		if (fullOutputStream) return fullOutputStream;
		job.fullOutputPath = outputPath();
		fullOutputStream = createWriteStream(job.fullOutputPath);
		for (const chunk of bufferedChunks) fullOutputStream.write(chunk);
		bufferedChunks = [];
		return fullOutputStream;
	};

	return {
		append(chunk) {
			if (fullOutputStream) fullOutputStream.write(chunk);
			else bufferedChunks.push(chunk);
			if (truncated) return;

			const chunkBytes = chunk.byteLength;
			if (outputBytes + chunkBytes > DEFAULT_MAX_BYTES) {
				ensureFullOutputStream();
				const remaining = Math.max(0, DEFAULT_MAX_BYTES - outputBytes);
				if (remaining > 0) job.output += chunk.subarray(0, remaining).toString();
				job.output += `\n[Output truncated at ${formatSize(DEFAULT_MAX_BYTES)} for async job polling. Full output: ${job.fullOutputPath}]`;
				outputBytes += chunkBytes;
				truncated = true;
				return;
			}

			outputBytes += chunkBytes;
			job.output += chunk.toString();
		},
		async close() {
			if (!fullOutputStream) return;
			const stream = fullOutputStream;
			fullOutputStream = undefined;
			await new Promise<void>((resolve, reject) => {
				stream.once("error", reject);
				stream.once("finish", resolve);
				stream.end();
			});
		},
	};
}
