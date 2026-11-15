import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { SessionManager, SessionOpenElsewhereError } from "../src/core/session-manager.js";
import { resolveSessionStore } from "../src/core/session-storage.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import { bunExecutable, cliPath } from "./cli-test-helpers.js";

const REAL_CLI_TIMEOUT_MS = 120_000;
const message = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });

/**
 * Two processes on one session (#4971): process A is the real CLI in RPC mode running a session; process B is this
 * test process, sharing A's agent directory and session store, deleting that session.
 */
describe("deleting a session open in another process (#4971)", () => {
	let dir: string;
	let agentDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "atomic-delete-open-elsewhere-"));
		agentDir = join(dir, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionSummary: { enabled: false } }));
		previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
		process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
		else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
		rmSync(dir, { recursive: true, force: true });
	});

	function startProcessA(selection: string[]): RpcClient {
		return new RpcClient({
			cliPath,
			cwd: dir,
			runtimeExecutable: bunExecutable(),
			env: { ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: "" },
			args: [...selection, "--no-extensions", "--no-tools"],
		});
	}

	async function refusedWhileLiveThenAllowed(
		selection: string[],
		openManagerB: () => Promise<SessionManager>,
		options: { readonly agentDirB?: string } = {},
	) {
		const processA = startProcessA(selection);
		let stopped = false;
		try {
			await processA.start();
			const sessionId = (await processA.getState()).sessionId;
			// Process B may run on another host, or under another agent directory, against the same store.
			if (options.agentDirB !== undefined) process.env.ATOMIC_CODING_AGENT_DIR = options.agentDirB;
			const managerB = await openManagerB();
			try {
				await assert.rejects(managerB.deleteSession(sessionId), (error: unknown) => {
					assert.ok(error instanceof SessionOpenElsewhereError);
					assert.match(error.message, /open in a running Atomic session \(pid \d+ on .+\)/);
					return true;
				});
				assert.ok(
					(await processA.listSessions()).some((item) => item.id === sessionId),
					"the refused delete leaves the session in place",
				);

				await processA.stop();
				stopped = true;
				await managerB.deleteSession(sessionId);
				const listed = await SessionManager.list(dir, managerB.getSessionStore());
				assert.equal(
					listed.some((info) => info.id === sessionId),
					false,
				);
			} finally {
				await managerB.getSessionStore().close();
			}
		} finally {
			if (!stopped) await processA.stop();
		}
	}

	test(
		"a SQLite session is refused while the other process runs it and deleted after it exits (#4971)",
		async () => {
			const databasePath = join(dir, "sessions.sqlite");
			await refusedWhileLiveThenAllowed(["--session-store", databasePath], async () => {
				const store = await resolveSessionStore(dir, { sessionStore: { kind: "sqlite", path: databasePath } });
				const manager = await SessionManager.create(store, dir);
				await manager.appendMessage(message("process B"));
				return manager;
			});
		},
		REAL_CLI_TIMEOUT_MS,
	);

	test(
		"a session in a shared SQL store is refused from a process with another agent directory (#4971)",
		async () => {
			const databasePath = join(dir, "sessions.sqlite");
			const agentDirB = join(dir, "agent-b");
			mkdirSync(agentDirB, { recursive: true });
			await refusedWhileLiveThenAllowed(
				["--session-store", databasePath],
				async () => {
					const store = await resolveSessionStore(dir, { sessionStore: { kind: "sqlite", path: databasePath } });
					const manager = await SessionManager.create(store, dir);
					await manager.appendMessage(message("process B"));
					return manager;
				},
				{ agentDirB },
			);
		},
		REAL_CLI_TIMEOUT_MS,
	);

	test(
		"a JSONL session is refused while the other process runs it and deleted after it exits (#4971)",
		async () => {
			const sessionDir = join(dir, "sessions");
			await refusedWhileLiveThenAllowed(["--session-dir", sessionDir], async () => {
				const manager = await SessionManager.create(dir, sessionDir);
				await manager.appendMessage(message("process B"));
				return manager;
			});
		},
		REAL_CLI_TIMEOUT_MS,
	);
});
