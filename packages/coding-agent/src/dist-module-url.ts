/**
 * The URL of a compiled module, from its path below `dist`: a bundled module reads its own `import.meta.url` from here
 * (see `scripts/split-dist.mjs`), so it finds the files beside it wherever the package is installed.
 */
export function distModuleUrl(path: string): string {
	return new URL(path, import.meta.url).href;
}
