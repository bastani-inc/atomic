import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Split-launcher / foreign-build `import.meta.url` handling.
 *
 * Atomic's release binaries use a split launcher: a tiny compiled `atomic` /
 * `atomic.exe` executable sets `ATOMIC_CODING_AGENT=true` and then dynamically
 * imports the bundled sidecar `app.js` (plus raw-TS built-in extensions) from
 * disk next to the executable.
 *
 * Unlike pi's single monolithic `bun --compile` binary — where `import.meta.url`
 * is always a `$bunfs://` virtual-FS URL — the split sidecar bundle carries the
 * build machine's source path baked in at bundle time (e.g. a macOS
 * `file:///Users/.../app.js` URL). On Windows, `fileURLToPath()` rejects that
 * URL with `ERR_INVALID_FILE_URL_PATH` ("File URL path must be an absolute
 * path") because `/Users/...` has no drive letter, so every site that decodes
 * `import.meta.url` to a filesystem path must tolerate it.
 *
 * These helpers centralize that tolerance: decode normally, and only when the
 * decode fails under the split launcher fall back to a path resolved relative to
 * the launcher executable (where the sidecar bundle and its assets actually
 * live). This mirrors pi's convention of a single detection point rather than
 * scattered ad-hoc guards.
 */
export function isSplitLauncherRuntime(): boolean {
	return (
		process.env.ATOMIC_CODING_AGENT === "true" &&
		/(?:^|[\\/])atomic(?:\.exe)?$/i.test(process.execPath)
	);
}

/** Directory containing the launcher executable and its sidecar bundle/assets. */
export function splitLauncherDir(): string {
	return dirname(process.execPath);
}

/**
 * Resolve a module's directory from its `import.meta.url`, tolerating the
 * split-launcher case where the bundled URL is a foreign-OS build path.
 * `execRelativeSegments` locate the equivalent directory next to the launcher.
 */
export function moduleDirFromMetaUrl(metaUrl: string, ...execRelativeSegments: string[]): string {
	try {
		return dirname(fileURLToPath(metaUrl));
	} catch (error) {
		if (isSplitLauncherRuntime()) return join(splitLauncherDir(), ...execRelativeSegments);
		throw error;
	}
}

/**
 * Resolve a module's filename from its `import.meta.url`, tolerating the
 * split-launcher case. `execRelativeFile` locates the equivalent file next to
 * the launcher (used as a stable resolution base, e.g. for `createRequire`).
 */
export function moduleFileFromMetaUrl(metaUrl: string, execRelativeFile: string): string {
	try {
		return fileURLToPath(metaUrl);
	} catch (error) {
		if (isSplitLauncherRuntime()) return join(splitLauncherDir(), execRelativeFile);
		throw error;
	}
}
