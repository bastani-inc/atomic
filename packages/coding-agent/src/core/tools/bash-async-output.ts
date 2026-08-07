import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { APP_NAME } from "../../config.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import { PersistedOutputFile } from "./persisted-output-file.ts";
import { ensureSessionTempDir } from "./session-temp-dir.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "./truncate.ts";

export interface BashAsyncOutputTarget {
	output: string;
	fullOutputPath?: string;
}

export interface BashAsyncOutputAppender {
	append(chunk: Buffer): void;
	close(): Promise<void>;
}

function outputPath(sessionTempDir: string | undefined): string {
	const dir = ensureSessionTempDir(sessionTempDir);
	return join(dir, `${APP_NAME}-bash-async-${randomBytes(8).toString("hex")}.log`);
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}
function sanitizeDecodedOutput(text: string): string {
	return sanitizeBinaryOutput(stripAnsi(text)).replace(/\r/g, "");
}
function utf8Prefix(text: string, maxBytes: number): string {
	if (byteLength(text) <= maxBytes) return text;
	let end = text.length;
	while (end > 0 && byteLength(text.slice(0, end)) > maxBytes) end--;
	return text.slice(0, end);
}

export function createAsyncOutputAppender(
	job: BashAsyncOutputTarget,
	options?: { persistAfterBytes?: number; sessionTempDir?: string },
): BashAsyncOutputAppender {
	const persistAfterBytes = options?.persistAfterBytes ?? DEFAULT_MAX_BYTES;
	let outputBytes = 0;
	let truncated = false;
	let fullOutputFile: PersistedOutputFile | undefined;
	let bufferedChunks: Buffer[] = [];
	const decoder = new TextDecoder();

	const ensureFullOutputFile = (): PersistedOutputFile => {
		if (fullOutputFile) return fullOutputFile;
		job.fullOutputPath = outputPath(options?.sessionTempDir);
		fullOutputFile = new PersistedOutputFile(job.fullOutputPath);
		for (const chunk of bufferedChunks) fullOutputFile.write(chunk);
		bufferedChunks = [];
		return fullOutputFile;
	};
	const appendDecodedText = (decoded: string): void => {
		if (truncated || decoded.length === 0) return;
		const text = sanitizeDecodedOutput(decoded);
		if (text.length === 0) return;
		const bytes = byteLength(text);
		if (outputBytes + bytes > persistAfterBytes) ensureFullOutputFile();
		if (outputBytes + bytes > DEFAULT_MAX_BYTES) {
			ensureFullOutputFile();
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
			if (fullOutputFile) fullOutputFile.write(chunk);
			else bufferedChunks.push(chunk);
			appendDecodedText(decoder.decode(chunk, { stream: true }));
		},
		async close() {
			appendDecodedText(decoder.decode());
			if (!fullOutputFile) return;
			const file = fullOutputFile;
			fullOutputFile = undefined;
			await file.close();
		},
	};
}
