/**
 * Gates for the modules an earlier release imports on demand by their paths (`in-place-update/<version>.json`).
 *
 * A process of an earlier release that keeps running from an install updated in place (`npm install -g`, `bun add -g`)
 * imports such a module by its path when it first needs it, and so gets this build's file. Importing a module resolves
 * and links its whole static graph, and this build's shared files then meet the copies of Atomic's packages that process
 * already holds: a name or package subpath they lack fails to link, and code written for this build's copies can fail
 * as it runs. Where that happens the runtime's error says nothing of the update. So the file at such a path is a gate:
 * it imports the module's code, which this build writes beside it, and gives its exports. When that import fails, it
 * asks which release the process runs, and in a process of an earlier release fails with the message the application
 * gives for code an update replaced (`src/utils/updated-install.ts`): "<app> was updated to <version> while this
 * session was running; restart it to keep using <feature>.", the runtime's error as its cause. Any other failure is
 * the runtime's own, and an import that succeeds is as it was: a feature the update's code can serve keeps working.
 *
 * The release a process runs is the `VERSION` of a module every process of that release loaded at its start, which the
 * process holds as it was: the module loader gives it again for its URL. Node resolves the URL to the file first, so a
 * file must be there: where this build writes none, it writes a stub that exports nothing, and a process that never
 * loaded that path gets the stub. Each release's module is asked for in turn, and this build's own files last: a process
 * that does not hold one would load and run it.
 */

import { codeStringArrayLiteral, codeStringLiteral } from "./code-string-literal.mjs";

/** The first line of each gate and stub, by which a later split knows it as a split's output, not compiled code. */
export const GATE_FILE_MARK = "// Written by the build (scripts/in-place-update-gate.mjs)";

/**
 * Where this build writes the code of a gated module `path`: a path of its own, which no earlier release imports and so
 * never needs a gate. This build's own code imports it there, and so do the releases after it, each with a call-site
 * guard ({@link callSiteGuardSource}); a later release keeps the file at that path.
 */
export const codePath = (path) => {
	if (!path.endsWith(".js")) throw new Error(`in-place update gates: ${path} is not a module's path`);
	return `${path.slice(0, -".js".length)}.code.js`;
};

/** The module a recorded on-demand path names: an earlier release's path of a gated module's code, or the module. */
export const moduleOfPath = (path) => {
	for (const suffix of [".impl.js", ".code.js"])
		if (path.endsWith(suffix)) return `${path.slice(0, -suffix.length)}.js`;
	return path;
};

/**
 * The first release whose own code guards each module it imports on demand at the call site: a process of it, or of a
 * later one, tells itself to restart when an update's code cannot load, so the modules its record names need no gate.
 */
export const GUARDED_SINCE = "0.10.5-alpha.1";

/** Characters of a release's version (`0.10.5`, `0.10.5-alpha.1`, `1.0.0+build.7`). */
const VERSION_CHARACTERS = new Set("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-+");

/** `version`, which the gates and guards write inside a template literal: a release's version needs no escape there. */
function releaseVersion(version) {
	if (version === "" || [...version].some((character) => !VERSION_CHARACTERS.has(character)))
		throw new Error(`in-place update gates: ${JSON.stringify(version)} is not a release's version`);
	return version;
}

/** The probes of the release a process runs, as the gates and the call-site guards share them (see the gates above). */
function runningReleaseSource(indent, probes, version) {
	return [
		'const releases = (globalThis[Symbol.for("atomic.in-place-update-release.v1")] ??= new Map());',
		`const key = \`\${root.href}#${releaseVersion(version)}\`;`,
		"let release = releases.get(key);",
		"if (release === undefined) {",
		"\trelease = (async () => {",
		`\t\tfor (const path of ${codeStringArrayLiteral(probes)}) {`,
		"\t\t\ttry {",
		"\t\t\t\tconst held = await import(new URL(path, root).href);",
		'\t\t\t\tif (typeof held.VERSION === "string") return { version: held.VERSION, name: held.APP_NAME };',
		"\t\t\t} catch {",
		"\t\t\t\t// Not a file this process can load: the next.",
		"\t\t\t}",
		"\t\t}",
		"\t\treturn undefined;",
		"\t})();",
		"\treleases.set(key, release);",
		"}",
		"const running = await release;",
	].map((line) => `${indent}${line}`);
}

/** The name of the function {@link callSiteGuardSource} defines. */
export const CALL_SITE_GUARD = "__atomicOnDemandFailed";

/**
 * The key (`Symbol.for`) of what a call-site guard's restart error carries: the application, the release the update
 * installed and the feature, so that a caller loading a feature on demand (`src/utils/updated-install.ts`) can name its
 * own feature in the message.
 */
export const CALL_SITE_RESTART_KEY = "atomic.on-demand-restart.v1";

/**
 * The function this build appends to each of its files that imports a module on demand, and which each such import
 * calls when it rejects (`import("./x.code.js").catch((error) => __atomicOnDemandFailed(error, "<feature>"))`): when
 * the process runs an earlier release than this file's (a process of an earlier release that loaded it after an update),
 * or the installation on disk is no longer this file's release (an update replaced it under this process), it rejects
 * with the restart message and the failure as its cause; otherwise with the failure. An import that succeeds never calls
 * it. `root` is the path from the file to `dist`.
 *
 * @param {{ root: string, probes: readonly string[], version: string, application: string }} guard
 */
export function callSiteGuardSource({ root, probes, version, application }) {
	return [
		`// ${CALL_SITE_GUARD}: written by the build (scripts/in-place-update-gate.mjs). An import of this release's code on`,
		"// demand that fails in a process an in-place update left running says to restart.",
		`function ${CALL_SITE_GUARD}(error, feature) {`,
		"\treturn (async () => {",
		`\t\tconst root = new URL(${codeStringLiteral(root)}, import.meta.url);`,
		...runningReleaseSource("\t\t", probes, version),
		"\t\tlet installed;",
		"\t\ttry {",
		// Not an import of `node:fs/promises`: tools that read this file's imports take one for a module it loads.
		'\t\t\tconst { readFile } = process.getBuiltinModule("node:fs/promises");',
		'\t\t\tinstalled = JSON.parse(await readFile(new URL("../package.json", root), "utf8")).version;',
		"\t\t} catch {",
		"\t\t\t// No installation to read, as in a bundle of the package: the release the process runs decides.",
		"\t\t}",
		`\t\tconst updatedTo = typeof installed === "string" && installed !== ${codeStringLiteral(version)} ? installed : running !== undefined && running.version !== ${codeStringLiteral(version)} ? ${codeStringLiteral(version)} : undefined;`,
		"\t\tif (updatedTo === undefined) throw error;",
		`\t\tconst application = typeof running?.name === "string" ? running.name : ${codeStringLiteral(application)};`,
		"\t\tconst restart = new Error(`${application} was updated to ${updatedTo} while this session was running; restart it to keep using ${feature}.`, {",
		"\t\t\tcause: error,",
		"\t\t});",
		// What a caller that loads the feature on demand (`loadOnDemand`) needs to name it in the message itself.
		'\t\trestart.name = "UpdatedInstallError";',
		`\t\trestart[Symbol.for(${codeStringLiteral(CALL_SITE_RESTART_KEY)})] = { application, updatedTo, feature };`,
		"\t\tthrow restart;",
		"\t})();",
		"}",
		"",
	].join("\n");
}


/**
 * The module of each recorded release that tells which release a process runs: a file every process of that release
 * loaded (its record's `running` files, those its CLI loaded at start first) that exports `VERSION` and `APP_NAME`.
 * Those this build does not write come first, each with a stub to write, then those it does write. A second file of
 * this build would load in a process of a release that holds the other, so at most one may be one. A record without
 * `running` files is left out.
 *
 * @param {{ version: string, packages: Record<string, { files?: Record<string, string[] | null>, startup?: string[], running?: string[] }> }[]} records
 * @param {(path: string) => boolean} isWritten whether this build writes `path` (in `dist`)
 * @returns {{ probes: string[], stubs: string[] }} paths in `dist`
 */
export function releaseVersionModules(records, isWritten) {
	const stubbed = new Set();
	const written = new Set();
	for (const record of records) {
		const atomic = record.packages["@bastani/atomic"];
		// A record that names no files every process loaded holds only what it was written for, as a test's does.
		if (atomic?.running === undefined) continue;
		const startup = new Set(atomic?.startup ?? []);
		const holders = (atomic?.running ?? [])
			.filter((file) => {
				const names = atomic?.files?.[file] ?? [];
				return names.includes("VERSION") && names.includes("APP_NAME");
			})
			.map((file) => file.replace(/^dist\//, ""))
			.sort((a, b) => Number(!startup.has(`dist/${a}`)) - Number(!startup.has(`dist/${b}`)));
		if (holders.length === 0)
			throw new Error(`in-place update gates: ${record.version} records no module every process of it loaded that names its VERSION`);
		const stubbable = holders.find((path) => !isWritten(path));
		if (stubbable !== undefined) stubbed.add(stubbable);
		else written.add(holders[0]);
	}
	if (written.size > 1)
		throw new Error(
			`in-place update gates: more than one recorded release tells its version only through a file this build writes (${[...written].join(", ")})`,
		);
	return { probes: [...stubbed, ...written], stubs: [...stubbed] };
}

/** What a module is for, as its restart message names it, by its path in `dist`. */
const FEATURES = [
	[/^core\/export-html\//, "session export"],
	[/^modes\/interactive\/components\/stored-tree-view\.js$|^core\/storage\/session\/tree-/, "/tree"],
	[/^modes\/interactive\/components\/user-message-selector-archive\.js$/, "/fork"],
	[/^core\/tasks\//, "/tasks"],
	[/^extensions\/mcp\//, "MCP"],
	[/^extensions\/codemode\//, "codemode"],
	[/^core\/worktree-snapshot\//, "worktree snapshots"],
	[/^core\/storage\/|^core\/session-|^cli\/storage-/, "session storage"],
	[/^cli\/intercom-|^core\/intercom-/, "intercom"],
	[/^core\/structured-output\//, "structured output"],
];

/** @param {string} path in `dist` */
export function gatedFeature(path) {
	return FEATURES.find(([pattern]) => pattern.test(path))?.[1] ?? "this feature";
}

/** Names `export const { ... }` can bind. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * The gate written at `path` (in `dist`), an earlier release's path of a module whose code this build has at `code`
 * (relative to `path`), with the module's `exports`: when that code cannot load in a process whose release (asked of
 * the files `probes`, in `dist`) is not `version`, it says to restart.
 *
 * @param {{ path: string, code: string, exports: readonly string[], probes: readonly string[], version: string }} gate
 */
export function gateSource({ path, code, exports, probes, version }) {
	const depth = path.split("/").length - 1;
	const root = depth === 0 ? "./" : "../".repeat(depth);
	const named = exports.filter((name) => name !== "default");
	const unbindable = named.filter((name) => !IDENTIFIER.test(name));
	if (unbindable.length > 0) throw new Error(`in-place update gates: ${path} exports names a gate cannot bind: ${unbindable.join(", ")}`);
	const restart = ` was updated to ${version} while this session was running; restart it to keep using ${gatedFeature(moduleOfPath(path))}.`;
	return [
		`${GATE_FILE_MARK}: when this module's code cannot load in a process of an earlier release`,
		"// that an in-place update left running, the process is told to restart.",
		"let module;",
		"try {",
		`	module = await import(${codeStringLiteral(code)});`,
		"} catch (error) {",
		`	const root = new URL(${codeStringLiteral(root)}, import.meta.url);`,
		...runningReleaseSource("\t", probes, version),
		`	if (running === undefined || running.version === ${codeStringLiteral(version)}) throw error;`,
		`	throw new Error((typeof running.name === "string" ? running.name : "atomic") + ${codeStringLiteral(restart)}, {`,
		"\t\tcause: error,",
		"\t});",
		"}",
		...(named.length > 0 ? [`export const { ${named.join(", ")} } = module;`] : []),
		...(exports.includes("default") ? ["export default module.default;"] : []),
		"",
	].join("\n");
}

/**
 * The file this build writes at `path` (in `dist`), a later release's path of a module whose code this build has at
 * `code` (relative to `path`): it gives the module's `exports`. A process of that release guards its own import of it.
 *
 * @param {{ code: string, exports: readonly string[] }} alias
 */
export function aliasSource({ code, exports }) {
	return [
		`${GATE_FILE_MARK}: a later release's path of this module.`,
		...(exports.some((name) => name !== "default") ? [`export * from ${codeStringLiteral(code)};`] : []),
		...(exports.includes("default") ? [`export { default } from ${codeStringLiteral(code)};`] : []),
		"",
	].join("\n");
}

/** The stub at a recorded release's module path that this build does not write: it exports nothing. */
export const RELEASE_MODULE_STUB = `${GATE_FILE_MARK}: a process of the release that had a module here holds that\n// module; any other gets this empty one.\nexport {};\n`;
