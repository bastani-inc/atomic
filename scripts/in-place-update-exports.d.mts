/** What a release holds of one of Atomic's packages, for the in-place update check. */
export interface PackageRecord {
	version: string;
	/** The package's exports map, by key, with the file its `import` condition names; `null` without one. */
	exports: Record<string, string> | null;
	main: string | null;
	/** Each JavaScript file's export names (`*` for any name, when an `export *` comes from another package). */
	files: Record<string, string[]>;
	/** The files the release's code imports on demand (`<package>:<path>`), with the files that import them. */
	lazy: Record<string, string[]>;
	/** The files the release's code starts as a worker by path, with the files that start them. */
	workers: Record<string, string[]>;
	/** The files a CLI process has loaded before it loads anything on demand. */
	startup: string[];
	/** The files every running process has loaded. */
	running: string[];
}

export interface ReleaseRecord {
	version: string;
	packages: Record<string, PackageRecord>;
}

export function recordRelease(dirs: string[]): ReleaseRecord;
export function checkRelease(earlier: ReleaseRecord, dirs: string[], allowed?: Record<string, string>): string[];
export function checkDeferredChunkDisjointness(earlier: ReleaseRecord, dirs: string[]): string[];
export function formatRecord(record: ReleaseRecord): string;
