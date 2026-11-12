import assert from "node:assert/strict";
import { join } from "node:path";
import { DefaultResourceLoader } from "@bastani/atomic";
import { loadStorageAdapter, StorageAdapterLoadError, StorageProvider } from "@bastani/atomic/storage";
import { afterEach, test, vi } from "vitest";
import {
	addHostStorageAdapter,
	HOST_STORAGE_ADAPTERS_ENV,
} from "../../packages/coding-agent/src/core/storage/host-adapters.js";
import { collectStorageStatus } from "../../packages/coding-agent/src/core/storage/storage-status.js";
import { createChildProcessEnvironment } from "../../packages/coding-agent/src/utils/child-process.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { makeTempDirectory, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";

afterEach(() => {
	vi.unstubAllEnvs();
});

/** An adapter that reports its name and keeps its tables in the SQLite file at `options.path`. */
function adapterSource(name: string): string {
	return [
		'import { openNodeSqliteDatabase } from "@bastani/atomic/storage";',
		"export default {",
		"\tatomicStorageAdapter: 1 as const,",
		`\tname: ${JSON.stringify(name)},`,
		"\topenDatabase: (options: { readonly path?: string }) => openNodeSqliteDatabase(String(options.path)),",
		"};",
		"",
	].join("\n");
}

async function writePackage(root: string, name: string, adapters: Readonly<Record<string, string>>): Promise<void> {
	await writeFileEnsuringDir(
		join(root, "package.json"),
		JSON.stringify({ name, atomic: { storageAdapters: Object.keys(adapters) } }),
	);
	for (const [path, adapter] of Object.entries(adapters))
		await writeFileEnsuringDir(join(root, path), adapterSource(adapter));
}

test("storage.adapter names an adapter from a package the host loaded through the SDK, ahead of settings packages (#4678)", async () => {
	const home = makeTempDirectory("storage-host-package-adapters-");
	const agentDir = join(home, "agent");
	const installed = join(agentDir, "npm", "node_modules", "@atomic-test");
	try {
		await writeFileEnsuringDir(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: ["npm:@atomic-test/host-app@1.0.0", "npm:@atomic-test/settings-only@1.0.0"] }),
		);
		await writePackage(join(installed, "host-app"), "@atomic-test/host-app", { "./adapter.ts": "installed" });
		await writePackage(join(installed, "settings-only"), "@atomic-test/settings-only", {
			"./adapter.ts": "settings",
		});
		await writePackage(join(home, "app"), "@atomic-test/host-app", {
			"./storage/first.ts": "first",
			"./storage/second.ts": "second",
		});
		await writeFileEnsuringDir(join(home, "absolute.ts"), adapterSource("absolute"));
		const load = async (module: string) =>
			(
				(await loadStorageAdapter(module, { agentDir, domain: "sessions" })) as Awaited<
					ReturnType<typeof loadStorageAdapter>
				> & { readonly name: string }
			).name;

		assert.equal(await load("@atomic-test/host-app"), "installed", "before the host loads its package");
		// A relative extension path resolves against the loader's working directory.
		new DefaultResourceLoader({ cwd: home, agentDir, additionalExtensionPaths: ["./app"] });

		assert.equal(await load("@atomic-test/host-app"), "first");
		assert.equal(await load("@atomic-test/host-app/second"), "second");
		assert.equal(await load("@atomic-test/settings-only"), "settings");
		assert.equal(await load(join(home, "absolute.ts")), "absolute");
		for (const missing of ["@atomic-test/host-app/third", "@atomic-test/not-loaded"]) {
			await assert.rejects(load(missing), (error: Error) => {
				assert.ok(error instanceof StorageAdapterLoadError);
				assert.equal(error.module, missing);
				return true;
			});
		}

		// Sessions and the workflow journal open through the name, and `atomic storage status` reports the module.
		const database = join(home, "store.sqlite");
		const selection = { adapter: "@atomic-test/host-app", options: { path: database } };
		const sessions = await new StorageProvider().openSessionStore(
			{ kind: "adapter", module: selection.adapter, options: selection.options },
			{ agentDir, domain: "sessions" },
		);
		await sessions.close();
		const journal = await resolveRunJournal({ agentDir, journal: selection });
		await journal.close();
		vi.stubEnv("ATOMIC_SESSIONS_STORAGE", JSON.stringify(selection));
		vi.stubEnv("ATOMIC_WORKFLOWS_JOURNAL", JSON.stringify(selection));
		const status = await collectStorageStatus({ cwd: home, agentDir, probe: true });
		for (const domain of ["sessions", "journal"] as const) {
			const entry = status.domains.find((candidate) => candidate.domain === domain);
			assert.equal(entry?.source, domain === "sessions" ? "ATOMIC_SESSIONS_STORAGE" : "ATOMIC_WORKFLOWS_JOURNAL");
			assert.deepEqual(entry?.probe?.adapter, {
				module: "@atomic-test/host-app",
				loaded: true,
				detail: `from ${join(home, "app", "storage", "first.ts")}`,
			});
			assert.equal(entry?.probe?.connection.status, "ok", JSON.stringify(entry));
		}
	} finally {
		removeTempDirectory(home);
	}
});

test("a process started with its own adapter map, or none, keeps that choice over the host's adapters (#4678)", () => {
	addHostStorageAdapter("@example/child-env-4678", "/opt/host/adapter.js");
	const hostMap = (env: NodeJS.ProcessEnv) =>
		JSON.parse(env[HOST_STORAGE_ADAPTERS_ENV] ?? "{}") as Record<string, string>;

	assert.equal(hostMap(createChildProcessEnvironment())["@example/child-env-4678"], "/opt/host/adapter.js");
	assert.equal(
		hostMap(createChildProcessEnvironment(undefined, { ...process.env }))["@example/child-env-4678"],
		"/opt/host/adapter.js",
		"an unchanged copy of this environment still passes the host's adapters",
	);

	const replaced = JSON.stringify({ "@example/child-env-4678": "/opt/caller/adapter.js" });
	assert.equal(
		createChildProcessEnvironment(undefined, { ...process.env, [HOST_STORAGE_ADAPTERS_ENV]: replaced })[
			HOST_STORAGE_ADAPTERS_ENV
		],
		replaced,
	);
	assert.equal(
		createChildProcessEnvironment({ [HOST_STORAGE_ADAPTERS_ENV]: replaced })[HOST_STORAGE_ADAPTERS_ENV],
		replaced,
	);

	assert.equal(
		createChildProcessEnvironment(undefined, { ...process.env, [HOST_STORAGE_ADAPTERS_ENV]: "" })[
			HOST_STORAGE_ADAPTERS_ENV
		],
		"",
	);
	const removed: NodeJS.ProcessEnv = { ...process.env, [HOST_STORAGE_ADAPTERS_ENV]: "" };
	delete removed[HOST_STORAGE_ADAPTERS_ENV];
	vi.stubEnv(HOST_STORAGE_ADAPTERS_ENV, "{}");
	assert.equal(createChildProcessEnvironment(undefined, removed)[HOST_STORAGE_ADAPTERS_ENV], undefined);
});
