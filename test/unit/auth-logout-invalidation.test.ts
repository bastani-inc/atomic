import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client.ts";
import { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import { formatLogoutStatus } from "../../packages/coding-agent/src/modes/interactive/interactive-auth-routing.ts";
import { AuthStorage, type AuthStorageData } from "../../packages/coding-agent/src/core/auth-storage.ts";

function readAuth(path: string): AuthStorageData {
	return JSON.parse(readFileSync(path, "utf8")) as AuthStorageData;
}

describe("logout credential invalidation (#1919)", () => {
	for (const platform of ["linux", "darwin", "win32"] as const) {
		test(`removes the provider from primary and legacy auth files on ${platform}`, async () => {
			const directory = mkdtempSync(join(tmpdir(), `atomic-logout-${platform}-`));
			const primary = join(directory, ".atomic", "agent", "auth.json");
			const legacy = join(directory, ".pi", "agent", "auth.json");
			await Bun.write(primary, JSON.stringify({
				"github-copilot": { type: "oauth", access: "primary", refresh: "refresh", expires: Date.now() + 60_000 },
				openai: { type: "api_key", key: "primary-openai" },
			}, null, 2));
			await Bun.write(legacy, JSON.stringify({
				"github-copilot": { type: "oauth", access: "legacy", refresh: "refresh", expires: Date.now() + 60_000 },
				anthropic: { type: "api_key", key: "legacy-anthropic" },
			}, null, 2));

			try {
				const storage = AuthStorage.create([primary, legacy]);
				assert.equal(storage.has("github-copilot"), true);
				await storage.logoutAsync("github-copilot");
				assert.equal(storage.has("github-copilot"), false);

				assert.deepEqual(readAuth(primary), {
					openai: { type: "api_key", key: "primary-openai" },
				});
				assert.deepEqual(readAuth(legacy), {
					anthropic: { type: "api_key", key: "legacy-anthropic" },
				});

				const restarted = AuthStorage.create([primary, legacy]);
				assert.equal(restarted.has("github-copilot"), false);
				assert.deepEqual(restarted.list(), ["anthropic", "openai"]);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		});
	}

	test("holds the primary lock until every credential source is cleared", async () => {
		const directory = mkdtempSync(join(tmpdir(), "atomic-logout-locks-"));
		const primary = join(directory, "a-primary-auth.json");
		const legacy = join(directory, "z-legacy-auth.json");
		await Bun.write(primary, JSON.stringify({ "github-copilot": { type: "api_key", key: "primary" } }));
		await Bun.write(legacy, JSON.stringify({ "github-copilot": { type: "api_key", key: "legacy" } }));
		const releaseLegacy = await lockfile.lock(legacy, { realpath: false });
		const logout = AuthStorage.create([primary, legacy]).logoutAsync("github-copilot");

		try {
			for (let attempt = 0; attempt < 50 && !existsSync(`${primary}.lock`); attempt += 1) await Bun.sleep(10);
			assert.equal(existsSync(`${primary}.lock`), true, "logout did not acquire the primary source lock");
			const competingLock = await lockfile.lock(primary, { realpath: false, retries: 0 }).then(
				(release) => ({ release }),
				(error: Error & { code?: string }) => ({ error }),
			);
			if ("release" in competingLock) {
				await competingLock.release();
				assert.fail("a competing writer acquired primary before legacy deletion completed");
			}
			assert.equal(competingLock.error.code, "ELOCKED");
		} finally {
			await releaseLegacy();
			await logout;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("the engine child drops stored auth, its model projection, and prompt access immediately", async () => {
		const directory = mkdtempSync(join(tmpdir(), "atomic-engine-logout-"));
		const authPath = join(directory, "auth.json");
		await Bun.write(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "controlled-fake-key" } }));
		const client = new RpcClient({
			cliPath: join(import.meta.dir, "../../packages/coding-agent/src/cli.ts"),
			cwd: join(import.meta.dir, "../.."),
			runtimeExecutable: process.execPath,
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			env: {
				ATOMIC_CODING_AGENT_DIR: directory,
				ANTHROPIC_API_KEY: "",
				ANTHROPIC_OAUTH_TOKEN: "",
			},
			args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--offline"],
			interactiveEngine: { onDiagnostic: () => {} },
		});

		try {
			await client.start();
			await client.waitForInteractiveEngineBound();
			assert.ok((await client.getAvailableModels()).some((model) => model.provider === "anthropic"));

			const result = await client.logoutProvider("anthropic");

			assert.equal(Object.getPrototypeOf(result), Object.prototype);
			assert.deepEqual(result.authStatus, { configured: false });
			assert.equal(result.models.some((model) => model.provider === "anthropic"), false);
			assert.deepEqual(readAuth(authPath), {});
			assert.equal((await client.getState()).model?.provider, "anthropic");
			await assert.rejects(
				client.requestInternal<void>({ type: "prompt", message: "This must fail before provider transport" }),
				/No API key found for anthropic/,
			);
		} finally {
			await client.stop();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("the Linux Copilot regression clears the authoritative child and stays logged out after restart", async () => {
		const directory = mkdtempSync(join(tmpdir(), "atomic-copilot-logout-linux-"));
		const authPath = join(directory, "auth.json");
		await Bun.write(authPath, JSON.stringify({
			"github-copilot": { type: "oauth", access: "controlled-fake-token", refresh: "refresh", expires: Date.now() + 60_000 },
		}));
		const makeClient = () => new RpcClient({
			cliPath: join(import.meta.dir, "../../packages/coding-agent/src/cli.ts"),
			cwd: join(import.meta.dir, "../.."),
			runtimeExecutable: process.execPath,
			provider: "github-copilot",
			model: "claude-haiku-4.5",
			env: { ATOMIC_CODING_AGENT_DIR: directory, COPILOT_GITHUB_TOKEN: "" },
			args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--offline"],
			interactiveEngine: { onDiagnostic: () => {} },
		});
		const client = makeClient();

		try {
			await client.start();
			await client.waitForInteractiveEngineBound();
			assert.ok((await client.getAvailableModels()).some((model) => model.provider === "github-copilot"));

			const result = await client.logoutProvider("github-copilot");

			assert.equal(result.provider, "github-copilot");
			assert.deepEqual(result.authStatus, { configured: false });
			assert.equal(result.models.some((model) => model.provider === "github-copilot"), false);
			assert.equal((await client.getState()).model?.provider, "github-copilot");
			await assert.rejects(
				client.requestInternal<void>({ type: "prompt", message: "Do not contact Copilot" }),
				/No API key found for github-copilot/,
			);
			await client.stop();

			const restarted = makeClient();
			try {
				await restarted.start();
				await restarted.waitForInteractiveEngineBound();
				assert.equal((await restarted.getAvailableModels()).some((model) => model.provider === "github-copilot"), false);
			} finally {
				await restarted.stop();
			}
		} finally {
			await client.stop();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("logout reports environment authentication that it cannot clear", async () => {
		const directory = mkdtempSync(join(tmpdir(), "atomic-environment-logout-"));
		const authPath = join(directory, "auth.json");
		await Bun.write(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "stored-key" } }));
		const client = new RpcClient({
			cliPath: join(import.meta.dir, "../../packages/coding-agent/src/cli.ts"),
			cwd: join(import.meta.dir, "../.."),
			runtimeExecutable: process.execPath,
			env: { ATOMIC_CODING_AGENT_DIR: directory, ANTHROPIC_API_KEY: "environment-key", ANTHROPIC_OAUTH_TOKEN: "" },
			args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--offline"],
			interactiveEngine: { onDiagnostic: () => {} },
		});

		try {
			await client.start();
			await client.waitForInteractiveEngineBound();
			const result = await client.logoutProvider("anthropic");
			assert.deepEqual(result.authStatus, {
				configured: false,
				source: "environment",
				label: "ANTHROPIC_API_KEY",
			});
			assert.equal(result.models.some((model) => model.provider === "anthropic"), true);
			assert.deepEqual(readAuth(authPath), {});
		} finally {
			await client.stop();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("the isolated host applies the child logout catalog and clears its local credential view", async () => {
		const model = { provider: "github-copilot", id: "claude-haiku-4.5" };
		const authStorage = AuthStorage.inMemory({
			"github-copilot": { type: "api_key", key: "controlled-fake-key" },
		});
		const registry = {
			authStorage,
			getAvailable: () => [model],
			find: () => model,
			hasConfiguredAuth: () => true,
		};
		const session = {
			modelRegistry: registry,
			agent: {
				state: { model, thinkingLevel: "medium", messages: [] },
				steeringMode: "all",
				followUpMode: "all",
			},
			scopedModels: [],
			sessionManager: {},
		};
		const client = {
			onEvent: () => () => {},
			getCommands: async () => [],
			getState: async () => ({
				model,
				thinkingLevel: "medium",
				isStreaming: false,
				isCompacting: false,
				steeringMode: "all",
				followUpMode: "all",
				sessionId: "host-projection",
				autoCompactionEnabled: true,
				messageCount: 0,
				pendingMessageCount: 0,
			}),
			requestInternal: async () => ({ models: [model], scopedModels: [], customAuthProviders: [] }),
			logoutProvider: async () => ({
				provider: "github-copilot",
				authStatus: { configured: false },
				models: [],
				scopedModels: [],
			}),
		};
		const runtime = new IsolatedInteractiveRuntime(
			{ session, services: {}, diagnostics: [] } as never,
			async () => { throw new Error("not used"); },
			client as never,
		);

		await runtime.initializeFromEngine();
		assert.deepEqual(await runtime.session.modelRegistry.getAvailable(), [model]);
		await runtime.logoutProvider("github-copilot");
		assert.deepEqual(await runtime.session.modelRegistry.getAvailable(), []);
		assert.equal(authStorage.has("github-copilot"), false);
	});

	test("logout status names remaining environment auth without changing ordinary success text", () => {
		assert.equal(
			formatLogoutStatus("GitHub Copilot", "oauth", { configured: false }),
			"Logged out of GitHub Copilot",
		);
		assert.equal(
			formatLogoutStatus("GitHub Copilot", "oauth", {
				configured: false,
				source: "environment",
				label: "COPILOT_GITHUB_TOKEN",
			}),
			"Logged out of GitHub Copilot. Authentication remains active through COPILOT_GITHUB_TOKEN.",
		);
	});

});
