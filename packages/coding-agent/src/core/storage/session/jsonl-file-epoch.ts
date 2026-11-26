import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";

/**
 * Whether a session file's epoch holds its creation time. macOS moves a file's creation time back to its modification
 * time whenever that is set earlier, as a clock that jumps back does, so there the creation time does not stay with
 * the file; APFS never reuses an inode number, so there the device and inode alone tell a replaced file apart.
 * Elsewhere the creation time stays put, and tells a new file from a deleted one whose inode number it reused.
 */
export const EPOCH_HAS_BIRTHTIME = process.platform !== "darwin";

function headerHash(headerStamp: string): string {
	return createHash("sha256").update(headerStamp).digest("hex").slice(0, 16);
}

/** The generation of a session file: its device and inode, its creation time where that stays put, and its header. */
export function fileEpochOf(stats: BigIntStats, headerStamp: string): string {
	return EPOCH_HAS_BIRTHTIME
		? legacyFileEpochOf(stats, headerStamp)
		: `${stats.dev}:${stats.ino}:${headerHash(headerStamp)}`;
}

/**
 * The epoch every platform gave a session file before macOS left out its creation time, which sidecars and chat
 * records written by an older build still hold. It is the current one everywhere but macOS.
 */
export function legacyFileEpochOf(stats: BigIntStats, headerStamp: string): string {
	return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}:${headerHash(headerStamp)}`;
}
