import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";
import { WorkspaceConfigError, type WorkspaceConfigSource } from "./errors.ts";
import type { WorktreeSnapshotSettings } from "./types.ts";

const { pool: _pool, ...SNAPSHOT_DEFAULTS } = SETTINGS_DEFAULTS.snapshots;

export const DEFAULT_WORKTREE_SNAPSHOT_SETTINGS: WorktreeSnapshotSettings = Object.freeze({ ...SNAPSHOT_DEFAULTS });

export type WorktreeSnapshotSettingsInput = Partial<WorktreeSnapshotSettings>;

const BOOLEAN_FIELDS = ["enabled", "includeUntracked", "autoCollect"] as const;
const INTEGER_FIELDS = ["maxFileBytes", "maxSnapshotBytes", "fullEvery", "collectIntervalSeconds"] as const;

/**
 * Overlays `input` on `base` after checking every field, so a bad value is reported with its source before any Git
 * command runs. `prefix` names the option or setting path in the error, such as `snapshots`.
 */
export function resolveWorktreeSnapshotSettings(
	input: WorktreeSnapshotSettingsInput | undefined,
	source: WorkspaceConfigSource,
	prefix: string,
	base: WorktreeSnapshotSettings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
): WorktreeSnapshotSettings {
	if (input === undefined) return base;
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		throw new WorkspaceConfigError(source, prefix, "an object");
	}
	for (const field of BOOLEAN_FIELDS) {
		const value = input[field];
		if (value !== undefined && typeof value !== "boolean") {
			throw new WorkspaceConfigError(source, `${prefix}.${field}`, "true or false");
		}
	}
	for (const field of INTEGER_FIELDS) {
		const value = input[field];
		if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
			throw new WorkspaceConfigError(source, `${prefix}.${field}`, "a positive integer");
		}
	}
	if (input.graceSeconds !== undefined && (!Number.isSafeInteger(input.graceSeconds) || input.graceSeconds < 0)) {
		throw new WorkspaceConfigError(source, `${prefix}.graceSeconds`, "a non-negative integer number of seconds");
	}
	return Object.freeze({
		enabled: input.enabled ?? base.enabled,
		includeUntracked: input.includeUntracked ?? base.includeUntracked,
		maxFileBytes: input.maxFileBytes ?? base.maxFileBytes,
		maxSnapshotBytes: input.maxSnapshotBytes ?? base.maxSnapshotBytes,
		fullEvery: input.fullEvery ?? base.fullEvery,
		autoCollect: input.autoCollect ?? base.autoCollect,
		collectIntervalSeconds: input.collectIntervalSeconds ?? base.collectIntervalSeconds,
		graceSeconds: input.graceSeconds ?? base.graceSeconds,
	});
}
