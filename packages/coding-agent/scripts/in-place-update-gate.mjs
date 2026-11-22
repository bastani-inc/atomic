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

/** The first line of each gate and stub, by which a later split knows it as a split's output, not compiled code. */
export const GATE_FILE_MARK = "// Written by the build (scripts/in-place-update-gate.mjs)";

/** The file next to a gated module's path that holds its code. */
export const gatedImplementation = (path) => path.replace(/\.js$/, ".impl.js");

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
 * The gate written at `path` (in `dist`) for the module whose code is at {@link gatedImplementation}`(path)`, with the
 * module's `exports`: when that code cannot load in a process whose release (asked of the files `probes`, in `dist`)
 * is not `version`, it says to restart.
 *
 * @param {{ path: string, exports: readonly string[], probes: readonly string[], version: string }} gate
 */
export function gateSource({ path, exports, probes, version }) {
	const depth = path.split("/").length - 1;
	const root = depth === 0 ? "./" : "../".repeat(depth);
	const implementation = `./${gatedImplementation(path.slice(path.lastIndexOf("/") + 1))}`;
	const named = exports.filter((name) => name !== "default");
	const unbindable = named.filter((name) => !IDENTIFIER.test(name));
	if (unbindable.length > 0) throw new Error(`in-place update gates: ${path} exports names a gate cannot bind: ${unbindable.join(", ")}`);
	const restart = ` was updated to ${version} while this session was running; restart it to keep using ${gatedFeature(path)}.`;
	return [
		`${GATE_FILE_MARK}: when this module's code cannot load in a process of an earlier release`,
		"// that an in-place update left running, the process is told to restart.",
		"let module;",
		"try {",
		`	module = await import(${JSON.stringify(implementation)});`,
		"} catch (error) {",
		`	const root = new URL(${JSON.stringify(root)}, import.meta.url);`,
		'	const releases = (globalThis[Symbol.for("atomic.in-place-update-release.v1")] ??= new Map());',
		`	const key = \`\${root.href}#${version}\`;`,
		"	let release = releases.get(key);",
		"	if (release === undefined) {",
		"		release = (async () => {",
		`			for (const path of ${JSON.stringify(probes)}) {`,
		"				try {",
		"					const held = await import(new URL(path, root).href);",
		'					if (typeof held.VERSION === "string") return { version: held.VERSION, name: held.APP_NAME };',
		"				} catch {",
		"					// Not a file this process can load: the next.",
		"				}",
		"			}",
		"			return undefined;",
		"		})();",
		"		releases.set(key, release);",
		"	}",
		"	const running = await release;",
		`	if (running === undefined || running.version === ${JSON.stringify(version)}) throw error;`,
		`	throw new Error((typeof running.name === "string" ? running.name : "atomic") + ${JSON.stringify(restart)}, {`,
		"		cause: error,",
		"	});",
		"}",
		...(named.length > 0 ? [`export const { ${named.join(", ")} } = module;`] : []),
		...(exports.includes("default") ? ["export default module.default;"] : []),
		"",
	].join("\n");
}

/** The stub at a recorded release's module path that this build does not write: it exports nothing. */
export const RELEASE_MODULE_STUB = `${GATE_FILE_MARK}: a process of the release that had a module here holds that\n// module; any other gets this empty one.\nexport {};\n`;
