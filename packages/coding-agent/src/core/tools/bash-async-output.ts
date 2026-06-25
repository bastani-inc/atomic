import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_NAME } from "../../config.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
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

function byteLength(text: string): number { return Buffer.byteLength(text, "utf8"); }
function sanitizeDecodedOutput(text: string): string { return sanitizeBinaryOutput(stripAnsi(text)).replace(/\r/g, ""); }
function utf8Prefix(text: string, maxBytes: number): string {
	if (byteLength(text) <= maxBytes) return text;
	let end = text.length;
	while (end > 0 && byteLength(text.slice(0, end)) > maxBytes) end--;
	return text.slice(0, end);
}

export function createAsyncOutputAppender(job: BashAsyncOutputTarget): BashAsyncOutputAppender {
	let outputBytes = 0;
	let truncated = false;
	let fullOutputStream: WriteStream | undefined;
	let bufferedChunks: Buffer[] = [];
	const decoder = new TextDecoder();

	const ensureFullOutputStream = (): WriteStream => {
		if (fullOutputStream) return fullOutputStream;
		job.fullOutputPath = outputPath();
		fullOutputStream = createWriteStream(job.fullOutputPath);
		for (const chunk of bufferedChunks) fullOutputStream.write(chunk);
		bufferedChunks = [];
		return fullOutputStream;
	};
	const appendDecodedText = (decoded: string): void => {
		if (truncated || decoded.length === 0) return;
		const text = sanitizeDecodedOutput(decoded);
		if (text.length === 0) return;
		const bytes = byteLength(text);
		if (outputBytes + bytes > DEFAULT_MAX_BYTES) {
			ensureFullOutputStream();
			const remaining = Math.max(0, DEFAULT_MAX_BYTES - outputBytes);
			if (remaining > 0) job.output += utf8Prefix(text, remaining);
			job.output += `\n[Output truncated at ${formatSize(DEFAULT_MAX_BYTES)} for async job polling. Full output: ${job.fullOutputPath}]`;
			outputBytes += bytes;
			truncated = true;
			return;
		}
		outputBytes += bytes;
		job.output += text;
	};

	return {
		append(chunk) {
			if (fullOutputStream) fullOutputStream.write(chunk);
			else bufferedChunks.push(chunk);
			appendDecodedText(decoder.decode(chunk, { stream: true }));
		},
		async close() {
			appendDecodedText(decoder.decode());
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
