import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { SessionManager, SessionOpenElsewhereError } from "../src/core/session-manager.js";
import { assertSessionNotOpenElsewhere, holdSessionOpenMarker } from "../src/core/session-open-markers.js";
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

describe("a session open in this process (#4971)", () => {
	let dir: string;
	let sessionDir: string;
	let agentDir: string;
	let previousAgentDir: string | undefined;
	const releases: (() => void)[] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "atomic-open-here-"));
		sessionDir = join(dir, "sessions");
		agentDir = join(dir, "agent");
		mkdirSync(agentDir, { recursive: true });
		previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
		process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		for (const release of releases.splice(0)) release();
		vi.useRealTimers();
		if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
		else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
		rmSync(dir, { recursive: true, force: true });
	});

	async function saved(content: string): Promise<SessionManager> {
		const manager = await SessionManager.create(dir, sessionDir);
		await manager.appendMessage({ role: "user", content, timestamp: Date.now() });
		return manager;
	}

	function hold(manager: SessionManager): () => void {
		const release = manager.holdOpen();
		releases.push(release);
		return release;
	}

	const markersOf = (sessionId: string) => join(agentDir, "open-sessions", sessionId);

	test("a session another running session holds is refused until every hold is released (#4971)", async () => {
		const running = await saved("running");
		const sameSession = await SessionManager.open(running.getSessionFile()!, sessionDir);
		const deleter = await saved("deleter");
		const releaseFirst = hold(running);
		const releaseSecond = hold(running);

		await assert.rejects(deleter.deleteSession(running.getSessionId()), (error: unknown) => {
			assert.ok(error instanceof SessionOpenElsewhereError);
			assert.equal(error.name, "SessionOpenElsewhereError");
			assert.equal(error.sessionId, running.getSessionId());
			assert.equal(error.pid, process.pid);
			assert.equal(error.host, hostname());
			return true;
		});
		releaseFirst();
		releaseFirst();
		await assert.rejects(deleter.deleteSession(running.getSessionId()), SessionOpenElsewhereError);
		const releaseOther = hold(sameSession);
		releaseSecond();
		await assert.rejects(deleter.deleteSession(running.getSessionId()), SessionOpenElsewhereError);
		releaseOther();
		assert.equal(existsSync(markersOf(running.getSessionId())), false);

		await deleter.deleteSession(running.getSessionId());
		assert.equal(existsSync(running.getSessionFile()!), false);
	});

	test("a running session's mark moves with it to the session it switches to (#4971)", async () => {
		const running = await saved("first");
		const first = running.getSessionId();
		const deleter = await saved("deleter");
		hold(running);

		await running.newSession();
		await running.appendMessage({ role: "user", content: "second", timestamp: Date.now() });

		await deleter.deleteSession(first);
		await assert.rejects(deleter.deleteSession(running.getSessionId()), SessionOpenElsewhereError);
	});

	test("an unsaved session leaves no mark (#4971)", async () => {
		hold(SessionManager.inMemory(dir));
		assert.equal(existsSync(join(agentDir, "open-sessions")), false);
	});

	test("the heartbeat keeps a running session's mark fresh, and writes it again when it was removed (#4971)", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const running = await saved("running");
		const deleter = await saved("deleter");
		hold(running);
		const markers = markersOf(running.getSessionId());
		const [marker] = readdirSync(markers);
		const twoMinutesAgo = new Date(Date.now() - 120_000);
		utimesSync(join(markers, marker!), twoMinutesAgo, twoMinutesAgo);

		vi.advanceTimersByTime(15_000);
		await assert.rejects(deleter.deleteSession(running.getSessionId()), SessionOpenElsewhereError);

		rmSync(markers, { recursive: true });
		vi.advanceTimersByTime(15_000);
		await assert.rejects(deleter.deleteSession(running.getSessionId()), SessionOpenElsewhereError);
	});

	test("the heartbeat stops once no session is held (#4971)", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const first = hold(await saved("first"));
		const second = hold(await saved("second"));
		assert.equal(vi.getTimerCount(), 1);
		first();
		assert.equal(vi.getTimerCount(), 1);
		second();
		assert.equal(vi.getTimerCount(), 0);
	});

	test("a session id that cannot name a directory gets no mark and is never found held (#4971)", () => {
		const release = holdSessionOpenMarker(agentDir, "../escape");
		release();
		assert.equal(existsSync(join(agentDir, "open-sessions")), false);
		assert.equal(existsSync(join(agentDir, "escape")), false);
		mkdirSync(join(agentDir, "escape"), { recursive: true });
		writeFileSync(join(agentDir, "escape", "x.json"), JSON.stringify({ pid: process.pid, host: "another-host" }));
		assert.doesNotThrow(() => assertSessionNotOpenElsewhere("../escape", join(agentDir, "open-sessions")));
	});

	// Signalling another user's process fails with EPERM on POSIX only; on Windows pid 1 does not exist.
	test.skipIf(process.platform === "win32")(
		"a mark of a process this one may not signal still counts (#4971)",
		async () => {
			const target = await saved("target");
			const deleter = await saved("deleter");
			const markers = markersOf(target.getSessionId());
			mkdirSync(markers, { recursive: true });
			writeFileSync(join(markers, "init.json"), JSON.stringify({ pid: 1, host: hostname() }));

			await assert.rejects(deleter.deleteSession(target.getSessionId()), SessionOpenElsewhereError);
		},
	);

	test("marks that name no running session are ignored and removed (#4971)", async () => {
		const target = await saved("target");
		const deleter = await saved("deleter");
		const markers = markersOf(target.getSessionId());
		mkdirSync(markers, { recursive: true });
		const write = (name: string, content: string, age = 0) => {
			writeFileSync(join(markers, name), content);
			const at = new Date(Date.now() - age);
			utimesSync(join(markers, name), at, at);
		};
		write("not-json.json", "{");
		write("no-pid.json", JSON.stringify({ host: hostname() }));
		write("no-host.json", JSON.stringify({ pid: process.pid }));
		write("earlier-process.json", JSON.stringify({ pid: process.pid, host: hostname() }));
		write("silent-host.json", JSON.stringify({ pid: 1, host: "another-host" }), 120_000);

		await deleter.deleteSession(target.getSessionId());

		assert.deepEqual(readdirSync(markers).sort(), ["no-host.json", "no-pid.json", "not-json.json"]);
	});

	test("a mark from another host counts while its heartbeat is fresh (#4971)", async () => {
		const target = await saved("target");
		const deleter = await saved("deleter");
		const markers = markersOf(target.getSessionId());
		mkdirSync(markers, { recursive: true });
		writeFileSync(join(markers, "remote.json"), JSON.stringify({ pid: 999_999_999, host: "another-host" }));

		await assert.rejects(deleter.deleteSession(target.getSessionId()), (error: unknown) => {
			assert.ok(error instanceof SessionOpenElsewhereError);
			assert.equal(error.host, "another-host");
			return true;
		});
	});
});
