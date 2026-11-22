import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, relative } from "node:path";
import { parse } from "@babel/parser";
import { test } from "vitest";
import atomicPackageJson from "../../packages/coding-agent/package.json" with { type: "json" };
import { codingAgentDependencyClosure } from "../helpers/coding-agent-dependency-closure.js";
import { npmSpawnPrefix, spawnSyncCollect } from "../helpers/runtime.js";

const DIST = "packages/coding-agent/dist";
const builtTest = existsSync(join(DIST, "index.js")) ? test : test.skip;
/** One `npm pack --dry-run` child lists the seven packages publish.yml packs from tsc output. */
const NPM_PACK_DRY_RUN_TIMEOUT_MS = 120_000;
const TSC_PACKAGE_DIRS = [
	"packages/coding-agent",
	"packages/ai",
	"packages/agent",
	"packages/codemode",
	"packages/schema",
	"packages/telemetry",
	"packages/tui",
] as const;

type SyntaxValue = SyntaxNode | SyntaxValue[] | string | number | boolean | null | undefined;
interface SyntaxNode {
	type?: string;
	[key: string]: SyntaxValue;
}

function stringLiteral(value: SyntaxValue): string | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value.type === "StringLiteral" && typeof value.value === "string" ? value.value : undefined;
}

function isNode(value: SyntaxValue): value is SyntaxNode {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `require(x)`, `require.resolve(x)` and `createRequire(...).resolve(x)` name a package to load. */
function isModuleLookup(callee: SyntaxValue): boolean {
	if (!isNode(callee)) return false;
	if (callee.type === "Identifier") return callee.name === "require";
	if (callee.type !== "MemberExpression" || !isNode(callee.property) || callee.property.name !== "resolve") {
		return false;
	}
	const target = callee.object;
	if (!isNode(target)) return false;
	return (
		(target.type === "Identifier" && target.name === "require") ||
		(target.type === "CallExpression" && isNode(target.callee) && target.callee.name === "createRequire")
	);
}

interface FileReferences {
	/** Specifiers named in an import, export, import type, require or resolve call. */
	readonly loads: Set<string>;
	/** Scoped package names in string literals, as handed to a require function under another name. */
	readonly strings: Set<string>;
}

function fileReferences(source: string, typescript: boolean, declaration: boolean): FileReferences {
	const specifiers = new Set<string>();
	const strings = new Set<string>();
	const visit = (value: SyntaxValue): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (value === null || typeof value !== "object") return;
		if (value.type === "StringLiteral" && typeof value.value === "string" && value.value.startsWith("@")) {
			strings.add(value.value);
		}
		let specifier: string | undefined;
		switch (value.type) {
			case "ImportDeclaration":
			case "ExportNamedDeclaration":
			case "ExportAllDeclaration":
			case "ImportExpression":
				specifier = stringLiteral(value.source);
				break;
			case "TSImportType":
				specifier = stringLiteral(value.source) ?? stringLiteral(value.argument);
				break;
			case "TSExternalModuleReference":
				specifier = stringLiteral(value.expression);
				break;
			case "CallExpression":
				if (isModuleLookup(value.callee) && Array.isArray(value.arguments)) {
					specifier = stringLiteral(value.arguments[0]);
				}
				break;
		}
		if (specifier !== undefined) specifiers.add(specifier);
		for (const [key, child] of Object.entries(value)) {
			if (key !== "loc" && key !== "extra" && key !== "comments") visit(child);
		}
	};
	const plugins = typescript ? [["typescript", { dts: declaration }] as ["typescript", { dts: boolean }]] : [];
	visit(parse(source, { sourceType: "module", plugins, errorRecovery: false }) as object as SyntaxNode);
	return { loads: specifiers, strings };
}

function packageName(specifier: string): string | undefined {
	if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#")) return undefined;
	if (/^[a-z]+:/i.test(specifier) || isBuiltin(specifier)) return undefined;
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

/**
 * Atomic's own published modules. Bundles that Bun builds (the builtin extensions and the codemode
 * worker) carry their dependencies inside; native-builtin-bundle-imports pins their imports to the host.
 */
function publishedSourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return publishedSourceFiles(path);
		if (entry.name.endsWith(".bundle.mjs") || entry.name === "codemode-worker.js") return [];
		return /\.(?:[cm]?js|[cm]?ts)$/.test(entry.name) ? [path] : [];
	});
}

/**
 * Dependencies the package bundles into its shared files and that no published file loads by name any more. They stay
 * declared for the release that stops shipping the compiled files that loaded them: a session that started on an
 * earlier version and is updated in place still imports them by name from the code it loaded, and an upgrade removes
 * every package the new version does not declare. Remove them from the dependencies in a later release.
 */
const KEPT_FOR_IN_PLACE_UPDATE = new Set([
	"brace-expansion",
	"cross-spawn",
	"diff",
	"fast-sha256",
	"hosted-git-info",
	"lovely-mermaid",
	"lru-cache",
	"semver",
	// Atomic's own code bundles it; markit-ai, which loaded it by name, is bundled now too.
	"turndown",
	"yaml",
]);

builtTest("@bastani/atomic depends on exactly the packages its published files load", () => {
	const loaded = new Map<string, string>();
	const named = new Set<string>();
	for (const file of publishedSourceFiles(DIST)) {
		const typescript = /\.[cm]?ts$/.test(file);
		const declaration = /\.d\.[cm]?ts$/.test(file);
		const references = fileReferences(readFileSync(file, "utf8"), typescript, declaration);
		for (const specifier of references.loads) {
			const name = packageName(specifier);
			if (name !== undefined && name !== atomicPackageJson.name && !loaded.has(name)) {
				loaded.set(name, relative(DIST, file));
			}
		}
		for (const value of references.strings) {
			const name = packageName(value);
			if (name !== undefined) named.add(name);
		}
	}
	const declared = new Set(
		Object.keys({ ...atomicPackageJson.dependencies, ...atomicPackageJson.optionalDependencies }),
	);
	const undeclared = [...loaded].filter(([name]) => !declared.has(name)).map(([name, file]) => `${name} (${file})`);
	// A dependency that a loaded package requires is installed anyway; declaring it pins its version.
	const installed = new Map<string, { dependencies?: Record<string, string> }>();
	for (const { name, entry } of codingAgentDependencyClosure()) if (!installed.has(name)) installed.set(name, entry);
	const required = new Set([...loaded.keys()].flatMap((name) => Object.keys(installed.get(name)?.dependencies ?? {})));
	const notLoaded = [...declared].filter((name) => !loaded.has(name) && !named.has(name) && !required.has(name));
	const unused = notLoaded.filter((name) => !KEPT_FOR_IN_PLACE_UPDATE.has(name));
	// A package kept for in-place updates is one the published files no longer load, and still a dependency.
	const keptNeedlessly = [...KEPT_FOR_IN_PLACE_UPDATE].filter((name) => !notLoaded.includes(name));
	// An undeclared package is missing from installs; an unused one adds files to every install.
	assert.deepEqual({ undeclared, unused, keptNeedlessly }, { undeclared: [], unused: [], keptNeedlessly: [] });
});

interface PackDryRunResult {
	readonly name: string;
	readonly files: readonly { readonly path: string }[];
}

builtTest(
	"published packages leave out declaration maps, whose TypeScript sources they do not ship",
	() => {
		const pack = spawnSyncCollect(
			[
				...npmSpawnPrefix(),
				"pack",
				"--dry-run",
				"--json",
				"--ignore-scripts",
				...TSC_PACKAGE_DIRS.map((directory) => `./${directory}`),
			],
			{ timeout: NPM_PACK_DRY_RUN_TIMEOUT_MS },
		);
		assert.equal(pack.exitCode, 0, pack.stderr.toString());
		const results = JSON.parse(pack.stdout.toString()) as PackDryRunResult[];
		assert.equal(results.length, TSC_PACKAGE_DIRS.length);
		for (const { name, files } of results) {
			const paths = files.map((file) => file.path);
			assert.deepEqual(
				paths.filter((path) => path.endsWith(".d.ts.map")),
				[],
				`${name} ships declaration maps`,
			);
			assert.ok(
				paths.some((path) => path.endsWith(".d.ts")),
				`${name} must still ship its declarations`,
			);
			assert.ok(
				paths.some((path) => path.endsWith(".js.map")),
				`${name} must still ship the source maps that stack traces use`,
			);
			assert.equal(paths.includes("src/index.ts"), false, `${name} does not ship TypeScript sources`);
		}
	},
	NPM_PACK_DRY_RUN_TIMEOUT_MS,
);
