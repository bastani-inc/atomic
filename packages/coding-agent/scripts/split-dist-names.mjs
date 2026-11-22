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

/**
 * The files to write so that each shared file `released` names, which a recorded earlier release imports on demand,
 * is still there when this split does not write it: one that re-exports the names that release's file exported from the
 * shared file this split writes for the same module (the same stem, esbuild's name for the module or package the file
 * holds), which exports every one of them. A process of that release imports such a file by its name, and must find
 * this build's code of that module, not a second copy. Each such file comes with its source map, as every shared file
 * does. Fails, naming the file, when no shared file of this split, or more than one, can stand for it.
 *
 * @param {readonly { version: string, path: string, names: readonly string[] }[]} released
 * @param {readonly { file: string, stem: string, exports: readonly string[] }[]} outputs
 * @param {string} directory the shared files' directory below `dist`
 * @returns {{ path: string, contents: string }[]}
 */
export function compatSharedFiles(released, outputs, directory) {
	const written = new Set(outputs.map((output) => `${directory}/${output.file}`));
	/** @type {Map<string, { path: string, contents: string }>} */
	const files = new Map();
	for (const { version, path, names } of released) {
		if (written.has(path) || files.has(path)) continue;
		const stem = new RegExp(`^${directory}/([^/]+)-[A-Z2-7]{8}\\.js$`).exec(path)?.[1];
		const candidates = outputs.filter(
			(output) => output.stem === stem && names.every((name) => output.exports.includes(name)),
		);
		if (candidates.length !== 1)
			throw new Error(
				`split-dist: ${version} imports dist/${path} on demand, and ${candidates.length === 0 ? "no" : "more than one"} shared file of this build holds its module with its exports (${names.join(", ")})`,
			);
		const name = path.slice(path.lastIndexOf("/") + 1);
		// Like every shared file, it has a source map: one with no sources, as it holds no code of its own.
		files.set(path, {
			path,
			contents: `export { ${[...names].sort().join(", ")} } from "./${candidates[0].file}";\n//# sourceMappingURL=${name}.map\n`,
		});
		files.set(`${path}.map`, {
			path: `${path}.map`,
			contents: `${JSON.stringify({ version: 3, file: name, sources: [], names: [], mappings: "" })}\n`,
		});
	}
	return [...files.values()];
}
