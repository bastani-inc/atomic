import path from "node:path";

/** The `node:path` operations `isPathInside` needs; pass `path.win32` or `path.posix` to use one platform's rules. */
export type PathInsideApi = Pick<typeof path, "relative" | "isAbsolute" | "sep">;

/**
 * Whether `child` is `parent` itself or a path below it.
 *
 * Only a relative path that is `..` or starts with `..` and a separator leaves `parent`, so a child named `..cache`
 * or `..notes.md` stays inside. On Windows, `relative` compares drive letters and names case-insensitively, and a
 * child on another drive or share yields an absolute path, which counts as outside.
 */
export function isPathInside(parent: string, child: string, pathApi: PathInsideApi = path): boolean {
	const relative = pathApi.relative(parent, child);
	// "" (the parent itself) passes every test below. On POSIX `../` and `..${sep}` are the same prefix; on Windows
	// either separator can follow the `..`.
	return (
		relative !== ".." &&
		!relative.startsWith("../") &&
		!relative.startsWith(`..${pathApi.sep}`) &&
		!pathApi.isAbsolute(relative)
	);
}
