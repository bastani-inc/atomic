import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { APP_NAME } from "../../config.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import { PersistedOutputFile } from "./persisted-output-file.ts";
import { acquireProtectedPaths, ensureSessionTempDir, type ProtectedPathLease } from "./session-temp-dir.ts";
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
	let persistUnavailable = false;
	let writerLease: ProtectedPathLease | undefined;
	let bufferedChunks: Buffer[] = [];
	const decoder = new TextDecoder();

	const ensureFullOutputFile = (): PersistedOutputFile | undefined => {
		if (fullOutputFile || persistUnavailable) return fullOutputFile;
		try {
			const path = outputPath(options?.sessionTempDir);
			// A background job outlives the session that started it, so this writer
			// holds its own protection claim rather than relying on the session's.
			writerLease = acquireProtectedPaths([dirname(path)]);
			fullOutputFile = new PersistedOutputFile(path);
			job.fullOutputPath = path;
		} catch {
			// The session temp directory was refused (see ensureTempDir), or the file
			// could not be created owner-only. Keep polling output flowing without
			// advertising a spill path we could not own.
			persistUnavailable = true;
			job.fullOutputPath = undefined;
			writerLease?.release();
			writerLease = undefined;
			bufferedChunks = [];
			return undefined;
		}
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
			const fullOutputNote = job.fullOutputPath ? ` Full output: ${job.fullOutputPath}` : "";
			job.output += `\n[Output truncated at ${formatSize(DEFAULT_MAX_BYTES)} for async job polling.${fullOutputNote}]`;
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
			else if (!persistUnavailable) bufferedChunks.push(chunk);
			appendDecodedText(decoder.decode(chunk, { stream: true }));
		},
		async close() {
			appendDecodedText(decoder.decode());
			if (!fullOutputFile) {
				writerLease?.release();
				writerLease = undefined;
				return;
			}
			const file = fullOutputFile;
			fullOutputFile = undefined;
			try {
				await file.close();
			} catch {
				// A spill file that failed to flush must not be advertised — but it
				// must not fail the command either. The process already exited, and
				// reporting a storage fault as command failure invites the caller to
				// retry a side-effecting command that in fact succeeded. Dropping the
				// path matches the synchronous executor, which also declines to
				// advertise a spill it could not write.
				job.fullOutputPath = undefined;
			} finally {
				writerLease?.release();
				writerLease = undefined;
			}
		},
	};
}
