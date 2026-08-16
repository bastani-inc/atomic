import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Credential, CredentialInfo, CredentialStore, ModelsStore, ModelsStoreEntry } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, test } from "vitest";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { REMOTE_CATALOG_REFRESH_INTERVAL_MS } from "../../packages/coding-agent/src/core/remote-catalog-provider.js";
import { moduleDir } from "../helpers/runtime.js";

const repoRoot = resolve(moduleDir(import.meta.url), "../..");
const sdkDocs = readFileSync(join(repoRoot, "packages/coding-agent/docs/sdk.md"), "utf8");
const modelRuntimeSource = readFileSync(join(repoRoot, "packages/coding-agent/src/core/model-runtime.ts"), "utf8");

describe("ModelRuntime catalog SDK documentation", () => {
	test("documents every catalog option the implementation ships", () => {
		for (const option of ["allowModelNetwork", "modelRefreshTimeoutMs", "modelsStorePath", "modelsStore"]) {
			assert.ok(sdkDocs.includes(option), `docs/sdk.md must document ${option}`);
		}
		assert.ok(
			sdkDocs.includes("(see [Model catalog persistence and refresh]"),
			"the quick-start create() sentence links the catalog section",
		);
		assert.match(sdkDocs, /refresh\(\{ allowNetwork: true, force: true, signal \}\)/u);
	});

	test("documented modelRefreshTimeoutMs default matches the implementation", () => {
		const documented = /`modelRefreshTimeoutMs` \(default `(\d[\d_]*)`\)/u.exec(sdkDocs);
		assert.ok(documented, "docs/sdk.md states the modelRefreshTimeoutMs default");
		const implemented = /modelRefreshTimeoutMs\s*\?\?\s*(\d[\d_]*)/u.exec(modelRuntimeSource);
		assert.ok(implemented, "ModelRuntime.create defaults modelRefreshTimeoutMs inline");
		assert.equal(
			documented[1],
			implemented[1],
			"the default printed in docs/sdk.md must equal the default in model-runtime.ts",
		);
	});

	test("documented allowModelNetwork default of false matches the implementation", () => {
		assert.match(sdkDocs, /`allowModelNetwork` \(default `false`\)/u);
		// Only an explicit true opts in; every other value — including omitted — stays offline.
		assert.match(modelRuntimeSource, /options\.allowModelNetwork === true/u);
	});

	test("documented four-hour throttle matches REMOTE_CATALOG_REFRESH_INTERVAL_MS", () => {
		assert.equal(REMOTE_CATALOG_REFRESH_INTERVAL_MS, 4 * 60 * 60 * 1000);
		assert.match(sdkDocs, /throttled to once\s+per provider every four hours/u);
	});

	test("documented models-store location matches the implementation", () => {
		assert.match(modelRuntimeSource, /join\(dirname\(modelsPath\), "models-store\.json"\)/u);
		assert.match(sdkDocs, /`models-store\.json` next to `models\.json`/u);
		assert.match(sdkDocs, /~\/\.atomic\/agent\/models-store\.json/u);
	});

	test("documented offline switch matches the implementation", () => {
		assert.match(sdkDocs, /`ATOMIC_OFFLINE` \(legacy alias `PI_OFFLINE`\)/u);
		assert.match(modelRuntimeSource, /!isOfflineModeEnabled\(\)/u);
	});
});

/** One api-key credential so the anthropic provider resolves auth and runs its network phase. */
class StaticCredentialStore implements CredentialStore {
	async read(providerId: string): Promise<Credential | undefined> {
		return providerId === "anthropic" ? { type: "api_key", key: "sk-docs-test" } : undefined;
	}
	async list(): Promise<readonly CredentialInfo[]> {
		return [{ providerId: "anthropic", type: "api_key" }];
	}
	async modify(): Promise<Credential | undefined> {
		return undefined;
	}
	async delete(): Promise<void> {}
}

class RecordingModelsStore implements ModelsStore {
	readonly writes: Array<{ providerId: string; entry: ModelsStoreEntry }> = [];
	async read(): Promise<ModelsStoreEntry | undefined> {
		return undefined;
	}
	async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
		this.writes.push({ providerId, entry });
	}
	async delete(): Promise<void> {}
}

describe("ModelRuntime catalog behavior behind the documentation", () => {
	let requests = 0;
	let server: http.Server;
	let baseUrl: string;

	beforeAll(async () => {
		server = http.createServer((_req, res) => {
			requests += 1;
			res.writeHead(404, { "content-type": "application/json" });
			res.end("{}");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	test("create() stays offline by default, persists beside models.json when opted in, throttles, and forces", async () => {
		const offlineDir = mkdtempSync(join(tmpdir(), "atomic-catalog-default-"));
		const onlineDir = mkdtempSync(join(tmpdir(), "atomic-catalog-optin-"));
		try {
			const beforeCreate = requests;
			await ModelRuntime.create({
				credentials: new StaticCredentialStore(),
				modelsPath: join(offlineDir, "models.json"),
				catalogBaseUrl: baseUrl,
			});
			assert.equal(
				requests,
				beforeCreate,
				"create() without allowModelNetwork contacts no catalog even with credentials present",
			);

			const runtime = await ModelRuntime.create({
				credentials: new StaticCredentialStore(),
				modelsPath: join(onlineDir, "models.json"),
				catalogBaseUrl: baseUrl,
				allowModelNetwork: true,
			});
			assert.ok(requests > beforeCreate, "allowModelNetwork: true runs the create-time network refresh");
			assert.ok(
				existsSync(join(onlineDir, "models-store.json")),
				"the default store lands at models-store.json beside models.json",
			);
			const afterOptIn = requests;

			await ModelRuntime.create({
				credentials: new StaticCredentialStore(),
				modelsPath: join(onlineDir, "models.json"),
				catalogBaseUrl: baseUrl,
				allowModelNetwork: true,
			});
			assert.equal(
				requests,
				afterOptIn,
				"a second create within the four-hour window restores from the store without network",
			);

			const forced = await runtime.refresh({ allowNetwork: true, force: true });
			assert.equal(forced.aborted, false);
			assert.equal(forced.errors.size, 0);
			assert.ok(requests > afterOptIn, "force: true bypasses the four-hour throttle");
		} finally {
			rmSync(offlineDir, { recursive: true, force: true });
			rmSync(onlineDir, { recursive: true, force: true });
		}
	});

	test("modelsStorePath relocates the store and modelsStore replaces persistence entirely", async () => {
		const overridden = mkdtempSync(join(tmpdir(), "atomic-catalog-store-path-"));
		const injected = mkdtempSync(join(tmpdir(), "atomic-catalog-store-injected-"));
		try {
			await ModelRuntime.create({
				credentials: new StaticCredentialStore(),
				modelsPath: join(overridden, "models.json"),
				modelsStorePath: join(overridden, "elsewhere.json"),
				catalogBaseUrl: baseUrl,
				allowModelNetwork: true,
			});
			assert.ok(existsSync(join(overridden, "elsewhere.json")), "the store follows modelsStorePath");
			assert.equal(
				existsSync(join(overridden, "models-store.json")),
				false,
				"the default store file is not created when modelsStorePath is set",
			);

			const store = new RecordingModelsStore();
			await ModelRuntime.create({
				credentials: new StaticCredentialStore(),
				modelsPath: join(injected, "models.json"),
				modelsStore: store,
				catalogBaseUrl: baseUrl,
				allowModelNetwork: true,
			});
			assert.ok(store.writes.length > 0, "an injected modelsStore receives every persisted catalog");
			assert.ok(
				!existsSync(join(injected, "models-store.json")) && !existsSync(join(injected, "elsewhere.json")),
				"no store file is written when modelsStore is injected",
			);
		} finally {
			rmSync(overridden, { recursive: true, force: true });
			rmSync(injected, { recursive: true, force: true });
		}
	});

	test("ATOMIC_OFFLINE disables the create-time network refresh even with allowModelNetwork", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-catalog-offline-"));
		const before = requests;
		process.env.ATOMIC_OFFLINE = "1";
		try {
			await ModelRuntime.create({
				credentials: new StaticCredentialStore(),
				modelsPath: join(dir, "models.json"),
				catalogBaseUrl: baseUrl,
				allowModelNetwork: true,
			});
			assert.equal(requests, before, "no catalog request leaves an offline runtime");
		} finally {
			delete process.env.ATOMIC_OFFLINE;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
