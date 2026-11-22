#!/usr/bin/env node
// What a process of an earlier release needs from the files an in-place update (`npm install -g`, `bun add -g`) puts
// in its place, and whether a build gives it.
//
// A process keeps every module it has loaded and loads the rest from the installation on disk. After an update, it
// loads the new release's files, which link against the copies of the earlier release it already holds, and the code
// of the earlier release it holds imports the new release's files when it first needs them. Both work only when:
//
// - a file of the new release that such a process loads names, by `import { name }` or `export { name } from`, only
//   exports the earlier release's copies it may hold at the same paths had; and Atomic's own packages it names resolve,
//   through the exports maps the process read once, to a file the new release has, outside any directory of the earlier
//   release that lacked it (Bun reads each directory once);
// - every file the earlier release imports on demand (`import()` of a literal path) or starts as a worker
//   (`new URL()` of a path) is still there, with at least the exports it had.
//
// `record` writes a release's record: for the application and the packages of its own it depends on, each package's
// exports map, each JavaScript file's export names, the files its code loads on demand, the files the CLI loads at start
// and the files every running process has loaded. `check` lists what a build breaks for a process of each recorded
// release, and `release` does it for a packed release in the release workflow, which also fails when the latest release
// published before it is not recorded: the build's gates recognize a process of a recorded release only
// (`packages/coding-agent/scripts/in-place-update-gate.mjs`). `packages/coding-agent/in-place-update/` holds the records
// (see its README.md).
//
// Usage:
//   node scripts/in-place-update-exports.mjs record <package-dir>...       (prints the record; the application first)
//   node scripts/in-place-update-exports.mjs record --published <version>  (of the release npm has)
//   node scripts/in-place-update-exports.mjs check <records-dir> <package-dir>...
//   node scripts/in-place-update-exports.mjs release <version> <records-dir> <tarball-dir>
//
// A package directory is an installed or unpacked package (its package.json and the files it publishes), or a workspace
// package after `npm run build`. The builtin extensions' bundles (`dist/builtin/`) are left out: the extension loader
// links them against the running process's own modules, not files (`test/unit/in-place-update-imports.test.ts`).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "acorn";
import { ancestor } from "acorn-walk";
import semver from "semver";

/** A file's export names when one of its `export *` comes from a module outside Atomic's packages: any name. */
const ANY = "*";
const JAVASCRIPT = /\.(?:m?js)$/;
/** Directories a package's runtime never loads from: bundler-only module copies, and installed dependencies. */
const SKIPPED_DIRECTORIES = new Set(["node_modules", "_modules"]);

/**
 * The JavaScript files of the package in `directory` that npm publishes (the directories and files its `files` field
 * names, or all of it), `/`-separated, but for the builtin extensions' bundles.
 * @param {string} directory @param {unknown} published @returns {string[]}
 */
function javascriptFiles(directory, published) {
	const roots = Array.isArray(published)
		? published
				.filter((entry) => typeof entry === "string" && !entry.startsWith("!"))
				.map((entry) => entry.replace(/\/\*\*(?:\/\*)?$/, "").replace(/^\.\//, ""))
				.filter((entry) => !/[*?[\]{}]/.test(entry))
		: [""];
	const files = new Set();
	const visit = (path) => {
		const full = join(directory, path);
		if (!existsSync(full)) return;
		if (!statSync(full).isDirectory()) {
			if (JAVASCRIPT.test(path)) files.add(path);
			return;
		}
		for (const entry of readdirSync(full, { withFileTypes: true })) {
			if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
			const child = path === "" ? entry.name : `${path}/${entry.name}`;
			if (child === "dist/builtin") continue;
			visit(child);
		}
	};
	for (const root of roots) visit(root);
	return [...files].sort();
}

/**
 * @typedef {{ specifier: string, names: string[] }} StaticImport
 * @typedef {{ exports: string[], stars: string[], imports: StaticImport[], lazy: string[], workers: string[] }} ModuleSyntax
 */

/** @param {import("acorn").Node | null | undefined} node @returns {string} */
function moduleName(node) {
	return node?.type === "Identifier" ? node.name : String(node?.value);
}

/** @param {import("acorn").Node} pattern @returns {string[]} the names a declaration's binding pattern declares */
function boundNames(pattern) {
	switch (pattern.type) {
		case "Identifier":
			return [pattern.name];
		case "ObjectPattern":
			return pattern.properties.flatMap((property) =>
				boundNames(property.type === "RestElement" ? property.argument : property.value),
			);
		case "ArrayPattern":
			return pattern.elements.flatMap((element) => (element === null ? [] : boundNames(element)));
		case "RestElement":
			return boundNames(pattern.argument);
		case "AssignmentPattern":
			return boundNames(pattern.left);
		default:
			return [];
	}
}

/** @param {string} source @returns {ModuleSyntax} */
export function moduleSyntax(source) {
	const program = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
	/** @type {ModuleSyntax} */
	const syntax = { exports: [], stars: [], imports: [], lazy: [], workers: [] };
	for (const node of program.body) {
		if (node.type === "ImportDeclaration") {
			const names = node.specifiers.flatMap((specifier) =>
				specifier.type === "ImportSpecifier"
					? [moduleName(specifier.imported)]
					: specifier.type === "ImportDefaultSpecifier"
						? ["default"]
						: [],
			);
			syntax.imports.push({ specifier: String(node.source.value), names });
		} else if (node.type === "ExportNamedDeclaration") {
			if (node.declaration?.type === "VariableDeclaration")
				syntax.exports.push(...node.declaration.declarations.flatMap((declarator) => boundNames(declarator.id)));
			else if (node.declaration) syntax.exports.push(moduleName(node.declaration.id));
			for (const specifier of node.specifiers) syntax.exports.push(moduleName(specifier.exported));
			if (node.source)
				syntax.imports.push({
					specifier: String(node.source.value),
					names: node.specifiers.map((specifier) => moduleName(specifier.local)),
				});
		} else if (node.type === "ExportDefaultDeclaration") {
			syntax.exports.push("default");
		} else if (node.type === "ExportAllDeclaration") {
			if (node.exported) syntax.exports.push(moduleName(node.exported));
			else syntax.stars.push(String(node.source.value));
			syntax.imports.push({ specifier: String(node.source.value), names: [] });
		}
	}
	ancestor(program, {
		ImportExpression(node) {
			if (node.source.type === "Literal" && typeof node.source.value === "string")
				syntax.lazy.push(node.source.value);
		},
		NewExpression(node, _state, ancestors) {
			// `new URL("./worker.js", import.meta.url)`: a module that runs by its path, in a thread or process of its own.
			// Its `.href` alone is a bundled module's own URL, which the bundle keeps for it and which loads nothing.
			const [target, base] = node.arguments;
			const parent = ancestors.at(-2);
			if (
				node.callee.type === "Identifier" &&
				node.callee.name === "URL" &&
				target?.type === "Literal" &&
				typeof target.value === "string" &&
				JAVASCRIPT.test(target.value) &&
				base?.type === "MemberExpression" &&
				base.object.type === "MetaProperty" &&
				moduleName(base.property) === "url" &&
				!(parent?.type === "MemberExpression" && parent.object === node && moduleName(parent.property) === "href")
			)
				syntax.workers.push(target.value);
		},
	});
	return syntax;
}

/**
 * @typedef {{ version: string, exports: Record<string, string> | null, main: string | null,
 *   files: Record<string, string[]>, lazy: Record<string, string[]>, workers: Record<string, string[]>,
 *   startup: string[], running: string[] }} PackageRecord
 * @typedef {{ version: string, packages: Record<string, PackageRecord> }} ReleaseRecord
 * @typedef {{ name: string, version: string, exports: Record<string, string> | null, main: string | null,
 *   bin: string[], syntax: Map<string, ModuleSyntax> }} LoadedPackage
 * @typedef {{ exports: Record<string, string> | null, main: string | null, files: Record<string, unknown> }} Resolvable
 */

/**
 * A package's `exports` map as Node reads it for an `import`: each key and the file its `import` condition (else
 * `node`, else `default`) names; `null` for a package without one.
 * @returns {Record<string, string> | null}
 */
function importExports(manifest) {
	const { exports } = manifest;
	if (exports === undefined) return null;
	const pick = (target) => {
		if (typeof target === "string") return target;
		if (target === null || typeof target !== "object" || Array.isArray(target)) return undefined;
		for (const condition of ["import", "node", "default"]) {
			const picked = pick(target[condition]);
			if (picked !== undefined) return picked;
		}
		return undefined;
	};
	const map =
		typeof exports === "string" || !Object.keys(exports).some((key) => key.startsWith("."))
			? { ".": exports }
			: exports;
	/** @type {Record<string, string>} */
	const result = {};
	for (const [key, target] of Object.entries(map)) {
		const file = pick(target);
		if (file !== undefined) result[key] = file.replace(/^\.\//, "");
	}
	return result;
}

/** @param {string} dir @returns {LoadedPackage} */
function loadPackage(dir) {
	const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	const syntax = new Map();
	for (const file of javascriptFiles(dir, manifest.files)) {
		try {
			syntax.set(file, moduleSyntax(readFileSync(join(dir, file), "utf8")));
		} catch {
			// Not an ES module (a CommonJS helper or a script): nothing links against its exports by name.
		}
	}
	const bin = typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {});
	return {
		name: manifest.name,
		version: manifest.version,
		exports: importExports(manifest),
		main: typeof manifest.main === "string" ? manifest.main.replace(/^\.\//, "") : null,
		bin: bin.map((path) => String(path).replace(/^\.\//, "")),
		syntax,
	};
}

/** The file `subpath` (`""` for the package itself) of `pkg` resolves to, or `null` when the package does not export it. */
function resolveSubpath(pkg, subpath) {
	if (pkg.exports === null) {
		if (subpath === "") return pkg.main ?? "index.js";
		const path = subpath.slice(1);
		return path in pkg.files || !(`${path}.js` in pkg.files) ? path : `${path}.js`;
	}
	const key = subpath === "" ? "." : `.${subpath}`;
	if (key in pkg.exports) return pkg.exports[key];
	for (const [pattern, target] of Object.entries(pkg.exports)) {
		if (!pattern.includes("*")) continue;
		const [before, after] = pattern.split("*");
		if (!key.startsWith(before) || !key.endsWith(after) || key.length < before.length + after.length) continue;
		return target.replaceAll("*", key.slice(before.length, key.length - after.length));
	}
	return null;
}

/** Splits a bare specifier into its package name and subpath (`""`, or `/…`). */
function splitSpecifier(specifier) {
	const parts = specifier.split("/");
	const length = specifier.startsWith("@") ? 2 : 1;
	return {
		name: parts.slice(0, length).join("/"),
		subpath: parts.length > length ? `/${parts.slice(length).join("/")}` : "",
	};
}

const isRelative = (specifier) => specifier.startsWith("./") || specifier.startsWith("../");

/**
 * Where `specifier`, imported by `from` in package `name`, leads: a file of the same package for a relative specifier,
 * else through the exports map of one of `packages` (`path` null when that map does not export it); undefined for a
 * package outside them.
 * @param {Map<string, Resolvable>} packages
 * @returns {{ name: string, path: string | null } | undefined}
 */
function resolveImport(specifier, from, name, packages) {
	if (isRelative(specifier)) return { name, path: posix.normalize(posix.join(posix.dirname(from), specifier)) };
	const split = splitSpecifier(specifier);
	const target = packages.get(split.name);
	return target === undefined ? undefined : { name: split.name, path: resolveSubpath(target, split.subpath) };
}

/** Each package's files' export names, following `export *` through the packages. */
function exportNames(packages) {
	/** @type {Map<string, Set<string>>} */
	const done = new Map();
	const visiting = new Set();
	const resolvable = new Map(
		[...packages].map(([name, pkg]) => [
			name,
			{
				exports: pkg.exports,
				main: pkg.main,
				files: Object.fromEntries([...pkg.syntax.keys()].map((file) => [file, true])),
			},
		]),
	);
	const namesOf = (name, path) => {
		const key = `${name}:${path}`;
		const known = done.get(key);
		if (known) return known;
		const syntax = packages.get(name)?.syntax.get(path);
		if (syntax === undefined || visiting.has(key)) return new Set();
		visiting.add(key);
		const names = new Set(syntax.exports);
		for (const star of syntax.stars) {
			const target = resolveImport(star, path, name, resolvable);
			if (target?.path == null || !packages.get(target.name)?.syntax.has(target.path)) names.add(ANY);
			else for (const starName of namesOf(target.name, target.path)) if (starName !== "default") names.add(starName);
		}
		visiting.delete(key);
		done.set(key, names);
		return names;
	};
	return new Map(
		[...packages].map(([name, pkg]) => [
			name,
			Object.fromEntries([...pkg.syntax.keys()].map((path) => [path, [...namesOf(name, path)].sort()])),
		]),
	);
}

/**
 * The files a process loads from `roots` on: their static imports and, with `dynamic`, their imports of a literal path,
 * transitively, but for the files in `held`, which the process has loaded already. A worker's `new URL()` starts a
 * thread or process of its own, which loads every file afresh.
 * @param {Map<string, LoadedPackage>} packages @param {Map<string, Resolvable>} resolvable
 * @param {{ name: string, path: string }[]} roots @param {boolean} dynamic @param {Set<string>} [held]
 * @returns {Set<string>} `name:path` keys
 */
function reachable(packages, resolvable, roots, dynamic, held = new Set()) {
	const seen = new Set();
	const queue = [...roots];
	for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
		const key = `${next.name}:${next.path}`;
		if (seen.has(key) || held.has(key)) continue;
		const syntax = packages.get(next.name)?.syntax.get(next.path);
		if (syntax === undefined) continue;
		seen.add(key);
		for (const specifier of [...syntax.imports.map((entry) => entry.specifier), ...(dynamic ? syntax.lazy : [])]) {
			const target = resolveImport(specifier, next.path, next.name, resolvable);
			if (target?.path) queue.push({ name: target.name, path: target.path });
		}
	}
	return seen;
}

/** @param {string[]} dirs */
function loadPackages(dirs) {
	return new Map(dirs.map((dir) => loadPackage(dir)).map((pkg) => [pkg.name, pkg]));
}

/** @param {Map<string, LoadedPackage>} packages @param {Map<string, Record<string, string[]>>} names */
function resolvableOf(packages, names) {
	return new Map(
		[...packages].map(([name, pkg]) => [name, { exports: pkg.exports, main: pkg.main, files: names.get(name) }]),
	);
}

/**
 * The record of the release whose packages are in `dirs`, the application (the package whose `bin` starts a process)
 * first and the packages it depends on after it.
 * @param {string[]} dirs @returns {ReleaseRecord}
 */
export function recordRelease(dirs) {
	const packages = loadPackages(dirs);
	const names = exportNames(packages);
	const resolvable = resolvableOf(packages, names);
	const application = packages.values().next().value;
	const entry = (path) => ({ name: application.name, path });
	// What the application's CLI has loaded before it loads anything on demand: its bin's static imports.
	const startup = reachable(packages, resolvable, (application?.bin ?? []).map(entry), false);
	// What every running process has loaded: an SDK program imports the package, and a session's extension loader
	// imports it to hand its modules to extensions; both with its static imports.
	const running = application?.exports?.["."]
		? reachable(packages, resolvable, [entry(application.exports["."])], false)
		: new Set();
	// What a process can load at all: from the CLI, and from every package's exports.
	const loadable = reachable(
		packages,
		resolvable,
		[
			...(application?.bin ?? []).map((path) => ({ name: application.name, path })),
			...[...packages].flatMap(([name, pkg]) => Object.values(pkg.exports ?? {}).map((path) => ({ name, path }))),
		],
		true,
	);
	/** @type {ReleaseRecord} */
	const release = { version: application?.version ?? "", packages: {} };
	for (const [name, pkg] of packages) {
		/** @type {Record<string, string[]>} */
		const lazy = {};
		/** @type {Record<string, string[]>} */
		const workers = {};
		for (const [path, syntax] of pkg.syntax) {
			if (!loadable.has(`${name}:${path}`)) continue;
			for (const [kind, list] of [
				[lazy, syntax.lazy],
				[workers, syntax.workers],
			])
				for (const specifier of list) {
					const target = resolveImport(specifier, path, name, resolvable);
					// Only a file the release ships: the split names each bundled module's removed compiled file in a
					// `new URL()` that only stands for the module's own URL, and loads nothing.
					if (!target?.path || resolvable.get(target.name)?.files[target.path] === undefined) continue;
					const key = `${target.name}:${target.path}`;
					kind[key] = [...(kind[key] ?? []), path];
				}
		}
		const sorted = (record) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
		release.packages[name] = {
			version: pkg.version,
			exports: pkg.exports,
			main: pkg.main,
			files: names.get(name),
			lazy: sorted(lazy),
			workers: sorted(workers),
			startup: pathsOf(startup, name),
			running: pathsOf(running, name),
		};
	}
	return release;
}

/** The paths of package `name` among `keys`. */
function pathsOf(keys, name) {
	return [...keys]
		.filter((key) => splitKey(key).name === name)
		.map((key) => splitKey(key).path)
		.sort();
}

/** `record` as JSON, each list of names on one line. */
export function formatRecord(record) {
	return `${JSON.stringify(record, null, "\t").replace(
		/\[\n\s+("(?:[^"\\]|\\.)*"(?:,\n\s+"(?:[^"\\]|\\.)*")*)\n\s+\]/g,
		(_, items) => `[${items.split(/,\n\s+/).join(", ")}]`,
	)}\n`;
}

/** The names among `names` that `exported` lacks (none, when an `export *` comes from outside the packages). */
function lacking(exported, names) {
	return exported.includes(ANY) ? [] : names.filter((name) => !exported.includes(name));
}

/** `name:path` split at the colon before the path. */
function splitKey(key) {
	const at = key.indexOf(":", key.startsWith("@") ? key.indexOf("/") : 0);
	return { name: key.slice(0, at), path: key.slice(at + 1) };
}

/**
 * What the build in `dirs` breaks for a process of the `earlier` release when an in-place update replaces it with this
 * build. Two processes are considered:
 *
 * - one that was starting: it holds its CLI's static imports (`startup`) and the `package.json` files they read, and
 *   loads what they import lazily;
 * - one that runs: it holds what every running process holds (`running`: the package's main entry, which an SDK
 *   program imports and a session's extension loader imports for its extensions, with its static imports), may hold
 *   any other file of the earlier release, and has read every `package.json`; it loads what its code imports lazily,
 *   and a program may import anything the packages export.
 *
 * Each loads the files of this build reachable from there, which must link against the earlier copies it may hold.
 * `allowed` names the bare specifiers this build may import although the earlier release's exports map lacks them, each
 * with the reason no process of that release meets them.
 * @param {ReleaseRecord} earlier @param {string[]} dirs @param {Record<string, string>} [allowed]
 * @returns {string[]}
 */
export function checkRelease(earlier, dirs, allowed = {}) {
	const packages = loadPackages(dirs);
	const current = resolvableOf(packages, exportNames(packages));
	const before = new Map(Object.entries(earlier.packages));
	const at = earlier.version;
	const problems = new Set();
	const keysOf = (field) =>
		new Set([...before].flatMap(([name, record]) => (record[field] ?? []).map((path) => `${name}:${path}`)));
	const startup = keysOf("startup");
	const running = keysOf("running");
	const bins = new Set([...packages.values()].flatMap((pkg) => pkg.bin.map((path) => `${pkg.name}:${path}`)));
	const lazyTargets = (importedBy) =>
		[...before].flatMap(([name, record]) =>
			Object.entries(record.lazy)
				.filter(([, importers]) => importers.some((importer) => importedBy(`${name}:${importer}`)))
				.map(([key]) => splitKey(key)),
		);
	const earlierFile = (key) => {
		const { name, path } = splitKey(key);
		return before.get(name)?.files[path];
	};
	const views = [
		{
			held: startup,
			mayHold: (key) => startup.has(key),
			readManifest: new Set([...startup].map((key) => splitKey(key).name)),
			roots: lazyTargets((importer) => startup.has(importer)),
		},
		{
			held: running,
			mayHold: (key) => earlierFile(key) !== undefined,
			readManifest: new Set(before.keys()),
			roots: [
				...lazyTargets((importer) => !bins.has(importer)),
				...[...before].flatMap(([name, record]) =>
					Object.values(record.exports ?? {}).map((path) => ({ name, path })),
				),
			],
		},
	];
	const directories = new Map(
		[...before].map(([name, record]) => [
			name,
			new Set(Object.keys(record.files).map((file) => posix.dirname(file))),
		]),
	);
	for (const view of views) {
		// A package resolves through the earlier release's exports map once the process has read its package.json.
		const resolvable = new Map(
			[...current].map(([name, pkg]) => [name, view.readManifest.has(name) ? (before.get(name) ?? pkg) : pkg]),
		);
		for (const key of reachable(packages, resolvable, view.roots, true, view.held)) {
			const { name, path } = splitKey(key);
			const syntax = packages.get(name).syntax.get(path);
			for (const { specifier, names } of [
				...syntax.imports,
				...syntax.lazy.map((specifier) => ({ specifier, names: [] })),
			]) {
				const target = resolveImport(specifier, path, name, resolvable);
				if (target === undefined) continue;
				if (target.path === null) {
					if (!(specifier in allowed))
						problems.add(`${name}/${path} imports ${specifier}, which ${at} does not export`);
					continue;
				}
				const targetKey = `${target.name}:${target.path}`;
				if (!isRelative(specifier) && view.readManifest.has(target.name) && before.has(target.name)) {
					if (current.get(target.name)?.files[target.path] === undefined) {
						problems.add(
							`${name}/${path} imports ${specifier}, which ${at} resolves to ${target.path}: this build lacks it`,
						);
						continue;
					}
					if (
						earlierFile(targetKey) === undefined &&
						directories.get(target.name)?.has(posix.dirname(target.path))
					)
						problems.add(`${name}/${path} imports ${specifier}: ${target.path} is new in a directory ${at} had`);
				}
				const exported = view.mayHold(targetKey) ? earlierFile(targetKey) : undefined;
				const missing = exported === undefined ? [] : lacking(exported, names);
				if (missing.length > 0)
					problems.add(
						`${name}/${path} imports ${missing.join(", ")} from ${target.name}/${target.path}, which ${at}'s copy lacks`,
					);
			}
		}
	}
	// What the earlier release's own code loads on demand is still there, with what it exported.
	for (const [name, record] of before)
		for (const [verb, references] of [
			["imports", record.lazy],
			["starts", record.workers],
		])
			for (const [key, importers] of Object.entries(references)) {
				const target = splitKey(key);
				const now = current.get(target.name)?.files[target.path];
				// What the earlier release did not ship, its process cannot have loaded from it either.
				if (!current.has(target.name) || earlierFile(key) === undefined) continue;
				if (now === undefined) {
					problems.add(
						`${at}'s ${name}/${importers[0]} ${verb} ${target.name}/${target.path}: this build lacks it`,
					);
					continue;
				}
				if (verb !== "imports") continue;
				const missing = lacking(
					now,
					(earlierFile(key) ?? []).filter((exported) => exported !== ANY),
				);
				if (missing.length > 0)
					problems.add(
						`${at}'s ${name}/${importers[0]} imports ${target.name}/${target.path}, which no longer exports ${missing.join(", ")}`,
					);
			}
	return [...problems].sort();
}

/** Atomic's packages a release record holds: the application first, then the packages of its own it depends on. */
const RECORDED_DEPENDENCIES = [
	"@bastani/atomic-ai",
	"@bastani/atomic-agent-core",
	"@bastani/atomic-tui",
	"@bastani/atomic-codemode",
	"@bastani/atomic-schema",
	"@bastani/atomic-telemetry",
];
const APPLICATION = "@bastani/atomic";

/**
 * Unpacks the tarball `file` into a new directory under `into`, from a copy there named without a directory (GNU tar,
 * which Git for Windows puts on PATH, takes `C:` in a path for a remote host), and returns the package's directory.
 */
function unpack(file, into) {
	const dir = mkdtempSync(join(into, "package-"));
	const copy = join(dir, basename(file));
	copyFileSync(file, copy);
	const result = spawnSync("tar", ["-xzf", basename(file)], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
	rmSync(copy, { force: true });
	if (result.status !== 0) throw new Error(`could not unpack ${file}: ${result.stderr}`);
	return join(dir, "package");
}

/**
 * The application's and its packages' directories, unpacked from the npm tarballs in `dir`, as `npm pack` names them
 * (`bastani-atomic-ai-<version>.tgz`); other tarballs there are left alone.
 */
function unpackRelease(dir, into) {
	const tarballs = readdirSync(dir).filter((file) => file.endsWith(".tgz"));
	return [APPLICATION, ...RECORDED_DEPENDENCIES].map((name) => {
		const prefix = name.slice(1).replace("/", "-");
		const tarball = tarballs.find(
			(file) => file.startsWith(`${prefix}-`) && /^\d/.test(file.slice(prefix.length + 1)),
		);
		if (tarball === undefined) throw new Error(`no tarball of ${name} in ${dir}`);
		return unpack(join(dir, tarball), into);
	});
}

/** Downloads release `version` of the application and the packages of its own it depends on, unpacked. */
function downloadRelease(version, into) {
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const tarballs = mkdtempSync(join(into, "tarballs-"));
	const pack = (spec) => {
		const result = spawnSync(npm, ["pack", spec, "--pack-destination", tarballs, "--silent"], {
			encoding: "utf8",
			shell: process.platform === "win32",
		});
		if (result.status !== 0) throw new Error(`npm pack ${spec} failed: ${result.stderr}`);
	};
	pack(`${APPLICATION}@${version}`);
	const application = unpack(join(tarballs, readdirSync(tarballs)[0]), into);
	const dependencies = JSON.parse(readFileSync(join(application, "package.json"), "utf8")).dependencies ?? {};
	for (const name of RECORDED_DEPENDENCIES) pack(`${name}@${dependencies[name] ?? version}`);
	return unpackRelease(tarballs, into);
}

/** The latest published release of the application before `version`, or undefined when there is none. */
function previousRelease(version) {
	const result = spawnSync(
		process.platform === "win32" ? "npm.cmd" : "npm",
		["view", APPLICATION, "versions", "--json"],
		{
			encoding: "utf8",
			shell: process.platform === "win32",
		},
	);
	if (result.status !== 0) throw new Error(`npm view ${APPLICATION} versions failed: ${result.stderr}`);
	const versions = /** @type {string[]} */ (JSON.parse(result.stdout));
	return versions
		.filter((published) => semver.lt(published, version))
		.sort(semver.compare)
		.at(-1);
}

/** The records in `dir` (`<version>.json`) and the specifiers `allowed.json` there allows, by release. */
function readRecords(dir) {
	const records = readdirSync(dir)
		.filter((file) => /^\d.*\.json$/.test(file))
		.map((file) => /** @type {ReleaseRecord} */ (JSON.parse(readFileSync(join(dir, file), "utf8"))));
	const allowedFile = join(dir, "allowed.json");
	const allowed = existsSync(allowedFile) ? JSON.parse(readFileSync(allowedFile, "utf8")) : {};
	return { records, allowed };
}

/** Prints what the build in `dirs` breaks for each of `records`; whether it breaks nothing. */
function report(records, allowed, dirs) {
	let ok = true;
	for (const record of records) {
		const problems = checkRelease(record, dirs, allowed[record.version] ?? {});
		for (const problem of problems) console.error(problem);
		if (problems.length > 0) ok = false;
		else console.log(`An in-place update from ${record.version} breaks nothing.`);
	}
	return ok;
}

function main(argv) {
	const [command, ...rest] = argv;
	const work = () => mkdtempSync(join(tmpdir(), "atomic-in-place-update-"));
	if (command === "record" && rest[0] === "--published" && rest.length === 2) {
		const into = work();
		try {
			process.stdout.write(formatRecord(recordRelease(downloadRelease(rest[1], into))));
		} finally {
			rmSync(into, { recursive: true, force: true });
		}
		return 0;
	}
	if (command === "record" && rest.length > 0) {
		process.stdout.write(formatRecord(recordRelease(rest)));
		return 0;
	}
	if (command === "check" && rest.length >= 2) {
		const { records, allowed } = readRecords(rest[0]);
		return report(records, allowed, rest.slice(1)) ? 0 : 1;
	}
	if (command === "release" && rest.length === 3) {
		// The release path: the packed release against every recorded release and the latest published one before it.
		const [version, recordsDir, tarballs] = rest;
		const into = work();
		try {
			const dirs = unpackRelease(tarballs, into);
			const { records, allowed } = readRecords(recordsDir);
			const previous = previousRelease(version);
			// The build tells a process of each recorded release to restart before it loads code on demand
			// (packages/coding-agent/scripts/in-place-update-gate.mjs); one of an unrecorded release it cannot recognize.
			if (previous !== undefined && !records.some((record) => record.version === previous)) {
				console.error(
					`${previous} is not recorded in ${recordsDir}: record it (node scripts/in-place-update-exports.mjs record --published ${previous}) and build again`,
				);
				return 1;
			}
			return report(records, allowed, dirs) ? 0 : 1;
		} finally {
			rmSync(into, { recursive: true, force: true });
		}
	}
	console.error(
		[
			"Usage:",
			"  in-place-update-exports.mjs record <package-dir>... | record --published <version>",
			"  in-place-update-exports.mjs check <records-dir> <package-dir>...",
			"  in-place-update-exports.mjs release <version> <records-dir> <tarball-dir>",
		].join("\n"),
	);
	return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
