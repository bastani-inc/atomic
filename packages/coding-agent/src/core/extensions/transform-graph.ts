import * as fs from "node:fs";
import type { createJiti } from "jiti";

/**
 * The modules a module's evaluation imports before its own code runs. jiti's transform turns each `import`
 * statement (and `export … from`) into a top-level `var _name = await jitiImport("…");` (the call wrapped in an
 * interop helper for some default imports), or a bare `await jitiImport("…");` for an import without bindings.
 * This is a text match on that output, used only to prepare transforms ahead of the loader: dynamic imports, which
 * jiti emits inside a promise callback, and `require` calls are not followed, and a statement-shaped line elsewhere
 * in the output only means one more file is prepared.
 */
const STATIC_IMPORT =
	/(?:^|[;}])[ \t]*(?:var _[\w$]+ = (?:_interopRequire\w*\()?)?await jitiImport\("(\.\.?\/[^"\\\r\n]*)"\)\)?;/gm;
const TYPESCRIPT_FILE = /\.[cm]?tsx?$/;
// Never wait for a writer: a FIFO opened this way returns at once and is then skipped as not a regular file.
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);

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
 * it adds to). `transformed` gives a module's transformed code, or `undefined` to not look into its imports; `resolve`
 * names an import as jiti resolves it from its importer.
 */
export async function walkStaticImports(
	targets: readonly string[],
	visited: Set<string>,
	transformed: (filename: string) => string | undefined | Promise<string | undefined>,
	resolve: (importer: string, specifier: string) => string | undefined,
): Promise<void> {
	const pending = [...targets];
	for (let filename = pending.pop(); filename !== undefined; filename = pending.pop()) {
		if (visited.has(filename)) continue;
		visited.add(filename);
		const code = await transformed(filename);
		if (code === undefined) continue;
		for (const [, specifier] of code.matchAll(STATIC_IMPORT)) {
			const imported = specifier === undefined ? undefined : resolve(filename, specifier);
			if (imported !== undefined && isTypeScriptFile(imported)) pending.push(imported);
		}
	}
}
