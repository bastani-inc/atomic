import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { fileGenerationOf, legacyFileGenerationOf } from "../creation-time.js";

function headerHash(headerStamp: string): string {
	return createHash("sha256").update(headerStamp).digest("hex").slice(0, 16);
}

/**
 * The epoch of a session file: its device and inode, its creation time where that stays put (see `creation-time.ts`),
 * and its header. It changes when the file is replaced, and not when only its times are set.
 */
export function fileEpochOf(stats: BigIntStats, headerStamp: string): string {
	return `${fileGenerationOf(stats)}:${headerHash(headerStamp)}`;
}

/**
 * The epoch every build before 0.10.11 gave a session file, with its creation time in it on every platform, which
 * sidecars and chat records written by an older build hold. It is the current one wherever creation times stay put.
 */
export function legacyFileEpochOf(stats: BigIntStats, headerStamp: string): string {
	return `${legacyFileGenerationOf(stats)}:${headerHash(headerStamp)}`;
}

/** Whether `epoch` holds a creation time, as every epoch an older build computes does. */
export function epochHasCreationTime(epoch: string): boolean {
	return epoch.split(":").length === 4;
}
