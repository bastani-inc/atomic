import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getModel } from "@bastani/pi-ai/compat";
import { afterEach, describe, it, vi } from "vitest";
import { getExtensionTranspileCacheDir } from "../src/config.js";
import type { AgentSession } from "../src/core/agent-session.js";
import { extensionLoaderTestHooks } from "../src/core/extensions/loader-virtual-modules.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

/** Background pruning of stale cache versions is asynchronous; this bounds the wait for it. */
const PRUNE_WAIT_MS = 10_000;

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
		const agentA = path.join(tempDir("atomic-4728-a-"), "agent");
		const agentB = path.join(tempDir("atomic-4728-b-"), "agent");
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
			extensionLoaderTestHooks.readExtensionGraphManifest(entry, agentB),
			"the graph manifest must follow the agent directory",
		);
	});

	it("does not recreate a removed agent directory when loading again under it (#4728)", async () => {
		const agentDir = path.join(tempDir("atomic-4728-removed-"), "agent");
		const entry = writeExtension(tempDir("atomic-4728-ext-"));

		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
		await loadUnderCurrentAgentDir(entry);
		fs.rmSync(agentDir, { recursive: true, force: true });
		fs.writeFileSync(path.join(path.dirname(entry), "dep.ts"), "export const value: string = 'uncached';\n");

		const factory = await extensionLoaderTestHooks.loadTransformedExtensionModule(entry);

		assert.equal((factory as unknown as () => string)(), "uncached", "the load must still evaluate the new source");
		assert.equal(fs.existsSync(agentDir), false, "a removed agent directory must not be recreated");
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
		const staleDirs = agentDirs.map((agentDir) => path.join(agentDir, "cache", "jiti", "0.0.1+ts-source-specifiers"));
		for (const staleDir of staleDirs) fs.mkdirSync(staleDir, { recursive: true });
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
			builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
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
