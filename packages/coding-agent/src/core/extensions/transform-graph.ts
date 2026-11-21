import * as fs from "node:fs";
import type { createJiti } from "jiti";
import type { TransformTemplate } from "./source-builtin-imports.js";
import type { TransformedModule } from "./ts-source-specifiers.js";

type TransformOptions = Parameters<NonNullable<ReturnType<typeof createJiti>["options"]["transform"]>>[0];

const TYPESCRIPT_FILE = /\.[cm]?tsx?$/;
// Never wait for a writer: a FIFO opened this way returns at once and is then skipped as not a regular file.
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);

/** The options jiti's transform hands the `transform` option for a TypeScript module it imports. */
export function moduleTransformOptions(
	template: TransformTemplate,
	filename: string,
	source: string,
): TransformOptions {
	const babel = template.babel?.sourceMaps ? { sourceFileName: filename, ...template.babel } : template.babel;
	return { ...template, babel, filename, source, ts: true, async: true };
}

export function isTypeScriptFile(filename: string): boolean {
	return TYPESCRIPT_FILE.test(filename);
}

/** The source of a regular file, or `undefined` if it cannot be read or is not a regular file. */
export async function readModuleSource(filename: string): Promise<string | undefined> {
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(filename, READ_FLAGS);
	} catch {
		return undefined;
	}
	try {
		return (await handle.stat()).isFile() ? await handle.readFile("utf8") : undefined;
	} catch {
		return undefined;
	} finally {
		await handle.close().catch(() => {});
	}
}

/** {@link readModuleSource}, synchronously. */
export function readModuleSourceSync(filename: string): string | undefined {
	let fd: number;
	try {
		fd = fs.openSync(filename, READ_FLAGS);
	} catch {
		return undefined;
	}
	try {
		return fs.fstatSync(fd).isFile() ? fs.readFileSync(fd, "utf8") : undefined;
	} catch {
		return undefined;
	} finally {
		fs.closeSync(fd);
	}
}

/** Resolves an import as jiti does from `importer`, or `undefined`. */
export function resolveFrom(
	createJitiImpl: typeof createJiti,
	importer: string,
	specifier: string,
): string | undefined {
	try {
		return createJitiImpl(importer, { fsCache: false, moduleCache: false }).resolve(specifier);
	} catch {
		return undefined;
	}
}

/**
 * Visits `targets` and the TypeScript modules they import statically, each once, skipping those in `visited` (which
 * it adds to). `transformed` gives a module's transform, with the imports Babel found in it, or `undefined` to not
 * look into its imports; `resolve` names an import as jiti resolves it from its importer.
 */
export async function walkStaticImports(
	targets: readonly string[],
	visited: Set<string>,
	transformed: (filename: string) => TransformedModule | undefined | Promise<TransformedModule | undefined>,
	resolve: (importer: string, specifier: string) => string | undefined,
): Promise<void> {
	const pending = [...targets];
	for (let filename = pending.pop(); filename !== undefined; filename = pending.pop()) {
		if (visited.has(filename)) continue;
		visited.add(filename);
		const module = await transformed(filename);
		if (module === undefined) continue;
		for (const specifier of module.imports) {
			const imported = resolve(filename, specifier);
			if (imported !== undefined && isTypeScriptFile(imported)) pending.push(imported);
		}
	}
}
