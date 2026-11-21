/**
 * The name of a shared file the split writes (see `split-dist.mjs`).
 *
 * A shared file is named by the first of the package's own modules it holds, by path, and by the names it exports:
 * not by its content. An install updated in place keeps the name of every shared file whose first module and exports
 * stay the same, so a process still running from the earlier install, which loaded the file under that name, finds in
 * it every name the new code imports from it. A file whose exports change gets another name: such a process loads the
 * new code's copy of it beside the one it holds. The name keeps esbuild's form and length, so no source map shifts.
 */
import { createHash } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Eight base-32 characters of the SHA-256 of `key`, as esbuild's own names have. */
export function groupName(key) {
	const bytes = createHash("sha256").update(key).digest();
	let name = "";
	for (let index = 0; index < 8; index++) name += BASE32[(bytes[index] ?? 0) % 32];
	return name;
}

/**
 * The name of the shared file `stem` from its metafile entry: its inputs, its exports and, for a file that only
 * re-exports a dynamically imported module and holds no module of its own, that module.
 *
 * @param {string} stem
 * @param {{ inputs: Record<string, unknown>, exports: readonly string[], entryPoint?: string }} meta
 * @param {string} output
 */
export function sharedFileName(stem, meta, output) {
	// The package's own modules first: an inlined dependency's update must not rename a file.
	const inputs = Object.keys(meta.inputs).sort();
	const own = inputs.filter((input) => input.startsWith("dist/"));
	const members = own.length > 0 ? own : inputs;
	const first = members.length > 0 ? `module:${members[0]}` : `entry:${meta.entryPoint ?? output}`;
	return `${stem}-${groupName(`${first}\0${[...meta.exports].sort().join(",")}`)}.js`;
}
