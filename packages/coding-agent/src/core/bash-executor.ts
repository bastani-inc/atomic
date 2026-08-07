/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { APP_NAME } from "../config.ts";
import { stripAnsi } from "../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import type { BashOperations, BashOutputChannel } from "./tools/bash.ts";
import { PersistedOutputFile } from "./tools/persisted-output-file.ts";
import { ensureSessionTempDir } from "./tools/session-temp-dir.ts";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.ts";

// ============================================================================
// Types
// ============================================================================

export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized), preserving the source channel. */
	onChunk?: (chunk: string, channel: BashOutputChannel) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
	/** Complete environment for the execution backend. */
	env?: NodeJS.ProcessEnv;
	/** Run with PTY handling when supported by the operations backend */
	pty?: boolean;
	/**
	 * Session-scoped directory for the overflow log. Defaults to the active
	 * session's temp directory so the log is reaped with that session.
	 */
	sessionTempDir?: string;
}

export interface BashResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Path to temp file containing full output (if output exceeded truncation threshold) */
	fullOutputPath?: string;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const outputChunks: string[] = [];
	let outputBytes = 0;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

	let tempFilePath: string | undefined;
	let tempFile: PersistedOutputFile | undefined;
	let totalBytes = 0;

	let tempFileUnavailable = false;

	const ensureTempFile = () => {
		if (tempFilePath || tempFileUnavailable) {
			return;
		}
		try {
			const dir = ensureSessionTempDir(options?.sessionTempDir);
			const id = randomBytes(8).toString("hex");
			tempFilePath = join(dir, `${APP_NAME}-bash-${id}.log`);
			tempFile = new PersistedOutputFile(tempFilePath);
		} catch {
			// The session temp directory was refused (see ensureTempDir). Run without
			// an overflow log rather than advertising a path outside the owned tree.
			tempFileUnavailable = true;
			tempFilePath = undefined;
			tempFile = undefined;
			return;
		}
		for (const chunk of outputChunks) {
			tempFile.write(chunk);
		}
	};

	/**
	 * Close the overflow log and confirm it landed. A spill file that failed to
	 * write must not be advertised: `fullOutputPath` is dropped instead, so the
	 * `Full output:` contract never points at a file that is not there.
	 */
	const finishTempFile = async () => {
		const file = tempFile;
		if (!file) {
			return;
		}
		tempFile = undefined;
		try {
			await file.close();
		} catch {
			tempFilePath = undefined;
		}
	};

	const decoders: Record<BashOutputChannel, TextDecoder> = { stdout: new TextDecoder(), stderr: new TextDecoder() };
	const onData = (data: Buffer, channel: BashOutputChannel = "stdout") => {
		totalBytes += data.length;

		// Sanitize: strip ANSI, replace binary garbage, normalize newlines
		const text = sanitizeBinaryOutput(stripAnsi(decoders[channel].decode(data, { stream: true }))).replace(/\r/g, "");

		// Start writing to temp file if exceeds threshold
		if (totalBytes > DEFAULT_MAX_BYTES) {
			ensureTempFile();
		}

		if (tempFile) {
			tempFile.write(text);
		}

		// Keep rolling buffer
		outputChunks.push(text);
		outputBytes += text.length;
		while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
			const removed = outputChunks.shift()!;
			outputBytes -= removed.length;
		}

		// Stream to callback
		if (options?.onChunk) {
			options.onChunk(text, channel);
		}
	};

	try {
		const result = await operations.exec(command, cwd, {
			onData,
			signal: options?.signal,
			env: options?.env,
			pty: options?.pty,
		});

		const fullOutput = outputChunks.join("");
		const truncationResult = truncateTail(fullOutput);
		if (truncationResult.truncated) {
			ensureTempFile();
		}
		await finishTempFile();
		const cancelled = options?.signal?.aborted ?? false;

		return {
			output: truncationResult.truncated ? truncationResult.content : fullOutput,
			exitCode: cancelled ? undefined : (result.exitCode ?? undefined),
			cancelled,
			truncated: truncationResult.truncated,
			fullOutputPath: tempFilePath,
		};
	} catch (err) {
		// Check if it was an abort
		if (options?.signal?.aborted) {
			const fullOutput = outputChunks.join("");
			const truncationResult = truncateTail(fullOutput);
			if (truncationResult.truncated) {
				ensureTempFile();
			}
			await finishTempFile();
			return {
				output: truncationResult.truncated ? truncationResult.content : fullOutput,
				exitCode: undefined,
				cancelled: true,
				truncated: truncationResult.truncated,
				fullOutputPath: tempFilePath,
			};
		}

		await finishTempFile();

		throw err;
	}
}
