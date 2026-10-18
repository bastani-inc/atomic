import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { resolveSessionStore } from "../src/core/session-storage.js";
import { attachJsonlLineReader, serializeJsonLine } from "../src/modes/rpc/jsonl.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import type { RpcResponse } from "../src/modes/rpc/rpc-types.js";
import { bunExecutable, cliPath } from "./cli-test-helpers.js";

const REAL_RPC_DELETE_SESSION_TIMEOUT_MS = 120_000;
const RAW_RPC_RESPONSE_TIMEOUT_MS = 60_000;
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

/** Writes raw JSONL commands to the real CLI in RPC mode and returns its responses in arrival order. */
async function sendRawCommands(
	dir: string,
	selection: string[],
	commands: Array<Record<string, string>>,
): Promise<RpcResponse[]> {
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionSummary: { enabled: false } }));
	const child = spawn(bunExecutable(), [cliPath, "--mode", "rpc", ...selection, "--no-extensions", "--no-tools"], {
		cwd: dir,
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: "" },
		stdio: "pipe",
		windowsHide: true,
	});
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	const responses: RpcResponse[] = [];
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`Timed out waiting for raw RPC responses: ${stderr}`)),
				RAW_RPC_RESPONSE_TIMEOUT_MS,
			);
			child.once("exit", (code, signal) => reject(new Error(`RPC exited code=${code} signal=${signal}: ${stderr}`)));
			attachJsonlLineReader(child.stdout, (line) => {
				const record = JSON.parse(line) as RpcResponse;
				if (record.type !== "response") return;
				responses.push(record);
				if (responses.length === commands.length) {
					clearTimeout(timer);
					resolve();
				}
			});
			// One command per line, written in order; the CLI answers each in the same order.
			for (const command of commands) child.stdin.write(serializeJsonLine(command));
		});
	} finally {
		child.kill("SIGKILL");
	}
	return responses;
}

test(
	"delete_session accepts the literal { id } shorthand and prefers sessionId when both are present (#3740)",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-delete-session-raw-"));
		const sessionDir = join(dir, "sessions");
		const byId = await SessionManager.create(dir, sessionDir);
		await byId.appendMessage(message("delete by id"));
		const byIdFile = byId.getSessionFile()!;
		const bySessionId = await SessionManager.create(dir, sessionDir);
		await bySessionId.appendMessage(message("delete by sessionId"));
		const bySessionIdFile = bySessionId.getSessionFile()!;
		const survivor = await SessionManager.create(dir, sessionDir);
		await survivor.appendMessage(message("request id names a session that must survive"));
		const survivorFile = survivor.getSessionFile()!;
		try {
			const responses = await sendRawCommands(
				dir,
				["--session-dir", sessionDir],
				[
					{ id: byId.getSessionId(), type: "delete_session" },
					{ id: survivor.getSessionId(), type: "delete_session", sessionId: bySessionId.getSessionId() },
				],
			);

			assert.deepEqual(responses, [
				{ id: byId.getSessionId(), type: "response", command: "delete_session", success: true },
				{ id: survivor.getSessionId(), type: "response", command: "delete_session", success: true },
			]);
			assert.equal(existsSync(byIdFile), false);
			assert.equal(existsSync(bySessionIdFile), false);
			assert.equal(existsSync(survivorFile), true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
	REAL_RPC_DELETE_SESSION_TIMEOUT_MS,
);

test(
	"delete_session without sessionId or id returns an error and deletes nothing (#3740)",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-delete-session-missing-"));
		const sessionDir = join(dir, "sessions");
		const stored = await SessionManager.create(dir, sessionDir);
		await stored.appendMessage(message("must survive"));
		const storedFile = stored.getSessionFile()!;
		try {
			const responses = await sendRawCommands(
				dir,
				["--session-dir", sessionDir],
				[{ type: "delete_session" }, { id: "after", type: "get_state" }],
			);

			assert.deepEqual(responses[0], {
				type: "response",
				command: "delete_session",
				success: false,
				error: "delete_session requires sessionId",
			});
			assert.equal(responses[1].id, "after");
			assert.equal(existsSync(storedFile), true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
	REAL_RPC_DELETE_SESSION_TIMEOUT_MS,
);
