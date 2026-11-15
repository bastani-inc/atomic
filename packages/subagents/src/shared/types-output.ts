/**
 * Output truncation helpers.
 */

import type { MaxOutputConfig } from "./types-results.js";

interface TruncationResult {
	text: string;
	truncated: boolean;
	originalBytes?: number;
	originalLines?: number;
	artifactPath?: string;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * The longest prefix of `text` that fits in `maxBytes` of UTF-8, cut at a
 * code-point boundary so no character is split (#4938).
 */
export function utf8Head(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text, "utf-8");
	if (bytes.length <= maxBytes) return text;
	let end = Math.max(0, maxBytes);
	// Back up over UTF-8 continuation bytes (10xxxxxx) to the start of the cut character.
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf-8");
}

export function truncateOutput(
	output: string,
	config: Required<MaxOutputConfig>,
	artifactPath?: string,
): TruncationResult {
	const lines = output.split("\n");
	const bytes = Buffer.byteLength(output, "utf-8");

	if (bytes <= config.bytes && lines.length <= config.lines) {
		return { text: output, truncated: false };
	}

	let truncatedLines = lines;
	if (lines.length > config.lines) {
		truncatedLines = lines.slice(0, config.lines);
	}

	const result = utf8Head(truncatedLines.join("\n"), config.bytes);
	const keptLines = result === "" ? 0 : result.split("\n").length;
	const marker = `[TRUNCATED: showing first ${keptLines} of ${lines.length} lines, ${formatBytes(Buffer.byteLength(result))} of ${formatBytes(bytes)}${artifactPath ? ` - full output at ${artifactPath}` : ""}]\n`;

	return {
		text: marker + result,
		truncated: true,
		originalBytes: bytes,
		originalLines: lines.length,
		artifactPath,
	};
}
