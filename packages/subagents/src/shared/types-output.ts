/**
 * Output truncation helpers.
 */

import type { MaxOutputConfig } from "./types-results.ts";

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

	let result = truncatedLines.join("\n");
	if (Buffer.byteLength(result, "utf-8") > config.bytes) {
		let low = 0;
		let high = result.length;
		while (low < high) {
			const mid = Math.floor((low + high + 1) / 2);
			if (Buffer.byteLength(result.slice(0, mid), "utf-8") <= config.bytes) {
				low = mid;
			} else {
				high = mid - 1;
			}
		}
		result = result.slice(0, low);
	}

	const keptLines = result.split("\n").length;
	const marker = `[TRUNCATED: showing first ${keptLines} of ${lines.length} lines, ${formatBytes(Buffer.byteLength(result))} of ${formatBytes(bytes)}${artifactPath ? ` - full output at ${artifactPath}` : ""}]\n`;

	return {
		text: marker + result,
		truncated: true,
		originalBytes: bytes,
		originalLines: lines.length,
		artifactPath,
	};
}
