import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { resolveSessionStore } from "../src/core/session-storage.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import { bunExecutable, cliPath } from "./cli-test-helpers.js";

const REAL_RPC_DELETE_SESSION_TIMEOUT_MS = 120_000;
const message = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });

function startClient(dir: string, selection: string[]): RpcClient {
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionSummary: { enabled: false } }));
	return new RpcClient({
		cliPath,
		cwd: dir,
		runtimeExecutable: bunExecutable(),
		env: { ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: "" },
		args: [...selection, "--no-extensions", "--no-tools"],
	});
}

test(
	"RpcClient deletes stored SQLite sessions but refuses the open one through the real CLI (#3740)",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-delete-session-sqlite-"));
		const databasePath = join(dir, "sessions.sqlite");
		const seedStore = await resolveSessionStore(dir, { sessionStore: { kind: "sqlite", path: databasePath } });
		const other = await SessionManager.create(seedStore, dir);
		await other.appendMessage(message("delete me"));
		await seedStore.close();
		const client = startClient(dir, ["--session-store", databasePath]);
		try {
			await client.start();
			const currentId = (await client.getState()).sessionId;
			assert.notEqual(currentId, other.getSessionId());
			assert.ok((await client.listSessions()).some((item) => item.id === other.getSessionId()));

			await client.deleteSession(other.getSessionId());
			assert.equal(
				(await client.listSessions()).some((item) => item.id === other.getSessionId()),
				false,
			);
			await client.deleteSession(other.getSessionId());

			await assert.rejects(client.deleteSession(currentId), /currently open/);
			assert.equal((await client.getState()).sessionId, currentId);

			await client.newSession();
			await client.deleteSession(currentId);
			assert.equal(
				(await client.listSessions()).some((item) => item.id === currentId),
				false,
			);
		} finally {
			await client.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	},
	REAL_RPC_DELETE_SESSION_TIMEOUT_MS,
);

test(
	"RpcClient deletes JSONL sessions and refuses the open one through the real CLI (#3740)",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-delete-session-jsonl-"));
		const sessionDir = join(dir, "sessions");
		const other = await SessionManager.create(dir, sessionDir);
		await other.appendMessage(message("delete me"));
		const otherFile = other.getSessionFile()!;
		const client = startClient(dir, ["--session-dir", sessionDir]);
		try {
			await client.start();
			const currentId = (await client.getState()).sessionId;
			assert.ok((await client.listSessions()).some((item) => item.id === other.getSessionId()));

			await client.deleteSession(other.getSessionId());
			assert.equal(existsSync(otherFile), false);
			assert.equal(
				(await client.listSessions()).some((item) => item.id === other.getSessionId()),
				false,
			);

			await assert.rejects(client.deleteSession(currentId), /currently open/);
			assert.equal((await client.getState()).sessionId, currentId);
		} finally {
			await client.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	},
	REAL_RPC_DELETE_SESSION_TIMEOUT_MS,
);
