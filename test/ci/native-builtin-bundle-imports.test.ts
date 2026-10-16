import assert from "node:assert/strict";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { isBuiltin } from "node:module";
import { basename, extname, join, relative } from "node:path";
import { parse } from "acorn";
import { simple } from "acorn-walk";
import { test } from "vitest";
import {
	INSTALLED_EXTENSION_ENTRIES,
	WORKFLOWS_SDK_BUNDLE_ENTRY,
} from "../../packages/coding-agent/src/core/builtin-install-layout.js";
import { getVirtualModules } from "../../packages/coding-agent/src/core/extensions/loader-host-modules.js";
import { moduleDir, npmSpawnPrefix, spawnSyncCollect } from "../helpers/runtime.js";

const root = join(moduleDir(import.meta.url), "../..");
const BUILTIN_BUNDLE_BUILD_TIMEOUT_MS = 120_000;

function stageBuiltinBuild(fixture: string): string {
	const packageRoot = join(fixture, "packages/coding-agent");
	mkdirSync(join(fixture, "packages"));
	cpSync(join(root, "packages/coding-agent"), packageRoot, {
		recursive: true,
		filter: (path) => !["node_modules", "dist"].includes(basename(path)),
	});
	copyFileSync(join(root, "tsconfig.base.json"), join(fixture, "tsconfig.base.json"));
	// Dependencies and companion sources are read-only inputs; every build output stays in the copy.
	symlinkSync(join(root, "node_modules"), join(fixture, "node_modules"), "junction");
	const packageDependencies = join(root, "packages/coding-agent/node_modules");
	if (existsSync(packageDependencies)) symlinkSync(packageDependencies, join(packageRoot, "node_modules"), "junction");
	for (const name of readdirSync(join(root, "packages"))) {
		if (name === "workflows") {
			const workflows = join(fixture, "packages", name);
			cpSync(join(root, "packages", name), workflows, {
				recursive: true,
				filter: (path) => basename(path) !== "node_modules",
			});
			const scope = join(workflows, "node_modules/@bastani");
			mkdirSync(scope, { recursive: true });
			symlinkSync(packageRoot, join(scope, "atomic"), "junction");
		} else if (name !== "coding-agent") {
			symlinkSync(join(root, "packages", name), join(fixture, "packages", name), "junction");
		}
	}
	return packageRoot;
}

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
		const sharedBuiltinRoot = join(root, "packages/coding-agent/dist/builtin");
		const sharedBuiltinMtime = statSync(sharedBuiltinRoot, { throwIfNoEntry: false })?.mtimeMs;
		const fixture = mkdtempSync(join(root, ".tmp-builtin-bundle-contract-"));
		try {
			const packageRoot = stageBuiltinBuild(fixture);
			const build = spawnSyncCollect([...npmSpawnPrefix(), "--prefix", packageRoot, "run", "build"], {
				cwd: fixture,
			});
			assert.equal(build.exitCode, 0, `${build.stdout.toString()}\n${build.stderr.toString()}`);
			assert.equal(
				statSync(sharedBuiltinRoot, { throwIfNoEntry: false })?.mtimeMs,
				sharedBuiltinMtime,
				"the contract build must not rewrite the checkout's builtin bundles",
			);

			const hostSpecifiers = new Set(Object.keys(await getVirtualModules()));
			const unexpected: string[] = [];
			const builtinRoot = join(packageRoot, "dist/builtin");
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

			const notices = join(builtinRoot, "mcp", "native-client-licenses");
			assert.match(readFileSync(join(notices, "NOTICE"), "utf8"), /MIT License/);
			assert.match(
				readFileSync(join(notices, "LICENSES", "modelcontextprotocol-typescript-sdk.txt"), "utf8"),
				/MIT License/,
			);

			assert.deepEqual(unexpected, []);
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	},
	BUILTIN_BUNDLE_BUILD_TIMEOUT_MS,
);
