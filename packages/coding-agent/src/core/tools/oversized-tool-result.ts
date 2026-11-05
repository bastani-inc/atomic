import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@bastani/pi-ai/compat";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getErrnoCode } from "./errno.ts";
import { capPersistedText } from "./persisted-output-file.ts";
import {
	ensureTempDir,
	resolveSessionTempDirPath,
	SESSION_TEMP_DIR_MODE,
	SESSION_TEMP_FILE_MODE,
} from "./session-temp-dir.ts";
import {
	DEFAULT_MAX_RESULT_SIZE_CHARS,
	PERSISTED_OUTPUT_CLOSING_TAG,
	PERSISTED_OUTPUT_TAG,
	PREVIEW_SIZE_BYTES,
	TOOL_RESULTS_SUBDIR,
} from "./tool-limits.js";

/**
 * Resolve the effective persistence threshold (in characters) for a tool.
 *
 * Mirrors the upstream `getPersistenceThreshold` convention: a tool may declare a
 * lower per-tool cap, but the global {@link DEFAULT_MAX_RESULT_SIZE_CHARS} acts as
 * a system-wide ceiling. `Infinity` is a hard opt-out for self-bounded tools whose
 * output is already a file the model reads back, where persisting would be circular.
 */
export function getPersistenceThreshold(declaredMaxResultSizeChars?: number): number {
	if (declaredMaxResultSizeChars === undefined) {
		return DEFAULT_MAX_RESULT_SIZE_CHARS;
	}
	if (!Number.isFinite(declaredMaxResultSizeChars)) {
		return declaredMaxResultSizeChars;
	}
	return Math.min(declaredMaxResultSizeChars, DEFAULT_MAX_RESULT_SIZE_CHARS);
}

export interface RedirectOversizedToolResultInput<TDetails = unknown> {
	toolName: string;
	toolCallId: string;
	result: Pick<AgentToolResult<TDetails>, "content" | "details">;
	isError: boolean;
	sessionId: string;
	sessionDir?: string;
	/**
	 * Directory the sweeper never reaches, for a released stage's result in a session kept in a store rather than a
	 * session directory: `getReleasedStageBlobDir`. Ignored when `sessionDir` is set.
	 */
	blobDir?: string;
	/** Optional per-tool character cap; clamped by {@link DEFAULT_MAX_RESULT_SIZE_CHARS}. */
	maxResultSizeChars?: number;
}

export interface OversizedToolResultReplacement {
	content: TextContent[];
	details: unknown;
	isError: boolean;
}

/**
 * Human-readable byte size, e.g. `1536` → "1.5KB". Intentionally mirrors
 * upstream Claude Code `formatFileSize` wording instead of using tools/truncate.ts.
 */
export function formatFileSize(sizeInBytes: number): string {
	const kb = sizeInBytes / 1024;
	if (kb < 1) {
		return `${sizeInBytes} bytes`;
	}
	if (kb < 1024) {
		return `${kb.toFixed(1).replace(/\.0$/, "")}KB`;
	}
	const mb = kb / 1024;
	if (mb < 1024) {
		return `${mb.toFixed(1).replace(/\.0$/, "")}MB`;
	}
	const gb = mb / 1024;
	return `${gb.toFixed(1).replace(/\.0$/, "")}GB`;
}

function hasImageBlock(content: readonly (TextContent | ImageContent)[]): boolean {
	return content.some((block) => block.type === "image");
}

/** Concatenate the text blocks of a tool result into a single string. */
function collectText(content: readonly (TextContent | ImageContent)[]): string {
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/**
 * Generate a preview of content, truncating at a newline boundary when possible.
 * Ported from the reference `generatePreview`.
 */
export function generatePreview(content: string, maxBytes: number): { preview: string; hasMore: boolean } {
	if (Buffer.byteLength(content, "utf8") <= maxBytes) {
		return { preview: content, hasMore: false };
	}

	let bytes = 0;
	let hardCutIndex = 0;
	let lastNewlineIndex = -1;
	let lastNewlineBytes = 0;

	for (const character of content) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (bytes + characterBytes > maxBytes) {
			break;
		}
		const characterStartIndex = hardCutIndex;
		bytes += characterBytes;
		hardCutIndex += character.length;
		if (character === "\n") {
			lastNewlineIndex = characterStartIndex;
			lastNewlineBytes = bytes - characterBytes;
		}
	}

	// Find the last newline within the byte limit to avoid cutting mid-line;
	// fall back to the hard byte limit when the newline is too close to the start.
	const cutPoint = lastNewlineBytes > maxBytes * 0.5 ? lastNewlineIndex : hardCutIndex;
	return { preview: content.slice(0, cutPoint), hasMore: true };
}

/**
 * Build the `<persisted-output>` preview message shown to the model in place of
 * the oversized content. Ported from the reference `buildLargeToolResultMessage`.
 */
function buildPersistedOutputMessage(input: {
	originalSizeBytes: number;
	filepath: string;
	sha256: string;
	preview: string;
	hasMore: boolean;
}): string {
	let message = `${PERSISTED_OUTPUT_TAG}\n`;
	message += `Output too large (${formatFileSize(input.originalSizeBytes)}). Full output saved to: ${input.filepath}\n`;
	message += `Content: sha256:${input.sha256}\n\n`;
	message += `Preview (first ${formatFileSize(PREVIEW_SIZE_BYTES)}):\n`;
	message += input.preview;
	message += input.hasMore ? "\n...\n" : "\n";
	message += PERSISTED_OUTPUT_CLOSING_TAG;
	return message;
}

/**
 * Directory for persisted tool results, which are named by the SHA-256 of their content.
 *
 * A disk-backed session owns `<sessionDir>/tool-results`; a session kept in a store
 * (SQLite, libSQL or memory) uses the agent directory's `blobs/tool-output`
 * (`TOOL_RESULT_BLOBS_SUBDIR`), which no sweeper touches, so a result outlives
 * a session released while it waits. Either is created here and then chmodded,
 * because `mode` on mkdir is only a request the process umask narrows — a umask of
 * 0o777 otherwise leaves a directory at 000 that nothing, this process included,
 * can write into.
 *
 * Without either, the result falls back to the owner- and session-scoped temp tree,
 * so the sweeper can reap it once the session is gone — and that path goes through
 * {@link ensureTempDir}, which validates every component below the system temp
 * directory instead of letting `mkdir -p` follow a planted link.
 */
async function ensureToolResultsDir(input: {
	sessionDir?: string;
	blobDir?: string;
	sessionId: string;
}): Promise<string> {
	const durable = input.sessionDir?.trim() ? join(input.sessionDir, TOOL_RESULTS_SUBDIR) : input.blobDir;
	if (durable) {
		await mkdir(durable, { recursive: true, mode: SESSION_TEMP_DIR_MODE });
		if (process.platform !== "win32") {
			await chmod(durable, SESSION_TEMP_DIR_MODE);
		}
		return durable;
	}
	return ensureTempDir(join(resolveSessionTempDirPath(input.sessionId), TOOL_RESULTS_SUBDIR));
}

function isOwnedByCurrentUser(uid: number | bigint): boolean {
	const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (typeof currentUid !== "number") {
		return true;
	}
	return typeof uid === "bigint" ? uid === BigInt(currentUid) : uid === currentUid;
}

function sameFileIdentity(left: { dev: bigint; ino: bigint }, right: { dev: bigint; ino: bigint }): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Force an open persisted file to owner-only and prove it.
 *
 * `mode` on open is a request the process umask narrows, so a hostile or merely
 * odd umask can leave the file at 000 — advertised but unreadable. Throws when
 * the mode cannot be reached or the file belongs to another account.
 */
async function enforceOwnerOnlyMode(handle: FileHandle, filepath: string): Promise<void> {
	if (process.platform === "win32") {
		return;
	}
	const before = await handle.stat();
	if (!isOwnedByCurrentUser(before.uid)) {
		throw new Error(`persisted tool result ${filepath} is owned by another account`);
	}
	await handle.chmod(SESSION_TEMP_FILE_MODE);
	const after = await handle.stat();
	if ((after.mode & 0o777) !== SESSION_TEMP_FILE_MODE) {
		throw new Error(`persisted tool result ${filepath} could not be restricted to 0600`);
	}
	if (!isOwnedByCurrentUser(after.uid)) {
		throw new Error(`persisted tool result ${filepath} is owned by another account`);
	}
}

/**
 * Validate a file left by a previous turn before advertising it again.
 *
 * The replay path is what makes repeated calls idempotent, but a file that is no
 * longer ours, or is no longer owner-only, must not be handed back. It is never
 * deleted either: refusing costs a preview, deleting could destroy someone
 * else's data.
 */
async function adoptExistingResultFile(filepath: string): Promise<boolean> {
	try {
		const initialPathStat = await lstat(filepath, { bigint: true });
		if (initialPathStat.isSymbolicLink() || !initialPathStat.isFile() || !isOwnedByCurrentUser(initialPathStat.uid)) {
			return false;
		}
		const noFollow =
			process.platform !== "win32" && typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		const handle = await open(filepath, constants.O_RDONLY | noFollow);
		try {
			const handleStat = await handle.stat({ bigint: true });
			if (!handleStat.isFile() || !sameFileIdentity(initialPathStat, handleStat)) {
				return false;
			}
			const pathBeforeChmod = await lstat(filepath, { bigint: true });
			if (
				pathBeforeChmod.isSymbolicLink() ||
				!pathBeforeChmod.isFile() ||
				!sameFileIdentity(initialPathStat, pathBeforeChmod) ||
				!sameFileIdentity(handleStat, pathBeforeChmod) ||
				!isOwnedByCurrentUser(pathBeforeChmod.uid)
			) {
				return false;
			}
			await enforceOwnerOnlyMode(handle, filepath);

			// Do not advertise a path replaced while the descriptor was open.
			const [finalPathStat, finalHandleStat] = await Promise.all([
				lstat(filepath, { bigint: true }),
				handle.stat({ bigint: true }),
			]);
			return (
				!finalPathStat.isSymbolicLink() &&
				finalPathStat.isFile() &&
				finalHandleStat.isFile() &&
				sameFileIdentity(finalPathStat, finalHandleStat) &&
				isOwnedByCurrentUser(finalPathStat.uid) &&
				isOwnedByCurrentUser(finalHandleStat.uid)
			);
		} finally {
			await handle.close();
		}
	} catch {
		return false;
	}
}
/**
 * Persist the full tool output to a file named by the SHA-256 of what is stored, and return its path and digest.
 *
 * Identical outputs share one file: the write uses the `wx` flag and treats `EEXIST`
 * as success — this also makes repeated calls (e.g. replay/compaction) idempotent
 * without rewriting. Returns `undefined` on any other write failure so the caller
 * can fall back to returning the original result unchanged.
 */
async function persistToolOutput(input: {
	text: string;
	sessionDir?: string;
	blobDir?: string;
	sessionId: string;
}): Promise<{ readonly filepath: string; readonly sha256: string } | undefined> {
	let dir: string;
	try {
		dir = await ensureToolResultsDir(input);
	} catch {
		// Refused (see TempDirRefusedError) or unwritable: leave the result unchanged
		// rather than pointing the model at a directory we do not own.
		return undefined;
	}
	const stored = capPersistedText(input.text);
	const sha256 = createHash("sha256").update(stored, "utf8").digest("hex");
	const filepath = join(dir, `${sha256}.txt`);
	try {
		const handle = await open(filepath, "wx", SESSION_TEMP_FILE_MODE);
		try {
			await handle.writeFile(stored, "utf8");
			await enforceOwnerOnlyMode(handle, filepath);
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (getErrnoCode(error) === "EEXIST") {
			// Already persisted — reuse the existing file, but only after confirming
			// it is still ours and still owner-only.
			return (await adoptExistingResultFile(filepath)) ? { filepath, sha256 } : undefined;
		}
		return undefined;
	}
	return { filepath, sha256 };
}

/**
 * When a tool result's text content exceeds the persistence threshold (default
 * 50,000 chars — {@link DEFAULT_MAX_RESULT_SIZE_CHARS}), persist the full output
 * to a session-scoped file and replace the model-visible content with a
 * `<persisted-output>` preview that references the saved file.
 *
 * Returns `undefined` (leave the result untouched) when the result is within the
 * threshold, contains image blocks, or cannot be persisted to disk.
 *
 * Convention ported from the upstream `maybePersistLargeToolResult`
 * (mehmoodosman/claude-code, `src/utils/toolResultStorage.ts`).
 */
export async function redirectOversizedToolResult<TDetails = unknown>(
	input: RedirectOversizedToolResultInput<TDetails>,
): Promise<OversizedToolResultReplacement | undefined> {
	const content = input.result.content;

	// Image content must be sent to the model as-is; never persist.
	if (hasImageBlock(content)) {
		return undefined;
	}

	const text = collectText(content);
	const threshold = getPersistenceThreshold(input.maxResultSizeChars);
	if (text.length <= threshold) {
		return undefined;
	}

	const persisted = await persistToolOutput({
		text,
		sessionDir: input.sessionDir,
		blobDir: input.blobDir,
		sessionId: input.sessionId,
	});
	// Graceful degradation: if persistence failed, leave the original result unchanged.
	if (persisted === undefined) {
		return undefined;
	}

	const { preview, hasMore } = generatePreview(text, PREVIEW_SIZE_BYTES);
	const message = buildPersistedOutputMessage({
		originalSizeBytes: Buffer.byteLength(text, "utf8"),
		filepath: persisted.filepath,
		sha256: persisted.sha256,
		preview,
		hasMore,
	});

	return {
		content: [{ type: "text", text: message }],
		// Details (tool metadata) are passed through untouched, matching the reference
		// convention which only replaces the model-visible content block.
		details: input.result.details,
		isError: input.isError,
	};
}
