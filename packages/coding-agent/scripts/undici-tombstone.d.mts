export const UNDICI_TOMBSTONE_SHIMS: readonly string[];
export function undiciTombstoneEntries(): ReadonlyArray<{ readonly path: string; readonly contents: string }>;
export function appendUndiciTombstoneToTarball(tarballPath: string): boolean;
export function appendUndiciTombstonePostpack(packageDir?: string): boolean;
