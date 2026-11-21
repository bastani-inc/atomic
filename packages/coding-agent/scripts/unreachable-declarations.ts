// Leaves the declaration files that no exported entry point's types reach out of the package.
//
// tsc emits a .d.ts (and .d.ts.map) for every source module, about 1,200 of them. npm unpacks
// @bastani/atomic file by file before it installs anything else, and on Windows antivirus software
// scans each file as it is written, so every published file adds to the install. Types that the
// package's exports do not reach cannot be imported through the exports map. The files stay in dist,
// where incremental builds expect them, and dist/.npmignore keeps them out of the package.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

interface PackageManifest {
	readonly types?: string;
	readonly exports?: ExportTarget;
}

type ExportTarget = string | null | { readonly [condition: string]: ExportTarget };

type SyntaxValue = SyntaxNode | SyntaxValue[] | string | number | boolean | null | undefined;

interface SyntaxNode {
	readonly type?: string;
	readonly [key: string]: SyntaxValue;
}

const REFERENCE = /^\/\s*<reference\b([^>]*)>/i;
const REFERENCE_ATTRIBUTE = /\b(path|types)\s*=\s*["']([^"']+)["']/gi;

/**
 * The declaration files TypeScript can resolve for a package manifest: its top-level `types`, every
 * exports `types` condition, and the declaration beside every other exported JavaScript target.
 */
export function exportedDeclarationRoots(packageJson: PackageManifest): { declared: string[]; beside: string[] } {
	const declared = new Set<string>();
	const beside = new Set<string>();
	if (typeof packageJson.types === "string") declared.add(packageJson.types);
	const visit = (target: ExportTarget | undefined, condition: string | undefined): void => {
		if (typeof target === "string") {
			if (condition === "types" || condition?.startsWith("types@") || /\.d\.[cm]?ts$/.test(target)) {
				declared.add(target);
			} else if (/\.[cm]?js$/.test(target)) beside.add(target.replace(/\.([cm]?)js$/, ".d.$1ts"));
			return;
		}
		if (target === null || typeof target !== "object") return;
		for (const [key, value] of Object.entries(target)) visit(value, key.startsWith(".") ? condition : key);
	};
	visit(packageJson.exports, undefined);
	return { declared: [...declared], beside: [...beside] };
}

/** The declaration file a relative specifier in `importer` names. */
function resolveDeclaration(importer: string, specifier: string): string {
	const target = resolve(dirname(importer), specifier);
	const flavor = /\.[cm][jt]s$/.exec(target)?.[0].slice(1, 2) ?? "";
	const base = target.replace(/\.d\.[cm]?ts$|\.[cm]?[jt]s$/, "");
	const candidate = [`${base}.d.${flavor}ts`, `${base}.d.ts`, join(base, "index.d.ts")].find((path) => existsSync(path));
	if (candidate === undefined) {
		throw new Error(`${importer} references ${specifier}, which has no declaration file`);
	}
	return candidate;
}

function stringValue(node: SyntaxValue): string | undefined {
	if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
	return node.type === "StringLiteral" && typeof node.value === "string" ? node.value : undefined;
}

/**
 * Declaration files a declaration file refers to: imports, re-exports, `import()` types,
 * `import x = require()`, `declare module` of a relative path and `/// <reference>` paths.
 */
export function declarationReferences(path: string): string[] {
	const program = parse(readFileSync(path, "utf8"), {
		sourceType: "module",
		plugins: [["typescript", { dts: true }]],
	});
	const specifiers = new Set<string>();
	for (const comment of program.comments ?? []) {
		const attributes = comment.type === "CommentLine" ? REFERENCE.exec(comment.value.trim())?.[1] : undefined;
		for (const [, kind, value] of attributes?.matchAll(REFERENCE_ATTRIBUTE) ?? []) {
			// A `types` reference names a package unless it is a relative path.
			if (value && (kind?.toLowerCase() === "path" || value.startsWith("."))) specifiers.add(value);
		}
	}
	const visit = (node: SyntaxValue): void => {
		if (Array.isArray(node)) {
			for (const child of node) visit(child);
			return;
		}
		if (node === null || typeof node !== "object") return;
		let specifier: string | undefined;
		switch (node.type) {
			case "ImportDeclaration":
			case "ExportNamedDeclaration":
			case "ExportAllDeclaration":
				specifier = stringValue(node.source);
				break;
			case "TSImportType":
				specifier = stringValue(node.source) ?? stringValue(node.argument);
				break;
			case "TSExternalModuleReference":
				specifier = stringValue(node.expression);
				break;
			case "TSModuleDeclaration":
				specifier = stringValue(node.id);
				break;
		}
		if (specifier?.startsWith(".")) specifiers.add(specifier);
		for (const [key, child] of Object.entries(node)) {
			if (key !== "loc" && key !== "extra" && key !== "comments") visit(child);
		}
	};
	visit(program.program as object as SyntaxNode);
	return [...specifiers].map((specifier) => resolveDeclaration(path, specifier));
}

/** Every declaration file reachable from `roots`, as absolute paths. */
export function declarationClosure(roots: readonly string[]): Set<string> {
	const reached = new Set<string>();
	const pending = [...roots];
	while (pending.length > 0) {
		const path = pending.pop();
		if (path === undefined || reached.has(path)) continue;
		reached.add(path);
		pending.push(...declarationReferences(path));
	}
	return reached;
}

function declarationFiles(directory: string, skip: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return path === skip ? [] : declarationFiles(path, skip);
		return /\.d\.[cm]?ts$/.test(entry.name) ? [path] : [];
	});
}

/**
 * The .d.ts files under `packageDir`/dist that the exported types do not reach, relative to dist. The
 * builtin packages under dist/builtin ship their own sources and are left alone.
 */
export function unreachableDeclarations(packageDir: string): { kept: number; unreachable: string[] } {
	const packageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as PackageManifest;
	const { declared, beside } = exportedDeclarationRoots(packageJson);
	const missing = declared.filter((root) => !existsSync(resolve(packageDir, root)));
	if (missing.length > 0) throw new Error(`Exported declarations are missing: ${missing.join(", ")}`);
	const roots = [...declared, ...beside.filter((root) => existsSync(resolve(packageDir, root)))].map((root) =>
		resolve(packageDir, root),
	);
	const kept = declarationClosure(roots);
	const dist = join(packageDir, "dist");
	const unreachable = declarationFiles(dist, join(dist, "builtin"))
		.filter((path) => !kept.has(path))
		.map((path) => relative(dist, path).split(sep).join("/"))
		.sort();
	return { kept: kept.size, unreachable };
}

/** Writes dist/.npmignore so `npm pack` leaves the unreachable declarations and their maps out. */
export function excludeUnreachableDeclarations(packageDir: string): { kept: number; excluded: number } {
	const { kept, unreachable } = unreachableDeclarations(packageDir);
	const lines = unreachable.flatMap((path) => [`/${path}`, `/${path}.map`]);
	writeFileSync(
		join(packageDir, "dist", ".npmignore"),
		["# Declarations that no exported entry point reaches (scripts/unreachable-declarations.ts).", ...lines, ""].join(
			"\n",
		),
	);
	return { kept, excluded: unreachable.length };
}

if (import.meta.main) {
	const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const { kept, excluded } = excludeUnreachableDeclarations(packageDir);
	console.log(`Packing ${kept} declaration files the exports reach; leaving out ${excluded} through dist/.npmignore`);
}
