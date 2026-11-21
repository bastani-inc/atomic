import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getModel } from "@bastani/atomic-ai/compat";
import { afterEach, describe, it, vi } from "vitest";
import { getExtensionTranspileCacheDir } from "../src/config.js";
import type { AgentSession } from "../src/core/agent-session.js";
import { extensionLoaderTestHooks } from "../src/core/extensions/loader-virtual-modules.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

/** Background pruning of stale cache versions is asynchronous; this bounds the wait for it. */
const PRUNE_WAIT_MS = 10_000;
/** A cache directory nothing has used for longer than a week is removed. */
const UNUSED_FOR_EIGHT_DAYS = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

/** A cache directory of another version or installation, last used at `usedAt`. */
function otherCacheDir(agentDir: string, parent: "transpile" | "jiti", name: string, usedAt?: Date): string {
	const dir = path.join(agentDir, "cache", parent, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "entry.ts.0123.mjs"), "[]\nexport {};\n");
	if (usedAt) fs.utimesSync(dir, usedAt, usedAt);
	return dir;
}

const roots: string[] = [];
const sessions: AgentSession[] = [];

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

/** A TypeScript extension whose `./dep.js` import of `dep.ts` goes through the source-specifier transform. */
function writeExtension(dir: string, name = "entry.ts"): string {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "dep.ts"), "export const value: string = 'cached';\n");
	const entry = path.join(dir, name);
	fs.writeFileSync(
		entry,
		"import { value } from './dep.js';\nexport default function (_pi: object): string {\n\treturn value;\n}\n",
	);
	return entry;
}

/** An existing agent directory; the cache is only ever created below one that already exists. */
function existingAgentDir(prefix: string): string {
	const dir = path.join(tempDir(prefix), "agent");
	fs.mkdirSync(dir);
	return dir;
}

function cachedEntries(agentDir: string): string[] {
	const cacheDir = getExtensionTranspileCacheDir(agentDir);
	if (!fs.existsSync(cacheDir)) return [];
	return fs.readdirSync(cacheDir).filter((entry) => /\.(c|m)js$/.test(entry));
}

async function loadUnderCurrentAgentDir(entry: string): Promise<void> {
	const factory = await extensionLoaderTestHooks.loadTransformedExtensionModule(entry);
	assert.equal(typeof factory, "function", "extension factory did not load");
}

afterEach(async () => {
	vi.unstubAllEnvs();
	try {
		for (const session of sessions.splice(0)) await session.dispose();
	} finally {
		for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("extension transpile cache follows the agent directory", () => {
	it("moves to the next agent directory and leaves a removed one removed (#4728)", async () => {
		const agentA = existingAgentDir("atomic-4728-a-");
		const agentB = existingAgentDir("atomic-4728-b-");
		const entry = writeExtension(tempDir("atomic-4728-ext-"));

		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentA);
		await loadUnderCurrentAgentDir(entry);
		assert.ok(cachedEntries(agentA).length > 0, "the first agent directory must receive the cache");

		fs.rmSync(agentA, { recursive: true, force: true });
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentB);
		fs.writeFileSync(path.join(path.dirname(entry), "dep.ts"), "export const value: string = 'changed';\n");
		await loadUnderCurrentAgentDir(entry);

		assert.equal(fs.existsSync(agentA), false, "a removed agent directory must not be recreated");
		assert.ok(cachedEntries(agentB).length > 0, "the agent directory in effect must receive the cache");
		assert.ok(
			await extensionLoaderTestHooks.readExtensionGraphManifest(entry, agentB),
			"the graph manifest must follow the agent directory",
		);
	});

	it("does not recreate a removed agent directory when loading again under it (#4728)", async () => {
		const agentDir = existingAgentDir("atomic-4728-removed-");
		const entry = writeExtension(tempDir("atomic-4728-ext-"));

		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
		await loadUnderCurrentAgentDir(entry);
		fs.rmSync(agentDir, { recursive: true, force: true });
		fs.writeFileSync(path.join(path.dirname(entry), "dep.ts"), "export const value: string = 'uncached';\n");

		const factory = await extensionLoaderTestHooks.loadTransformedExtensionModule(entry);

		assert.equal((factory as unknown as () => string)(), "uncached", "the load must still evaluate the new source");
		assert.equal(fs.existsSync(agentDir), false, "a removed agent directory must not be recreated");
	});

	it("never creates a missing agent directory, and still loads without a cache (#4728)", async () => {
		const agentDir = path.join(tempDir("atomic-4728-missing-"), "agent");
		const entry = writeExtension(tempDir("atomic-4728-ext-"));

		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
		const factory = await extensionLoaderTestHooks.loadTransformedExtensionModule(entry);

		assert.equal((factory as unknown as () => string)(), "cached", "the load must still evaluate the source");
		assert.equal(fs.existsSync(agentDir), false, "a missing agent directory must not be created");
	});

	it("does not recreate a removed agent directory whose first cache setup failed (#4728)", async () => {
		const agentDir = path.join(tempDir("atomic-4728-blocked-"), "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "cache"), "not a directory");
		const entry = writeExtension(tempDir("atomic-4728-ext-"));

		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
		await loadUnderCurrentAgentDir(entry);
		fs.rmSync(agentDir, { recursive: true, force: true });
		await loadUnderCurrentAgentDir(entry);

		assert.equal(fs.existsSync(agentDir), false, "a removed agent directory must not be recreated");
	});

	it("prunes stale cache versions under each agent directory (#4728)", async () => {
		const agentDirs = [
			path.join(tempDir("atomic-4728-prune-a-"), "agent"),
			path.join(tempDir("atomic-4728-prune-b-"), "agent"),
		];
		const staleDirs = agentDirs.flatMap((agentDir) => [
			otherCacheDir(agentDir, "transpile", "0.0.1+ts-source-specifiers", UNUSED_FOR_EIGHT_DAYS),
			otherCacheDir(agentDir, "jiti", "0.0.1+ts-source-specifiers", UNUSED_FOR_EIGHT_DAYS),
		]);
		const entry = writeExtension(tempDir("atomic-4728-ext-"));

		for (const agentDir of agentDirs) {
			vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
			await loadUnderCurrentAgentDir(entry);
		}

		const deadline = Date.now() + PRUNE_WAIT_MS;
		while (staleDirs.some((staleDir) => fs.existsSync(staleDir)) && Date.now() < deadline) await delay(20);
		assert.deepEqual(
			staleDirs.filter((staleDir) => fs.existsSync(staleDir)),
			[],
			"each agent directory must have its stale cache versions pruned",
		);
		for (const agentDir of agentDirs) {
			assert.ok(fs.existsSync(getExtensionTranspileCacheDir(agentDir)), "the current cache version must remain");
		}
	});

	it("keeps the caches that another installation or version in the same agent directory uses", async () => {
		const agentDir = existingAgentDir("atomic-shared-agent-");
		const inUse = [
			otherCacheDir(agentDir, "transpile", "0.10.9+ts-source-specifiers"),
			otherCacheDir(
				agentDir,
				"transpile",
				"0.0.1+ts-source-specifiers",
				new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
			),
			otherCacheDir(agentDir, "jiti", "0.10.3+ts-source-specifiers"),
		];
		const unused = otherCacheDir(agentDir, "transpile", "0.0.2+ts-source-specifiers", UNUSED_FOR_EIGHT_DAYS);
		const entry = writeExtension(tempDir("atomic-shared-ext-"));

		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
		await loadUnderCurrentAgentDir(entry);
		await extensionLoaderTestHooks.transpileCachePrune(agentDir);

		assert.deepEqual(
			inUse.filter((dir) => !fs.existsSync(dir)),
			[],
			"a cache used within the last week must remain",
		);
		assert.equal(fs.existsSync(unused), false, "a cache unused for over a week must be removed");
	});

	it("removes only unused version caches, never other files beside them", async () => {
		const agentDir = existingAgentDir("atomic-foreign-cache-");
		const foreign = [
			path.join(agentDir, "cache", "transpile", "unrelated-extension"),
			path.join(agentDir, "cache", "jiti", "notes"),
		];
		for (const dir of foreign) {
			fs.mkdirSync(dir, { recursive: true });
			fs.utimesSync(dir, UNUSED_FOR_EIGHT_DAYS, UNUSED_FOR_EIGHT_DAYS);
		}
		const foreignFile = path.join(agentDir, "cache", "transpile", "0.0.3+ts-source-specifiers");
		fs.writeFileSync(foreignFile, "not a cache directory");
		fs.utimesSync(foreignFile, UNUSED_FOR_EIGHT_DAYS, UNUSED_FOR_EIGHT_DAYS);
		const unused = otherCacheDir(agentDir, "jiti", "0.9.1", UNUSED_FOR_EIGHT_DAYS);
		const entry = writeExtension(tempDir("atomic-foreign-cache-ext-"));

		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
		await loadUnderCurrentAgentDir(entry);
		await extensionLoaderTestHooks.transpileCachePrune(agentDir);

		assert.deepEqual(
			[...foreign, foreignFile].filter((file) => !fs.existsSync(file)),
			[],
			"only version cache directories may be removed",
		);
		assert.equal(fs.existsSync(unused), false, "an unused version cache must be removed");
	});

	it("a module loaded from the cache runs exactly as it did when it was compiled", async () => {
		const agentDir = existingAgentDir("atomic-cache-strict-");
		const entry = path.join(tempDir("atomic-cache-strict-ext-"), "entry.ts");
		fs.writeFileSync(
			entry,
			`export default function (): string[] {
	const observed: string[] = [];
	try {
		// @ts-expect-error -- an undeclared name, which strict mode refuses to create
		atomicCacheStrictProbe = 1;
		observed.push("assigned");
	} catch (error) {
		observed.push(error instanceof ReferenceError ? "ReferenceError" : String(error));
	}
	observed.push(typeof (function (this: unknown) {
		return this;
	})());
	observed.push(new Error("where").stack?.split("\\n").find((frame) => frame.includes("entry.ts")) ?? "no frame");
	return observed;
}
`,
		);
		const cacheDir = path.resolve(getExtensionTranspileCacheDir(agentDir));
		const run = async (): Promise<string[]> => {
			const factory = await extensionLoaderTestHooks.loadExtensionModuleTransformed(entry, undefined, agentDir);
			return (factory as unknown as () => Promise<string[]>)();
		};
		const probe = globalThis as { atomicCacheStrictProbe?: number };

		const compiled = await run();
		const writes = vi.spyOn(fs.promises, "writeFile");
		let cached: string[];
		try {
			cached = await run();
			assert.deepEqual(
				writes.mock.calls.filter(([file]) => path.dirname(path.resolve(String(file))) === cacheDir),
				[],
				"the second load must use the stored transform",
			);
		} finally {
			writes.mockRestore();
			delete probe.atomicCacheStrictProbe;
		}

		assert.deepEqual(
			compiled.slice(0, 2),
			["ReferenceError", "undefined"],
			"the compiled module must run in strict mode",
		);
		assert.match(compiled[2], /entry\.ts:13:/, "the compiled module must keep its source lines");
		assert.deepEqual(cached, compiled);
	});

	it("marks the cache it uses as used, so other versions keep it", async () => {
		const entry = writeExtension(tempDir("atomic-mark-used-ext-"));
		const warmAgentDir = existingAgentDir("atomic-mark-used-warm-");
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", warmAgentDir);
		await loadUnderCurrentAgentDir(entry);
		// A cache that already holds every transform the load needs, so the load writes nothing into it.
		const agentDir = existingAgentDir("atomic-mark-used-");
		const cacheDir = getExtensionTranspileCacheDir(agentDir);
		fs.cpSync(getExtensionTranspileCacheDir(warmAgentDir), cacheDir, { recursive: true });
		fs.utimesSync(cacheDir, UNUSED_FOR_EIGHT_DAYS, UNUSED_FOR_EIGHT_DAYS);

		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
		await loadUnderCurrentAgentDir(entry);

		await vi.waitFor(
			() => assert.ok(fs.statSync(cacheDir).mtimeMs > Date.now() - 60_000, "the cache in use must be marked used"),
			{ timeout: PRUNE_WAIT_MS, interval: 20 },
		);
	});

	it("closing a session waits for the transform its extension stores for a module it imported later", async () => {
		const root = tempDir("atomic-cache-settle-");
		const agentDir = path.join(root, "agent");
		const cwd = path.join(root, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const extensionDir = path.join(agentDir, "extensions", "probe");
		fs.mkdirSync(extensionDir, { recursive: true });
		fs.writeFileSync(path.join(extensionDir, "late.ts"), "export const late: string = 'late';\n");
		const lateImport = "__atomicCacheSettleLateImport";
		const host = globalThis as { [lateImport]?: () => Promise<unknown> };
		fs.writeFileSync(
			path.join(extensionDir, "index.ts"),
			`export default function (): void {
	(globalThis as { ${lateImport}?: () => Promise<unknown> }).${lateImport} = () => import("./late.ts");
}
`,
		);
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		const { session, extensionsResult } = await createAgentSession({
			cwd,
			agentDir,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
		});
		assert.deepEqual(extensionsResult.errors, []);
		const cacheDir = path.resolve(getExtensionTranspileCacheDir(agentDir));
		// A slow disk: storing the late module's transform finishes only after closing the session flushed its settings.
		let releaseWrite!: () => void;
		const writeReleased = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		const flushSettings = settingsManager.flush.bind(settingsManager);
		const flush = vi.spyOn(settingsManager, "flush").mockImplementation(async () => {
			await flushSettings();
			releaseWrite();
		});
		const order: string[] = [];
		const writeFile = fs.promises.writeFile;
		const writes = vi.spyOn(fs.promises, "writeFile").mockImplementation(async (...args) => {
			if (path.dirname(path.resolve(String(args[0]))) !== cacheDir) return writeFile(...args);
			await writeReleased;
			await writeFile(...args);
			order.push("transform stored");
		});
		try {
			await host[lateImport]?.();
			await session.dispose();
			order.push("disposed");
		} finally {
			releaseWrite();
			flush.mockRestore();
			writes.mockRestore();
			delete host[lateImport];
		}

		assert.deepEqual(order, ["transform stored", "disposed"]);
		fs.rmSync(agentDir, { recursive: true });
	});

	it("puts an SDK session's cache under its agentDir option (#4728)", async () => {
		const root = tempDir("atomic-4728-sdk-");
		const sessionAgentDir = path.join(root, "session-agent");
		const environmentAgentDir = path.join(root, "environment-agent");
		const cwd = path.join(root, "project");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(environmentAgentDir, { recursive: true });
		writeExtension(path.join(sessionAgentDir, "extensions", "probe"), "index.ts");
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", environmentAgentDir);

		const { session, extensionsResult } = await createAgentSession({
			cwd,
			agentDir: sessionAgentDir,
			settingsManager: SettingsManager.create(cwd, sessionAgentDir, { projectTrusted: true }),
			sessionManager: SessionManager.inMemory(cwd),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
		});
		sessions.push(session);

		assert.deepEqual(extensionsResult.errors, []);
		assert.ok(
			extensionsResult.extensions.some((extension) => extension.path.endsWith(path.join("probe", "index.ts"))),
			"the session must load the agent directory's extension",
		);
		assert.ok(cachedEntries(sessionAgentDir).length > 0, "the session's agent directory must receive the cache");
		assert.equal(
			fs.existsSync(path.join(environmentAgentDir, "cache")),
			false,
			"the environment's agent directory must not receive the session's cache",
		);
	});
});
