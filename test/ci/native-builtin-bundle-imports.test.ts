import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { extname, join, relative, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { parse } from "acorn";
import { simple } from "acorn-walk";
import { test } from "vitest";
import {
	INSTALLED_EXTENSION_ENTRIES,
	WORKFLOWS_SDK_BUNDLE_ENTRY,
} from "../../packages/coding-agent/src/core/builtin-install-layout.js";
import { getVirtualModules } from "../../packages/coding-agent/src/core/extensions/loader-host-modules.js";
import {
	bunExecutable,
	makeTempDirectory,
	moduleDir,
	npmSpawnPrefix,
	readTextSync,
	removeTempDirectory,
	spawnSyncCollect,
	writeTextSync,
} from "../helpers/runtime.js";

const root = join(moduleDir(import.meta.url), "../..");
const BUILTIN_BUNDLE_BUILD_TIMEOUT_MS = 120_000;
const packageRoot = join(root, "packages/coding-agent");

interface ChmodRequest {
	path: string;
	mode: number;
}

function runWithChmodTrace(command: string[], cwd: string, inheritedEnv = process.env) {
	const traceRoot = makeTempDirectory("atomic chmod trace ");
	const logPath = join(traceRoot, "chmod.jsonl");
	try {
		writeTextSync(logPath, "");
		const result = spawnSyncCollect(command, {
			cwd,
			env: {
				...inheritedEnv,
				// This helper rebuilds real delivery assets, even when called by Vitest.
				NODE_ENV: "production",
				NODE_TEST_CONTEXT: undefined,
				// npm selects this workspace cwd for its Bun scripts. A relative path
				// avoids Bun 1.4.2's lack of quoted/space-containing BUN_OPTIONS values.
				BUN_OPTIONS: `${process.env.BUN_OPTIONS ?? ""} --preload=../../test/fixtures/xdg-open-chmod-preload.mjs`,
				ATOMIC_TEST_CHMOD_LOG: logPath,
			},
		});
		const requests = readTextSync(logPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as ChmodRequest);
		return { result, requests };
	} finally {
		removeTempDirectory(traceRoot);
	}
}

function assertExecutableInstall(installedXdgOpen: string, requests: ChmodRequest[]): void {
	assert.equal(statSync(installedXdgOpen).isFile(), true, "installed MCP xdg-open fallback is missing");
	// NTFS stat cannot expose POSIX execute bits. Observe the actual last chmod
	// request for this exact installed file, not permission data from a fixture.
	const request = requests.findLast((entry) => entry.path === resolve(installedXdgOpen));
	assert.ok(request, "build did not chmod the installed MCP xdg-open fallback");
	assert.notEqual(request.mode & 0o111, 0, "build did not request executable permissions for MCP xdg-open");
	if (process.platform !== "win32") {
		assert.notEqual(statSync(installedXdgOpen).mode & 0o111, 0, "installed MCP xdg-open fallback is not executable");
	}
}

for (const { name, install, rejection } of [
	{ name: "accepts executable permissions", install: "chmodSync(target, 0o755);", rejection: undefined },
	{ name: "rejects omitted chmod", install: "", rejection: /build did not chmod/ },
	{
		name: "rejects non-executable permissions",
		install: "chmodSync(target, 0o644);",
		rejection: /build did not request executable permissions/,
	},
	{
		name: "rejects chmod on a different xdg-open",
		install: `mkdirSync(target + "-other");
			const other = join(target + "-other", "xdg-open");
			writeFileSync(other, "other fallback"); chmodSync(other, 0o755);`,
		rejection: /build did not chmod/,
	},
	{
		name: "rejects a missing installed file even after chmod",
		install: "chmodSync(target, 0o755); rmSync(target);",
		rejection: /ENOENT/,
	},
	{
		name: "rejects permissions made non-executable after an executable request",
		install: "chmodSync(target, 0o755); chmodSync(target, 0o644);",
		rejection: /build did not request executable permissions/,
	},
]) {
	test(`executable-install guard ${name}`, () => {
		const fixture = makeTempDirectory("atomic xdg-open guard ");
		try {
			const installedXdgOpen = join(fixture, "xdg-open");
			const installer = join(fixture, "install.mjs");
			writeTextSync(
				installer,
				`import { chmodSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
				import { join } from "node:path";
				const target = process.argv[2];
				writeFileSync(target, "fallback");
				${install}`,
			);
			const { result, requests } = runWithChmodTrace([bunExecutable(), installer, installedXdgOpen], packageRoot);
			assert.equal(result.exitCode, 0, result.stderr.toString());
			if (rejection) {
				assert.throws(() => assertExecutableInstall(installedXdgOpen, requests), rejection);
			} else {
				assertExecutableInstall(installedXdgOpen, requests);
				assert.deepEqual(requests, [{ path: installedXdgOpen, mode: 0o755 }]);
			}
		} finally {
			removeTempDirectory(fixture);
		}
	});
}

test("chmod observation forwards filesystem errors without recording success", () => {
	const fixture = makeTempDirectory("atomic chmod failure ");
	try {
		const installer = join(fixture, "install.mjs");
		writeTextSync(installer, `import { chmodSync } from "node:fs"; chmodSync(process.argv[2], 0o755);`);
		const { result, requests } = runWithChmodTrace(
			[bunExecutable(), installer, join(fixture, "missing")],
			packageRoot,
		);
		assert.notEqual(result.exitCode, 0);
		assert.match(result.stderr.toString(), /ENOENT/);
		assert.deepEqual(requests, []);
	} finally {
		removeTempDirectory(fixture);
	}
});

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
		const { result: build, requests } = runWithChmodTrace(
			[...npmSpawnPrefix(), "run", "build", "--workspace=@bastani/atomic"],
			root,
			{ ...process.env, NODE_ENV: "test", NODE_TEST_CONTEXT: "child-v8" },
		);
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
			// #2700: execute the emitted workflow guard, not the unfurled source guard.
			// A test-hosted real build must still select SDK sessions in production.
			if (artifactPath === join(builtinRoot, "workflows", INSTALLED_EXTENSION_ENTRIES.workflows)) {
				const guards: string[] = [];
				simple(parse(source, { ecmaVersion: "latest", sourceType: "module" }), {
					FunctionDeclaration(node) {
						if (node.id?.name === "isTestContext") guards.push(source.slice(node.start, node.end));
					},
				});
				assert.equal(guards.length, 1, "expected the emitted workflow test-context guard");
				assert.equal(
					runInNewContext(`(${guards[0]})()`, { process: { env: { NODE_ENV: "production" } } }),
					false,
					"test-hosted build permanently enables workflow stub sessions",
				);
			}
			for (const specifier of collectImportSpecifiers(source)) {
				if (!isPermittedSpecifier(specifier, hostSpecifiers)) {
					unexpected.push(`${relative(builtinRoot, artifactPath)}: ${specifier}`);
				}
			}
		}

		const installedXdgOpen = join(builtinRoot, "mcp", "xdg-open");
		assertExecutableInstall(installedXdgOpen, requests);

		assert.deepEqual(unexpected, []);
	},
	BUILTIN_BUNDLE_BUILD_TIMEOUT_MS,
);
