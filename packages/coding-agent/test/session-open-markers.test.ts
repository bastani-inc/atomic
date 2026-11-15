import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { SessionManager, SessionOpenElsewhereError } from "../src/core/session-manager.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { bunExecutable } from "./cli-test-helpers.js";

const markersModule = resolve(import.meta.dirname, "../src/core/session-open-markers.ts");
const PROCESS_TIMEOUT_MS = 60_000;

/** Another process that marks `sessionId` open under `agentDir`, as a running Atomic process does (#4971). */
async function holdInAnotherProcess(agentDir: string, sessionId: string): Promise<ChildProcess> {
	const script = `const { holdSessionOpenMarker } = await import(${JSON.stringify(markersModule)});
holdSessionOpenMarker(${JSON.stringify(agentDir)}, ${JSON.stringify(sessionId)});
console.log("held");
setInterval(() => {}, 1000);`;
	const child = spawn(bunExecutable(), ["-e", script], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	let stderr = "";
	child.stderr!.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	await new Promise<void>((resolveHeld, reject) => {
		child.stdout!.on("data", (chunk: Buffer) => {
			if (chunk.toString("utf8").includes("held")) resolveHeld();
		});
		child.once("exit", (code) => reject(new Error(`holder exited ${code}: ${stderr}`)));
	});
	return child;
}

function exited(child: ChildProcess): Promise<void> {
	return child.exitCode !== null || child.signalCode !== null
		? Promise.resolve()
		: new Promise((resolveExit) => child.once("exit", () => resolveExit()));
}

describe("a session marked open by another process (#4971)", () => {
	let dir: string;
	let agentDir: string;
	let previousAgentDir: string | undefined;
	let holder: ChildProcess | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "atomic-open-markers-"));
		agentDir = join(dir, "agent");
		mkdirSync(agentDir, { recursive: true });
		previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
		process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
	});

	afterEach(async () => {
		if (holder && holder.exitCode === null && holder.signalCode === null) {
			holder.kill("SIGKILL");
			await exited(holder);
		}
		holder = undefined;
		if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
		else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
		rmSync(dir, { recursive: true, force: true });
	});

	async function sessionToDelete(): Promise<{
		manager: SessionManager;
		sessionId: string;
		store: MemorySessionStore;
	}> {
		const store = new MemorySessionStore();
		const target = await SessionManager.create(store, dir);
		await target.appendMessage({ role: "user", content: "target", timestamp: Date.now() });
		const manager = await SessionManager.create(store, dir);
		return { manager, sessionId: target.getSessionId(), store };
	}

	test(
		"a process killed with SIGKILL stops protecting the session it held (#4971)",
		async () => {
			const { manager, sessionId, store } = await sessionToDelete();
			holder = await holdInAnotherProcess(agentDir, sessionId);
			await assert.rejects(manager.deleteSession(sessionId), (error: unknown) => {
				assert.ok(error instanceof SessionOpenElsewhereError);
				assert.equal(error.sessionId, sessionId);
				assert.equal(error.pid, holder!.pid);
				return true;
			});

			holder.kill("SIGKILL");
			await exited(holder);
			await manager.deleteSession(sessionId);

			await assert.rejects(store.load(sessionId), /Session not found/);
			assert.deepEqual(readdirSync(join(agentDir, "open-sessions")), []);
		},
		PROCESS_TIMEOUT_MS,
	);

	test.skipIf(process.platform === "win32")(
		"a live process whose heartbeat stopped no longer protects the session (#4971)",
		async () => {
			const { manager, sessionId } = await sessionToDelete();
			holder = await holdInAnotherProcess(agentDir, sessionId);
			holder.kill("SIGSTOP");
			const markers = join(agentDir, "open-sessions", sessionId);
			const minuteAgo = new Date(Date.now() - 50_000);
			for (const name of readdirSync(markers)) utimesSync(join(markers, name), minuteAgo, minuteAgo);
			await assert.rejects(manager.deleteSession(sessionId), SessionOpenElsewhereError);

			const twoMinutesAgo = new Date(Date.now() - 120_000);
			for (const name of readdirSync(markers)) utimesSync(join(markers, name), twoMinutesAgo, twoMinutesAgo);
			await manager.deleteSession(sessionId);
			holder.kill("SIGCONT");
		},
		PROCESS_TIMEOUT_MS,
	);
});
