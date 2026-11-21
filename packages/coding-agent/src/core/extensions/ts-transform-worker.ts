import { parentPort, workerData } from "node:worker_threads";
import { createJiti } from "jiti";
import type { TransformPreparation } from "./source-builtin-imports.js";

/**
 * Writes the transforms of the target modules, and of the modules they import statically, into the transpile cache
 * through the same transform the extension loader uses, so the loader's next load of them is a cache hit. Nothing
 * is evaluated. Sends one message once the writes are done.
 */

/**
 * A module beside this one. The worker runs the compiled JavaScript, or the TypeScript source itself where the
 * runtime runs that (Bun, or Node stripping types), and Node does not map a `.js` import to its `.ts` source.
 */
function sibling(name: string): string {
	return new URL(`./${name}${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`, import.meta.url).href;
}

async function prepare({ cacheDir, template, targets, visited }: TransformPreparation): Promise<void> {
	const [{ readModuleSourceSync, resolveFrom, walkStaticImports }, { createTypeScriptSourceSpecifierTransform }] =
		await Promise.all([
			import(sibling("transform-graph")) as Promise<typeof import("./transform-graph.js")>,
			import(sibling("ts-source-specifiers")) as Promise<typeof import("./ts-source-specifiers.js")>,
		]);
	const transform = createTypeScriptSourceSpecifierTransform(createJiti, import.meta.url, () => cacheDir);
	await walkStaticImports(
		targets,
		new Set(visited),
		(filename) => {
			const source = readModuleSourceSync(filename);
			if (source === undefined) return undefined;
			try {
				return transform({ ...template, filename, source, async: true, ts: true }).code;
			} catch {
				return undefined;
			}
		},
		(importer, specifier) => resolveFrom(createJiti, importer, specifier),
	);
	await transform.flush();
}

await prepare(workerData as TransformPreparation).finally(() => parentPort?.postMessage("done"));
