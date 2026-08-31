import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { extname, join, relative } from "node:path";
import { parse } from "acorn";
import { simple } from "acorn-walk";
import { test } from "vitest";
import {
	INSTALLED_EXTENSION_ENTRIES,
	WORKFLOWS_SDK_BUNDLE_ENTRY,
} from "../../packages/coding-agent/src/core/builtin-install-layout.js";
import { getVirtualModules } from "../../packages/coding-agent/src/core/extensions/loader-host-modules.js";
import { moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

const root = join(moduleDir(import.meta.url), "../..");
const BUILTIN_BUNDLE_BUILD_TIMEOUT_MS = 120_000;

function isBareSpecifier(specifier: string): boolean {
	return !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("file:");
}

function isPermittedSpecifier(specifier: string, hostSpecifiers: ReadonlySet<string>): boolean {
	if (!isBareSpecifier(specifier)) return true;
	// `builtinModules` omits prefix-only builtins such as `node:sqlite` on Node 22;
	// `isBuiltin` recognizes them on every supported Node version.
	return isBuiltin(specifier) || hostSpecifiers.has(specifier);
}

function collectImportSpecifiers(source: string): Set<string> {
	const specifiers = new Set<string>();
	const program = parse(source, { ecmaVersion: "latest", sourceType: "module" });
	const addLiteral = (value: string | number | bigint | boolean | RegExp | null | undefined): void => {
		if (typeof value === "string") specifiers.add(value);
	};
	simple(program, {
		ImportDeclaration: (node) => addLiteral(node.source.value),
		ExportNamedDeclaration: (node) => addLiteral(node.source?.value),
		ExportAllDeclaration: (node) => addLiteral(node.source.value),
		ImportExpression: (node) => {
			if (node.source.type === "Literal") addLiteral(node.source.value);
		},
	});
	return specifiers;
}

function listJavaScriptArtifacts(rootDir: string): string[] {
	return readdirSync(rootDir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(rootDir, entry.name);
		if (entry.isDirectory()) return listJavaScriptArtifacts(path);
		return [".js", ".mjs"].includes(extname(entry.name)) ? [path] : [];
	});
}

test("specifier permits Node builtins, registered host imports, and relative imports only", () => {
	const emptyHostSpecifiers = new Set<string>();

	assert.equal(isPermittedSpecifier("node:sqlite", emptyHostSpecifiers), true);
	assert.equal(isPermittedSpecifier("node:fs", emptyHostSpecifiers), true);
	assert.equal(isPermittedSpecifier("fs", emptyHostSpecifiers), true);
	assert.equal(isPermittedSpecifier("acorn", emptyHostSpecifiers), false);
	assert.equal(isPermittedSpecifier("acorn", new Set(["acorn"])), true);
	assert.equal(isPermittedSpecifier("./thing.js", emptyHostSpecifiers), true);
});

test(
	"installed builtin bundles retain only node builtins and registered host imports",
	async () => {
		const build = spawnSyncCollect(["npm", "run", "build", "--workspace=@bastani/atomic"], { cwd: root });
		assert.equal(build.exitCode, 0, `${build.stdout.toString()}\n${build.stderr.toString()}`);

		const hostSpecifiers = new Set(Object.keys(await getVirtualModules()));
		const unexpected: string[] = [];
		const builtinRoot = join(root, "packages/coding-agent/dist/builtin");
		const emittedArtifacts = [
			...Object.entries(INSTALLED_EXTENSION_ENTRIES).map(([dirName, entry]) => join(builtinRoot, dirName, entry)),
			join(builtinRoot, "workflows", WORKFLOWS_SDK_BUNDLE_ENTRY),
			...listJavaScriptArtifacts(join(builtinRoot, "workflows", "builtin")),
		];

		for (const artifactPath of emittedArtifacts) {
			const source = readFileSync(artifactPath, "utf8");
			for (const specifier of collectImportSpecifiers(source)) {
				if (!isPermittedSpecifier(specifier, hostSpecifiers)) {
					unexpected.push(`${relative(builtinRoot, artifactPath)}: ${specifier}`);
				}
			}
		}

		const installedXdgOpen = join(builtinRoot, "mcp", "xdg-open");
		assert.notEqual(statSync(installedXdgOpen).mode & 0o111, 0, "installed MCP xdg-open fallback is not executable");

		assert.deepEqual(unexpected, []);
	},
	BUILTIN_BUNDLE_BUILD_TIMEOUT_MS,
);
