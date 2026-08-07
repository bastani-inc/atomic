/**
 * The file-backed extension paths loaded in the current resource-loader cycle.
 *
 * A builtin inline extension sometimes has to stand down for a file extension
 * that does the same job — the Herdr reporter defers to a file-based
 * `herdr-agent-state` integration. Disk existence cannot answer that question:
 * a path can exist and still be disabled, shadowed, or fail to load. This
 * records what actually loaded, and is refreshed on every reload before the
 * inline factories run, so a factory reads its own cycle's answer.
 */

let loadedFileExtensionPaths: readonly string[] = [];

/** Record the file extensions loaded this cycle. Called before inline factories run. */
export function setLoadedFileExtensionPaths(paths: readonly string[]): void {
	loadedFileExtensionPaths = [...paths];
}

/** The file extensions loaded in the current cycle. */
export function getLoadedFileExtensionPaths(): readonly string[] {
	return loadedFileExtensionPaths;
}
