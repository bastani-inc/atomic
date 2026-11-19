import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	loadStorageAdapter,
	resolveAdapterOptions,
	StorageAdapterLoadError,
	StorageProvider,
	StorageUnavailableError,
} from "@bastani/atomic/storage";
import { test } from "vitest";
import { createBrokerHostModulePlugin } from "../../packages/coding-agent/src/bun/internal-intercom-broker.js";
import {
	makeDirectorySync,
	makeTempDirectory,
	moduleDir,
	removeTempDirectory,
	spawnSyncCollect,
	symlinkSync,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";

/**
 * An adapter outside any installed copy of Atomic, loaded by the built `@bastani/atomic/storage`. Single-file builds
 * (`ATOMIC_BUNDLED_BUILD=1`, as in the standalone binary) have no host files to alias and resolve both host specifiers
 * from live virtual modules instead.
 */
function loadAdapterWithBuiltHost(env: Record<string, string | undefined>): void {
	const agentDir = makeTempDirectory("storage-built-host-modules-");
	writeFileSync(
		join(agentDir, "adapter.ts"),
		[
			'import * as atomic from "@bastani/atomic";',
			'import * as storage from "@bastani/atomic/storage";',
			"export default { atomicStorageAdapter: 1 as const, atomic, storage };",
			"",
		].join("\n"),
	);
	try {
		const result = spawnSyncCollect(
			[
				process.execPath,
				"--input-type=module",
				"-e",
				`
			import assert from 'node:assert/strict';
			import * as atomic from '@bastani/atomic';
			import * as storage from '@bastani/atomic/storage';
			const adapter = await storage.loadStorageAdapter('./adapter.ts', { agentDir: ${JSON.stringify(agentDir)}, domain: 'intercom' });
			assert.equal(adapter.storage.StorageUnavailableError, storage.StorageUnavailableError);
			assert.equal(adapter.storage.createSqliteDatabase, storage.createSqliteDatabase);
			assert.equal(adapter.atomic.createAgentSession, atomic.createAgentSession);
			assert.equal(adapter.atomic.StorageUnavailableError, storage.StorageUnavailableError);
		`,
			],
			{ cwd: join(moduleDir(import.meta.url), "../../packages/coding-agent"), env: { ...process.env, ...env } },
		);
		assert.equal(result.exitCode, 0, result.stdout.toString() + result.stderr.toString());
	} finally {
		removeTempDirectory(agentDir);
	}
}

test("built package adapters share @bastani/atomic and its storage module without an installed copy (#3856)", () => {
	loadAdapterWithBuiltHost({ ATOMIC_BUNDLED_BUILD: undefined });
});

test("single-file builds give adapters the live host modules through virtual modules, as the standalone binary does (#3856)", () => {
	loadAdapterWithBuiltHost({ ATOMIC_BUNDLED_BUILD: "1" });
});

/** A `"type": "module"` adapter package whose own `.js` and `.mjs` files import `@bastani/atomic/storage`. */
async function writeModuleTypeAdapter(adapterDir: string): Promise<void> {
	const which = [
		'import * as storage from "@bastani/atomic/storage";',
		'export const which = () => storage.MARK ?? "node-resolved";',
		"",
	].join("\n");
	await writeFileEnsuringDir(join(adapterDir, "package.json"), JSON.stringify({ type: "module" }));
	await writeFileEnsuringDir(
		join(adapterDir, "adapter.js"),
		[
			'import { which } from "./static.js";',
			"export default {",
			"\tatomicStorageAdapter: 1,",
			"\twhich,",
			'\tasync fromInner() { return (await import("./inner.js")).which(); },',
			'\tasync nested() { return import("./nested.js"); },',
			"};",
			"",
		].join("\n"),
	);
	await writeFileEnsuringDir(join(adapterDir, "inner.js"), which);
	await writeFileEnsuringDir(join(adapterDir, "static.js"), which);
	await writeFileEnsuringDir(join(adapterDir, "nested.mjs"), which);
	await writeFileEnsuringDir(
		join(adapterDir, "nested.js"),
		['export { which } from "./static.js";', 'export { which as mjs } from "./nested.mjs";', ""].join("\n"),
	);
}

test("modules a type:module adapter imports get the host's @bastani/atomic/storage, not the npm copy (#3972)", async () => {
	const agentDir = makeTempDirectory("storage-module-type-adapter-");
	const adapterDir = join(agentDir, "adapter");
	await writeModuleTypeAdapter(adapterDir);
	// A resolvable npm copy, which a natively imported nested module would pick up instead of the host's.
	const npmCopy = join(adapterDir, "node_modules", "@bastani", "atomic");
	await writeFileEnsuringDir(
		join(npmCopy, "package.json"),
		JSON.stringify({ name: "@bastani/atomic", type: "module", exports: { "./storage": "./storage.js" } }),
	);
	await writeFileEnsuringDir(join(npmCopy, "storage.js"), "export const MARK = undefined;\n");
	try {
		const adapter = (await loadStorageAdapter(
			join(adapterDir, "adapter.js"),
			{ agentDir, domain: "sessions" },
			{ "@bastani/atomic/storage": { MARK: "host" } },
		)) as Awaited<ReturnType<typeof loadStorageAdapter>> & {
			readonly which: () => string;
			fromInner(): Promise<string>;
			nested(): Promise<{ readonly which: () => string; readonly mjs: () => string }>;
		};
		assert.equal(await adapter.fromInner(), "host");
		assert.equal(adapter.which(), "host");
		const nested = await adapter.nested();
		assert.equal(nested.mjs(), "host");
		assert.equal(nested.which, adapter.which, "a module imported twice is evaluated once");
	} finally {
		removeTempDirectory(agentDir);
	}
});

// The three type:module adapters below still export `openRunJournal`, a hook of earlier releases that the loader accepts
// and no store calls; each test calls it itself to run the adapter's own imports.

test("concurrent imports of a type:module helper both wait for its top-level await (#3972)", async () => {
	const agentDir = makeTempDirectory("storage-module-type-concurrent-");
	const adapterDir = join(agentDir, "adapter");
	await writeFileEnsuringDir(join(adapterDir, "package.json"), JSON.stringify({ type: "module" }));
	await writeFileEnsuringDir(
		join(adapterDir, "adapter.js"),
		[
			"export default {",
			"\tatomicStorageAdapter: 1,",
			'\tasync openRunJournal() { return (await import("./helper.js")).readRun(); },',
			"};",
			"",
		].join("\n"),
	);
	await writeFileEnsuringDir(
		join(adapterDir, "helper.js"),
		["await new Promise((resolve) => setTimeout(resolve, 50));", 'export const readRun = () => "run";', ""].join(
			"\n",
		),
	);
	try {
		const adapter = (await loadStorageAdapter(
			join(adapterDir, "adapter.js"),
			{ agentDir, domain: "sessions" },
			{ "@bastani/atomic/storage": {} },
		)) as Awaited<ReturnType<typeof loadStorageAdapter>> & { openRunJournal(): Promise<string> };
		assert.deepEqual(await Promise.all([adapter.openRunJournal(), adapter.openRunJournal()]), ["run", "run"]);
	} finally {
		removeTempDirectory(agentDir);
	}
});

test("type:module adapter modules that import each other load without waiting on themselves (#3972)", async () => {
	const agentDir = makeTempDirectory("storage-module-type-cycle-");
	const adapterDir = join(agentDir, "adapter");
	await writeFileEnsuringDir(join(adapterDir, "package.json"), JSON.stringify({ type: "module" }));
	await writeFileEnsuringDir(
		join(adapterDir, "adapter.js"),
		[
			'import { ping } from "./ping.js";',
			"export default { atomicStorageAdapter: 1, async openRunJournal() { return ping(2); } };",
			"",
		].join("\n"),
	);
	await writeFileEnsuringDir(
		join(adapterDir, "ping.js"),
		[
			'import { pong } from "./pong.js";',
			'export function ping(count) { return count === 0 ? "done" : pong(count - 1); }',
			"",
		].join("\n"),
	);
	await writeFileEnsuringDir(
		join(adapterDir, "pong.js"),
		['import * as cycle from "./ping.js";', "export function pong(count) { return cycle.ping(count); }", ""].join(
			"\n",
		),
	);
	try {
		const adapter = (await loadStorageAdapter(
			join(adapterDir, "adapter.js"),
			{ agentDir, domain: "sessions" },
			{ "@bastani/atomic/storage": {} },
		)) as Awaited<ReturnType<typeof loadStorageAdapter>> & { openRunJournal(): Promise<string> };
		assert.equal(await adapter.openRunJournal(), "done");
	} finally {
		removeTempDirectory(agentDir);
	}
});

test("a type:module helper and a TypeScript module that import each other load without hanging (#3972)", async () => {
	const agentDir = makeTempDirectory("storage-module-type-mixed-cycle-");
	const adapterDir = join(agentDir, "adapter");
	await writeFileEnsuringDir(join(adapterDir, "package.json"), JSON.stringify({ type: "module" }));
	await writeFileEnsuringDir(
		join(adapterDir, "adapter.js"),
		[
			'import { ping } from "./helper.mjs";',
			"export default { atomicStorageAdapter: 1, async openRunJournal() { return ping(2); } };",
			"",
		].join("\n"),
	);
	await writeFileEnsuringDir(
		join(adapterDir, "helper.mjs"),
		[
			'import { pong } from "./bridge.ts";',
			'export function ping(count) { return count === 0 ? "done" : pong(count - 1); }',
			"",
		].join("\n"),
	);
	await writeFileEnsuringDir(
		join(adapterDir, "bridge.ts"),
		[
			'import * as cycle from "./helper.mjs";',
			"export function pong(count: number): string { return cycle.ping(count); }",
			"",
		].join("\n"),
	);
	try {
		const adapter = (await loadStorageAdapter(
			join(adapterDir, "adapter.js"),
			{ agentDir, domain: "sessions" },
			{ "@bastani/atomic/storage": {} },
		)) as Awaited<ReturnType<typeof loadStorageAdapter>> & { openRunJournal(): Promise<string> };
		assert.equal(await adapter.openRunJournal(), "done");
	} finally {
		removeTempDirectory(agentDir);
	}
});

/**
 * The type:module adapter loaded by the built `@bastani/atomic/storage`, with a resolvable installed copy of Atomic
 * beside it whose storage module lacks the host's `MARK`.
 */
async function loadModuleTypeAdapterWithBuiltHost(env: Record<string, string | undefined>): Promise<void> {
	const agentDir = makeTempDirectory("storage-module-type-built-host-");
	const adapterDir = join(agentDir, "adapter");
	const packageDir = join(moduleDir(import.meta.url), "../../packages/coding-agent");
	await writeModuleTypeAdapter(adapterDir);
	makeDirectorySync(join(adapterDir, "node_modules", "@bastani"), { recursive: true });
	symlinkSync(
		packageDir,
		join(adapterDir, "node_modules", "@bastani", "atomic"),
		process.platform === "win32" ? "junction" : "dir",
	);
	try {
		const result = spawnSyncCollect(
			[
				process.execPath,
				"--input-type=module",
				"-e",
				`
			import assert from 'node:assert/strict';
			import * as storage from '@bastani/atomic/storage';
			const adapter = await storage.loadStorageAdapter(
				${JSON.stringify(join(adapterDir, "adapter.js"))},
				{ agentDir: ${JSON.stringify(agentDir)}, domain: 'sessions' },
				{ '@bastani/atomic/storage': { ...storage, MARK: 'host' } },
			);
			assert.equal(await adapter.fromInner(), 'host');
			assert.equal(adapter.which(), 'host');
			const nested = await adapter.nested();
			assert.equal(nested.mjs(), 'host');
			assert.equal(nested.which, adapter.which);
		`,
			],
			{ cwd: packageDir, env: { ...process.env, ...env } },
		);
		assert.equal(result.exitCode, 0, result.stdout.toString() + result.stderr.toString());
	} finally {
		removeTempDirectory(agentDir);
	}
}

test("built package hosts give a type:module adapter's nested modules the host storage module (#3972)", async () => {
	await loadModuleTypeAdapterWithBuiltHost({ ATOMIC_BUNDLED_BUILD: undefined });
});

test("single-file builds give a type:module adapter's nested modules the host storage module (#3972)", async () => {
	await loadModuleTypeAdapterWithBuiltHost({ ATOMIC_BUNDLED_BUILD: "1" });
});

test("the standalone broker loads host modules from the app bundle on first import only (#3856)", async () => {
	const storage = { name: "storage" };
	const atomic = { name: "atomic" };
	let appLoads = 0;
	const callbacks = new Map<string, () => Promise<{ exports: object; loader: "object" }>>();
	createBrokerHostModulePlugin(async () => {
		appLoads++;
		return { loadHostModule: async (specifier) => (specifier === "@bastani/atomic" ? atomic : storage) };
	}).setup({ module: (specifier, callback) => void callbacks.set(specifier, callback) });
	assert.deepEqual([...callbacks.keys()], ["@bastani/atomic", "@bastani/atomic/storage"]);
	assert.equal(appLoads, 0);
	assert.equal((await callbacks.get("@bastani/atomic/storage")!()).exports, storage);
	assert.equal((await callbacks.get("@bastani/atomic")!()).exports, atomic);
	assert.equal(appLoads, 1);
});

function adapterSource(name: string): string {
	return [
		'import { StorageUnavailableError } from "@bastani/atomic/storage";',
		'import { driver } from "fake-driver";',
		`export default { atomicStorageAdapter: 1 as const, name: ${JSON.stringify(name)}, driver, StorageUnavailableError };`,
		"",
	].join("\n");
}

test("storage.adapter names an adapter from an installed Atomic package (#3856)", async () => {
	const home = makeTempDirectory("storage-package-adapters-");
	const agentDir = join(home, "agent");
	const npmModules = join(agentDir, "npm", "node_modules");
	const npmPackage = join(npmModules, "@atomic-test", "storage-pkg");
	await writeFileEnsuringDir(
		join(agentDir, "settings.json"),
		JSON.stringify({ packages: ["npm:@atomic-test/storage-pkg@1.0.0", "../local-pkg"] }),
	);
	await writeFileEnsuringDir(
		join(npmPackage, "package.json"),
		JSON.stringify({
			name: "@atomic-test/storage-pkg",
			atomic: { storageAdapters: ["./adapters/first.ts", "./adapters/second.ts"] },
		}),
	);
	await writeFileEnsuringDir(join(npmPackage, "adapters", "first.ts"), adapterSource("first"));
	await writeFileEnsuringDir(join(npmPackage, "adapters", "second.ts"), adapterSource("second"));
	// Installed beside the package, as `atomic install` hoists the package's own dependencies.
	await writeFileEnsuringDir(
		join(npmModules, "fake-driver", "package.json"),
		JSON.stringify({ name: "fake-driver", type: "module", exports: "./index.js" }),
	);
	await writeFileEnsuringDir(join(npmModules, "fake-driver", "index.js"), 'export const driver = "npm";\n');
	await writeFileEnsuringDir(
		join(home, "local-pkg", "package.json"),
		JSON.stringify({ name: "local-storage-pkg", pi: { storageAdapters: ["./adapter.ts"] } }),
	);
	await writeFileEnsuringDir(join(home, "local-pkg", "adapter.ts"), adapterSource("local"));
	await writeFileEnsuringDir(
		join(home, "local-pkg", "node_modules", "fake-driver", "index.js"),
		'export const driver = "local";\n',
	);
	const load = async (module: string) =>
		(await loadStorageAdapter(module, { agentDir, domain: "sessions" })) as Awaited<
			ReturnType<typeof loadStorageAdapter>
		> & { readonly name: string; readonly driver: string; readonly StorageUnavailableError: object };
	try {
		const first = await load("@atomic-test/storage-pkg");
		assert.deepEqual([first.name, first.driver], ["first", "npm"]);
		assert.equal(first.StorageUnavailableError, StorageUnavailableError);
		const second = await load("@atomic-test/storage-pkg/second");
		assert.deepEqual([second.name, second.driver], ["second", "npm"]);
		const local = await load("local-storage-pkg");
		assert.deepEqual([local.name, local.driver], ["local", "local"]);
		for (const missing of ["@atomic-test/storage-pkg/third", "@atomic-test/not-installed"]) {
			await assert.rejects(load(missing), (error: Error) => {
				assert.ok(error instanceof StorageAdapterLoadError);
				assert.equal(error.module, missing);
				return true;
			});
		}
	} finally {
		removeTempDirectory(home);
	}
});

test("adapter imports @bastani/atomic/storage without a symlink (#3856)", async () => {
	const agentDir = makeTempDirectory("storage-host-modules-");
	await writeFileEnsuringDir(
		join(agentDir, "adapter", "index.ts"),
		[
			'import { StorageUnavailableError } from "@bastani/atomic/storage";',
			'import { failure } from "./failure.js";',
			"export default {",
			"\tatomicStorageAdapter: 1 as const,",
			"\tStorageUnavailableError,",
			"\tfailure,",
			"\tasync openDatabase(): Promise<never> {",
			"\t\tthrow failure;",
			"\t},",
			"};",
			"",
		].join("\n"),
	);
	await writeFileEnsuringDir(
		join(agentDir, "adapter", "failure.ts"),
		[
			'import { StorageUnavailableError } from "@bastani/atomic/storage";',
			'export const failure = new StorageUnavailableError({ adapter: "probe", location: "probe" }, "unreachable");',
			"",
		].join("\n"),
	);
	try {
		const context = { agentDir, domain: "sessions" } as const;
		const adapter = (await loadStorageAdapter("./adapter/index.ts", context)) as Awaited<
			ReturnType<typeof loadStorageAdapter>
		> & { readonly StorageUnavailableError: object; readonly failure: Error };
		assert.equal(adapter.StorageUnavailableError, StorageUnavailableError);
		assert.ok(adapter.failure instanceof StorageUnavailableError);
		await assert.rejects(
			new StorageProvider().openSessionStore({ kind: "adapter", module: "./adapter/index.ts" }, context),
			(error: Error) => error === adapter.failure,
		);
	} finally {
		removeTempDirectory(agentDir);
	}
});

test("secret files lose exactly one trailing line ending (#3856)", async () => {
	const home = makeTempDirectory("storage-secret-files-");
	const contents = {
		lf: " token\n",
		crlf: " token\r\n",
		double: " token\n\n",
		doubleCrlf: " token\r\n\r\n",
		lone: " token\r",
		none: " token ",
	};
	try {
		for (const [name, text] of Object.entries(contents)) await writeFileEnsuringDir(join(home, name), text);
		const options = await resolveAdapterOptions(
			{
				kind: "adapter",
				module: "unused",
				secrets: Object.fromEntries(Object.keys(contents).map((name) => [name, { file: name }])),
			},
			{ agentDir: join(home, "agent"), domain: "sessions" },
		);
		assert.deepEqual(options, {
			lf: " token",
			crlf: " token",
			double: " token\n",
			doubleCrlf: " token\r\n",
			lone: " token\r",
			none: " token ",
		});
		const isolatedAgent = join(home, "isolated-agent");
		for (const [name, text] of Object.entries(contents)) {
			await writeFileEnsuringDir(join(isolatedAgent, name), `isolated:${text}`);
		}
		const isolatedOptions = await resolveAdapterOptions(
			{
				kind: "adapter",
				module: "unused",
				secrets: Object.fromEntries(Object.keys(contents).map((name) => [name, { file: name }])),
			},
			{ agentDir: isolatedAgent, domain: "sessions" },
		);
		assert.deepEqual(isolatedOptions, {
			lf: "isolated: token",
			crlf: "isolated: token",
			double: "isolated: token\n",
			doubleCrlf: "isolated: token\r\n",
			lone: "isolated: token\r",
			none: "isolated: token ",
		});
	} finally {
		removeTempDirectory(home);
	}
});
