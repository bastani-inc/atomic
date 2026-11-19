import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getModel } from "@bastani/atomic-ai/compat";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import type { CreateAgentSessionOptions } from "../src/core/sdk.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { StorageConfigError } from "../src/core/storage/errors.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { linkSharedTranspileCache } from "./helpers/shared-transpile-cache.js";

const NO_PACKAGES: CreateAgentSessionOptions["builtins"] = {
	subagents: false,
	intercom: false,
	mcp: false,
	"web-access": false,
};

let root: string;
const sessions: AgentSession[] = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "atomic-sdk-workflow-journal-"));
	mkdirSync(join(root, "project"), { recursive: true });
	mkdirSync(join(root, "agent"), { recursive: true });
	linkSharedTranspileCache(join(root, "agent"));
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(root, "agent"));
	vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", "");
});

afterEach(async () => {
	vi.unstubAllEnvs();
	try {
		for (const session of sessions.splice(0)) await session.dispose();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("createAgentSession rejects a set but invalid storage variable even with an explicit sessionManager or sessionStore (#3783)", async () => {
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const selection = "not-json-selection-text";
	const hosts: Array<Pick<CreateAgentSessionOptions, "sessionManager" | "sessionStore">> = [
		{ sessionManager: SessionManager.inMemory(cwd) },
		{ sessionStore: new MemorySessionStore() },
		{ sessionStore: { kind: "memory" } },
	];
	for (const variable of ["ATOMIC_STORAGE"]) {
		vi.unstubAllEnvs();
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
		vi.stubEnv(variable, selection);
		for (const host of hosts) {
			await assert.rejects(
				createAgentSession({
					cwd,
					agentDir,
					settingsManager: SettingsManager.inMemory(),
					model: getModel("anthropic", "claude-sonnet-4-5")!,
					builtins: NO_PACKAGES,
					...host,
				}),
				(error: Error) => {
					assert.ok(error instanceof StorageConfigError, String(error));
					assert.equal(error.source, "env");
					assert.equal(error.field, variable);
					assert.equal(error.reason, "invalid-json");
					assert.equal(error.message.includes(selection), false);
					return true;
				},
			);
		}
	}
	// The workflow journal variable of earlier releases selects nothing now, so its text is never read.
	vi.unstubAllEnvs();
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("ATOMIC_WORKFLOWS_JOURNAL", selection);
	for (const host of hosts) {
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			builtins: NO_PACKAGES,
			...host,
		});
		sessions.push(session);
	}
});

test("storage variables select an adapter by the name of a package the host loaded through the SDK (#4678)", async () => {
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const app = join(root, "app");
	mkdirSync(join(app, "storage"), { recursive: true });
	writeFileSync(
		join(app, "package.json"),
		JSON.stringify({ name: "@atomic-test/sdk-host-app", atomic: { storageAdapters: ["./storage/adapter.ts"] } }),
	);
	writeFileSync(
		join(app, "storage", "adapter.ts"),
		`import { openNodeSqliteDatabase } from "@bastani/atomic/storage";
export default { atomicStorageAdapter: 1 as const, openDatabase: (options: { readonly path?: string }) => openNodeSqliteDatabase(String(options.path)) };\n`,
	);
	const shared = join(root, "app-store.sqlite");
	const selection = JSON.stringify({ adapter: "@atomic-test/sdk-host-app", options: { path: shared } });
	vi.stubEnv("ATOMIC_SESSIONS_STORAGE", selection);
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths: [app],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		settingsManager,
		resourceLoader,
		model: getModel("anthropic", "claude-sonnet-4-5")!,
		builtins: NO_PACKAGES,
	});
	sessions.push(session);
	await session.sessionManager.appendMessage({ role: "user", content: "stored conversation", timestamp: 1 });
	const database = new DatabaseSync(shared, { readOnly: true });
	try {
		const stored = database.prepare("SELECT id FROM session_sessions").all();
		assert.deepEqual(
			stored.map((row) => row.id),
			[session.sessionId],
		);
	} finally {
		database.close();
	}
});

test("a relative ATOMIC_STORAGE path puts the session database under the custom agentDir (#3783)", async () => {
	const cwd = join(root, "project");
	const agentDir = join(root, "tenant", "agent");
	mkdirSync(agentDir, { recursive: true });
	linkSharedTranspileCache(agentDir);
	vi.stubEnv("ATOMIC_STORAGE", JSON.stringify({ path: "shared.sqlite" }));
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		settingsManager: SettingsManager.inMemory(),
		model: getModel("anthropic", "claude-sonnet-4-5")!,
		builtins: NO_PACKAGES,
	});
	sessions.push(session);
	await session.sessionManager.appendMessage({ role: "user", content: "stored conversation", timestamp: 1 });
	const shared = join(agentDir, "shared.sqlite");
	const database = new DatabaseSync(shared, { readOnly: true });
	try {
		const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
		assert.ok(
			tables.some((table) => table.name === "session_sessions"),
			JSON.stringify(tables),
		);
	} finally {
		database.close();
	}
	assert.equal(existsSync(join(root, "tenant", "shared.sqlite")), false);
	assert.equal(existsSync(join(root, "shared.sqlite")), false);
});
