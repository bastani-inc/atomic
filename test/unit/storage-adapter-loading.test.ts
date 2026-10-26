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

function openJournalAdapterWithBuiltHost(env: Record<string, string | undefined>): void {
	const agentDir = makeTempDirectory("storage-workflows-host-module-");
	const adapterDir = makeTempDirectory("storage-workflows-adapter-");
	const adapterPath = join(adapterDir, "adapter.mjs");
	writeFileSync(
		adapterPath,
		[
			'import { MemoryRunJournal, SqlRunJournal, StaleLeaseError } from "@bastani/atomic/workflows";',
			"export default {",
			"\tatomicStorageAdapter: 1,",
			"\tasync openRunJournal() {",
			'\t\treturn Object.assign(new MemoryRunJournal({ adapter: "custom", location: ":memory:" }), {',
			"\t\t\tSqlRunJournal,",
			"\t\t\tStaleLeaseError,",
			"\t\t});",
			"\t},",
			"};",
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
			import * as workflows from '@bastani/atomic/workflows';
			const journal = await workflows.resolveRunJournal({
				agentDir: ${JSON.stringify(agentDir)},
				journal: { adapter: ${JSON.stringify(adapterPath)} },
			});
			assert.ok(journal instanceof workflows.MemoryRunJournal);
			assert.equal(journal.SqlRunJournal, workflows.SqlRunJournal);
			assert.equal(journal.StaleLeaseError, workflows.StaleLeaseError);
			await journal.close();
		`,
			],
			{ cwd: join(moduleDir(import.meta.url), "../../packages/coding-agent"), env: { ...process.env, ...env } },
		);
		assert.equal(result.exitCode, 0, result.stdout.toString() + result.stderr.toString());
	} finally {
		removeTempDirectory(agentDir);
		removeTempDirectory(adapterDir);
	}
}

test("journal adapters loaded by path share the running @bastani/atomic/workflows module (#3963)", () => {
	openJournalAdapterWithBuiltHost({ ATOMIC_BUNDLED_BUILD: undefined });
});

test("single-file builds give journal adapters the live @bastani/atomic/workflows module (#3963)", () => {
	openJournalAdapterWithBuiltHost({ ATOMIC_BUNDLED_BUILD: "1" });
});

function openJournalAfterSessionsLoadWithBuiltHost(env: Record<string, string | undefined>): void {
	const agentDir = makeTempDirectory("storage-shared-ts-adapter-");
	const adapterPath = join(agentDir, "adapter.ts");
	writeFileSync(
		adapterPath,
		[
			"export default {",
			"\tatomicStorageAdapter: 1 as const,",
			"\tasync openRunJournal() {",
			'\t\tconst workflows = await import("@bastani/atomic/workflows");',
			'\t\treturn new workflows.MemoryRunJournal({ adapter: "custom", location: ":memory:" });',
			"\t},",
			"};",
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
			import * as storage from '@bastani/atomic/storage';
			import * as workflows from '@bastani/atomic/workflows';
			const agentDir = ${JSON.stringify(agentDir)};
			await storage.loadStorageAdapter('./adapter.ts', { agentDir, domain: 'sessions' });
			const adapter = await storage.loadStorageAdapter(
				'./adapter.ts',
				{ agentDir, domain: 'journal' },
				{ '@bastani/atomic/workflows': workflows },
			);
			const journal = await adapter.openRunJournal();
			assert.ok(journal instanceof workflows.MemoryRunJournal);
			await journal.close();
		`,
			],
			{ cwd: join(moduleDir(import.meta.url), "../../packages/coding-agent"), env: { ...process.env, ...env } },
		);
		assert.equal(result.exitCode, 0, result.stdout.toString() + result.stderr.toString());
	} finally {
		removeTempDirectory(agentDir);
	}
}

test("a .ts adapter loaded for sessions first still gets the journal's host modules (#3973)", () => {
	openJournalAfterSessionsLoadWithBuiltHost({ ATOMIC_BUNDLED_BUILD: undefined });
});

test("single-file builds give a .ts adapter shared with sessions the journal's host modules (#3973)", () => {
	openJournalAfterSessionsLoadWithBuiltHost({ ATOMIC_BUNDLED_BUILD: "1" });
});

/** A `"type": "module"` adapter package whose own `.js` and `.mjs` files import `@bastani/atomic/workflows`. */
async function writeModuleTypeAdapter(adapterDir: string): Promise<void> {
	const which = [
		'import * as workflows from "@bastani/atomic/workflows";',
		'export const which = () => workflows.MARK ?? "node-resolved";',
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
			'\tasync openRunJournal() { return (await import("./inner.js")).which(); },',
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

test("modules a type:module adapter imports get the host's @bastani/atomic/workflows, not the npm copy (#3972)", async () => {
	const agentDir = makeTempDirectory("storage-module-type-adapter-");
	const adapterDir = join(agentDir, "adapter");
	await writeModuleTypeAdapter(adapterDir);
	// A resolvable npm copy, which a natively imported nested module would pick up instead of the host's.
	const npmCopy = join(adapterDir, "node_modules", "@bastani", "atomic");
	await writeFileEnsuringDir(
		join(npmCopy, "package.json"),
		JSON.stringify({ name: "@bastani/atomic", type: "module", exports: { "./workflows": "./workflows.js" } }),
	);
	await writeFileEnsuringDir(join(npmCopy, "workflows.js"), "export const MARK = undefined;\n");
	try {
		const adapter = (await loadStorageAdapter(
			join(adapterDir, "adapter.js"),
			{ agentDir, domain: "journal" },
			{ "@bastani/atomic/workflows": { MARK: "host" } },
		)) as Awaited<ReturnType<typeof loadStorageAdapter>> & {
			readonly which: () => string;
			openRunJournal(): Promise<string>;
			nested(): Promise<{ readonly which: () => string; readonly mjs: () => string }>;
		};
		assert.equal(await adapter.openRunJournal(), "host");
		assert.equal(adapter.which(), "host");
		const nested = await adapter.nested();
		assert.equal(nested.mjs(), "host");
		assert.equal(nested.which, adapter.which, "a module imported twice is evaluated once");
	} finally {
		removeTempDirectory(agentDir);
	}
});

/**
 * The type:module adapter loaded by the built `@bastani/atomic/storage`, with a resolvable installed copy of Atomic
 * beside it whose workflows module lacks the host's `MARK`.
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
			import * as workflows from '@bastani/atomic/workflows';
			const adapter = await storage.loadStorageAdapter(
				${JSON.stringify(join(adapterDir, "adapter.js"))},
				{ agentDir: ${JSON.stringify(agentDir)}, domain: 'journal' },
				{ '@bastani/atomic/workflows': { ...workflows, MARK: 'host' } },
			);
			assert.equal(await adapter.openRunJournal(), 'host');
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

test("built package hosts give a type:module adapter's nested modules the host workflows module (#3972)", async () => {
	await loadModuleTypeAdapterWithBuiltHost({ ATOMIC_BUNDLED_BUILD: undefined });
});

test("single-file builds give a type:module adapter's nested modules the host workflows module (#3972)", async () => {
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
	} finally {
		removeTempDirectory(home);
	}
});
