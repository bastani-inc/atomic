import { parentPort, workerData } from "node:worker_threads";
import { createJiti } from "./jiti-loader.ts";
import type { TransformPreparation } from "./source-builtin-imports.ts";
import { readModuleSourceSync, resolveFrom, walkStaticImports } from "./transform-graph.ts";
import { createTypeScriptSourceSpecifierTransform } from "./ts-source-specifiers.ts";

/**
 * Writes the transforms of the target modules, and of the modules they import statically, into the transpile cache
 * through the same transform the extension loader uses, so the loader's next load of them is a cache hit. Nothing
 * is evaluated. Sends one message once the writes are done.
 */
async function prepare({ cacheDir, template, targets, visited }: TransformPreparation): Promise<void> {
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
