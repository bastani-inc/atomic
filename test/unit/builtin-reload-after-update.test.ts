/**
 * `/reload` in a process that an in-place update caught loads the builtin extensions' new bundles against the host
 * modules the process started with. A bundle that names an export the running host lacks fails to load with the restart
 * message instead of starting with that name `undefined`; one whose names the host has loads as before.
 */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type ImportDeclaration, parse } from "acorn";
import { afterEach, test } from "vitest";
import { withHostImportGuard } from "../../packages/coding-agent/scripts/builtin-host-import-guard.js";
import { INSTALLED_EXTENSION_ENTRIES } from "../../packages/coding-agent/src/core/builtin-install-layout.js";
import { NODE_TS_SOURCE_ARGS } from "../helpers/node-ts-sources.js";
import { makeTempDirectory, moduleDir, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";

const ROOT = join(moduleDir(import.meta.url), "../..");
const PACKAGE = join(ROOT, "packages/coding-agent");
const SOURCE = join(PACKAGE, "src");
const BUILTIN = join(PACKAGE, "dist/builtin");
const VERSION = (JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as { version: string }).version;
const builtTest = existsSync(join(BUILTIN, "mcp", INSTALLED_EXTENSION_ENTRIES.mcp)) ? test : test.skip;
/** One child process that loads the extension loader, the host package and one builtin bundle: structural. */
const CHILD_TIMEOUT_MS = 90_000;

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDirectory(dir);
});

/** The names `bundle` imports from `@bastani/atomic` by name. */
function namedHostImports(bundle: string): string[] {
	const program = parse(readFileSync(bundle, "utf8"), { ecmaVersion: "latest", sourceType: "module" });
	return program.body.flatMap((node) =>
		node.type === "ImportDeclaration" && (node as ImportDeclaration).source.value === "@bastani/atomic"
			? (node as ImportDeclaration).specifiers.flatMap((specifier) =>
					specifier.type === "ImportSpecifier" && specifier.imported.type === "Identifier"
						? [specifier.imported.name]
						: [],
				)
			: [],
	);
}

interface Outcome {
	readonly factory?: string;
	readonly error?: string;
}

/**
 * A process of `version` (0.10.3 unless given), whose host module `without.specifier` (`@bastani/atomic` unless given) lacks
 * `without.name`, reloads its builtin extension `label` after an update replaced the bundle (with `source`, if given):
 * the loader evaluates the bundle on disk through its transform, as each `/reload` does once the loader has imported the
 * bundle natively (on Windows, and under Bun).
 */
function reload(
	label: keyof typeof INSTALLED_EXTENSION_ENTRIES,
	without?: { specifier?: string; name: string },
	source?: string,
	version = "0.10.3",
): Outcome {
	const dir = makeTempDirectory("atomic-builtin-reload-");
	dirs.push(dir);
	// The installation the process runs from, after the update: the builtin is this build's. The process resolves the
	// bundle's imports of its host to the modules it started with, as a process an update caught resolves them to the
	// copies it loaded before: nothing here resolves them to this build's files.
	const installation = join(dir, "installation");
	mkdirSync(installation);
	writeFileSync(join(installation, "package.json"), JSON.stringify({ name: "@bastani/atomic", version }));
	cpSync(join(BUILTIN, label), join(installation, "dist/builtin", label), { recursive: true });
	const bundle = join(installation, "dist/builtin", label, INSTALLED_EXTENSION_ENTRIES[label]);
	if (source !== undefined) writeFileSync(bundle, source);
	const specifier = without?.specifier ?? "@bastani/atomic";
	const script = join(dir, "session.mjs");
	writeFileSync(
		script,
		`const { getVirtualModules } = await import(${JSON.stringify(pathToFileURL(join(SOURCE, "core/extensions/loader-host-modules.ts")).href)});
const { extensionLoaderTestHooks } = await import(${JSON.stringify(pathToFileURL(join(SOURCE, "core/extensions/loader-virtual-modules.ts")).href)});
const modules = await getVirtualModules();
// The host modules the process started with lack the names added since.
const host = { ...modules[${JSON.stringify(specifier)}] };
${without === undefined ? "" : `delete host[${JSON.stringify(without.name)}];`}
modules[${JSON.stringify(specifier)}] = host;
try {
	const factory = await extensionLoaderTestHooks.loadExtensionModuleTransformed(${JSON.stringify(bundle)}, undefined, ${JSON.stringify(join(dir, "agent"))});
	process.stdout.write(JSON.stringify({ factory: typeof factory }));
} catch (error) {
	process.stdout.write(JSON.stringify({ error: String(error?.message) }));
}
process.exit(0);
`,
	);
	const result = spawnSyncCollect([process.execPath, ...NODE_TS_SOURCE_ARGS, script], {
		cwd: dir,
		env: {
			...process.env,
			NODE_OPTIONS: "",
			HOME: dir,
			USERPROFILE: dir,
			ATOMIC_PACKAGE_DIR: installation,
			PI_PACKAGE_DIR: "",
		},
		timeout: CHILD_TIMEOUT_MS,
	});
	assert.equal(result.exitCode, 0, result.stderr.toString());
	return JSON.parse(result.stdout.toString()) as Outcome;
}

for (const label of ["mcp", "subagents"] as const) {
	const bundle = join(BUILTIN, label, INSTALLED_EXTENSION_ENTRIES[label]);
	builtTest(
		`the ${label} extension reloaded by a process an update left behind, whose host lacks a name it imports, says to restart`,
		() => {
			const [name] = namedHostImports(bundle);
			assert.ok(name, `${bundle} imports nothing from @bastani/atomic by name`);
			assert.deepEqual(reload(label, { name }), {
				error: `atomic was updated to ${VERSION} while this session was running; restart it to keep using the ${label} extension.\nThe requested module '@bastani/atomic' does not provide an export named '${name}'`,
			});
		},
		CHILD_TIMEOUT_MS,
	);
}

builtTest(
	"a builtin extension reloaded by a process an update left behind loads when its host has every name it imports",
	() => {
		assert.deepEqual(reload("subagents"), { factory: "function" });
	},
	CHILD_TIMEOUT_MS,
);

builtTest("every builtin extension bundle checks each name it imports from the host before its own code runs", () => {
	for (const [label, entry] of Object.entries(INSTALLED_EXTENSION_ENTRIES)) {
		const source = readFileSync(join(BUILTIN, label, entry), "utf8");
		const program = parse(source, { ecmaVersion: "latest", sourceType: "module" });
		const firstCode = program.body.find((node) => node.type !== "ImportDeclaration");
		assert.equal(firstCode?.type, "BlockStatement", `${label}: the bundle's first statement checks the host`);
		const checked = source.slice(firstCode!.start, firstCode!.end);
		for (const name of namedHostImports(join(BUILTIN, label, entry)))
			assert.ok(checked.includes(JSON.stringify(name)), `${label}: ${name} is not checked`);
	}
});

/** A bundle that imports from its host in each way a bundle can, with the guard the build gives it. */
const IMPORTS_EACH_WAY = withHostImportGuard(
	[
		'import lock from "proper-lockfile";',
		'import * as compat from "@bastani/atomic-ai/compat";',
		'import { createMcpExtension as create } from "@bastani/atomic";',
		'import { Type } from "@bastani/atomic-ai";',
		'import { join } from "node:path";',
		"export default function (pi) { void lock; void compat.getModel; void Type; void join; return create()(pi); }",
	].join("\n"),
	{
		label: "mcp",
		version: VERSION,
		isHostSpecifier: (specifier) => specifier.startsWith("@bastani/") || specifier === "proper-lockfile",
	},
);

builtTest(
	"the check names an import by the name the host exports, and leaves out default and namespace imports",
	() => {
		assert.deepEqual(reload("mcp", { name: "createMcpExtension" }, IMPORTS_EACH_WAY), {
			error: `atomic was updated to ${VERSION} while this session was running; restart it to keep using the mcp extension.\nThe requested module '@bastani/atomic' does not provide an export named 'createMcpExtension'`,
		});
		// A name the bundle reads through a namespace import is one it can do without.
		assert.deepEqual(reload("mcp", { specifier: "@bastani/atomic-ai/compat", name: "getModel" }, IMPORTS_EACH_WAY), {
			factory: "function",
		});
		assert.deepEqual(reload("mcp", { specifier: "proper-lockfile", name: "default" }, IMPORTS_EACH_WAY), {
			factory: "function",
		});
		// Each module the host provides is checked, and only the update's message says to restart.
		assert.deepEqual(reload("mcp", { specifier: "@bastani/atomic-ai", name: "Type" }, IMPORTS_EACH_WAY, VERSION), {
			error: "The requested module '@bastani/atomic-ai' does not provide an export named 'Type'",
		});
	},
	CHILD_TIMEOUT_MS * 4,
);
