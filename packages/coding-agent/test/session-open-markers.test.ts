import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { SessionManager, SessionOpenElsewhereError } from "../src/core/session-manager.js";
import {
	assertSessionNotOpenElsewhere,
	findSessionOpenHolder,
	holdSessionOpenMarker,
} from "../src/core/session-open-markers.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import { bunExecutable } from "./cli-test-helpers.js";

const markersModule = resolve(import.meta.dirname, "../src/core/session-open-markers.ts");
const PROCESS_TIMEOUT_MS = 60_000;

/** Another process that marks `sessionId` open under `agentDir`, as a running Atomic process does (#4971). */
async function holdInAnotherProcess(agentDir: string, sessionId: string): Promise<ChildProcess> {
	const script = `const { findSessionOpenHolder, holdSessionOpenMarker } = await import(${JSON.stringify(markersModule)});
holdSessionOpenMarker(${JSON.stringify(sessionId)}, { agentDir: ${JSON.stringify(agentDir)} });
// The mark is written once this process finds it.
await findSessionOpenHolder(${JSON.stringify(sessionId)}, { agentDir: ${JSON.stringify(agentDir)} });
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
		"a live holder suspended past its heartbeats still protects the session (#5058)",
		async () => {
			const { manager, sessionId } = await sessionToDelete();
			holder = await holdInAnotherProcess(agentDir, sessionId);
			// Stopped for a minute and more: its mark was last refreshed two minutes ago.
			holder.kill("SIGSTOP");
			const markers = join(agentDir, "open-sessions", sessionId);
			const twoMinutesAgo = new Date(Date.now() - 120_000);
			for (const name of readdirSync(markers)) utimesSync(join(markers, name), twoMinutesAgo, twoMinutesAgo);
			await assert.rejects(manager.deleteSession(sessionId), SessionOpenElsewhereError);
			assert.equal(readdirSync(markers).length, 1, "the suspended holder's mark is kept");
			holder.kill("SIGCONT");
		},
		PROCESS_TIMEOUT_MS,
	);

	test(
		"a running holder on this host protects the session after this host's clock steps forward (#5058)",
		async () => {
			const { manager, sessionId } = await sessionToDelete();
			holder = await holdInAnotherProcess(agentDir, sessionId);
			const realNow = Date.now.bind(Date);
			vi.spyOn(Date, "now").mockImplementation(() => realNow() + 10 * 60_000);
			try {
				await assert.rejects(manager.deleteSession(sessionId), SessionOpenElsewhereError);
			} finally {
				vi.restoreAllMocks();
			}
		},
		PROCESS_TIMEOUT_MS,
	);

	test.skipIf(process.platform !== "linux")(
		"a mark naming a running process that started after its holder does not protect the session (#5058)",
		async () => {
			const { manager, sessionId } = await sessionToDelete();
			holder = await holdInAnotherProcess(agentDir, sessionId);
			const markers = join(agentDir, "open-sessions", sessionId);
			const [name] = readdirSync(markers);
			assert.match(name!, /^\d+-[0-9a-f]{16}-[0-9a-f]{12}\.json$/, "the mark names when its holder started");
			// The holder's pid, given to a process that started at another time.
			rmSync(join(markers, name!));
			const reused = `${holder.pid}-${"0".repeat(16)}-${"0".repeat(12)}.json`;
			writeFileSync(join(markers, reused), JSON.stringify({ pid: holder.pid, host: hostname() }));

			await manager.deleteSession(sessionId);
			assert.equal(existsSync(join(markers, reused)), false);
		},
		PROCESS_TIMEOUT_MS,
	);
});

describe("a session marked open on another host that shares the agent directory (#5058)", () => {
	let dir: string;
	let agentDir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "atomic-open-remote-"));
		agentDir = join(dir, "agent");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	/** A mark another host wrote `ageMs` ago, by the file system's clock. */
	function remoteMark(sessionId: string, ageMs: number): string {
		const markers = join(agentDir, "open-sessions", sessionId);
		mkdirSync(markers, { recursive: true });
		const path = join(markers, "remote.json");
		writeFileSync(path, JSON.stringify({ pid: 999_999_999, host: "another-host" }));
		const at = new Date(Date.now() - ageMs);
		utimesSync(path, at, at);
		return path;
	}

	/** This host's clock is `skewMs` off the clock that stamps the shared files. */
	function skewClock(skewMs: number): void {
		const realNow = Date.now.bind(Date);
		vi.spyOn(Date, "now").mockImplementation(() => realNow() + skewMs);
	}

	for (const skewMs of [120_000, 10 * 60_000]) {
		test(`a mark the other host refreshed counts when this host's clock is ${skewMs / 60_000} minutes ahead (#5058)`, async () => {
			remoteMark("remote-session", 0);
			skewClock(skewMs);
			await assert.rejects(assertSessionNotOpenElsewhere("remote-session", { agentDir }), SessionOpenElsewhereError);
		});
	}

	test("a mark the other host stopped refreshing is removed when this host's clock is two minutes behind (#5058)", async () => {
		const path = remoteMark("remote-session", 120_000);
		skewClock(-120_000);
		await assertSessionNotOpenElsewhere("remote-session", { agentDir });
		assert.equal(existsSync(path), false);
	});
});

describe("a session open in this process (#4971)", () => {
	let dir: string;
	let sessionDir: string;
	let agentDir: string;
	let previousAgentDir: string | undefined;
	const releases: (() => Promise<void>)[] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "atomic-open-here-"));
		sessionDir = join(dir, "sessions");
		agentDir = join(dir, "agent");
		mkdirSync(agentDir, { recursive: true });
		previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
		process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
	});

	afterEach(async () => {
		for (const release of releases.splice(0)) await release();
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

	function hold(manager: SessionManager): () => Promise<void> {
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
		await releaseFirst();
		await releaseFirst();
		await assert.rejects(deleter.deleteSession(running.getSessionId()), SessionOpenElsewhereError);
		const releaseOther = hold(sameSession);
		await releaseSecond();
		await assert.rejects(deleter.deleteSession(running.getSessionId()), SessionOpenElsewhereError);
		await releaseOther();
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
		// The mark is written once this process finds it.
		await findSessionOpenHolder(running.getSessionId());
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
		await first();
		assert.equal(vi.getTimerCount(), 1);
		await second();
		assert.equal(vi.getTimerCount(), 0);
	});

	test("a hold released twice drops only itself, and holds on two stores are kept apart (#4971)", async () => {
		const sessionId = "held-session";
		const otherAgentDir = join(dir, "other-agent");
		const first = holdSessionOpenMarker(sessionId, { agentDir });
		const second = holdSessionOpenMarker(sessionId, { agentDir });
		const elsewhere = holdSessionOpenMarker(sessionId, { agentDir: otherAgentDir });
		await first();
		await first();
		await assert.rejects(assertSessionNotOpenElsewhere(sessionId, { agentDir }), SessionOpenElsewhereError);
		await second();
		await assertSessionNotOpenElsewhere(sessionId, { agentDir });
		await assert.rejects(
			assertSessionNotOpenElsewhere(sessionId, { agentDir: otherAgentDir }),
			SessionOpenElsewhereError,
		);
		await elsewhere();
		await assertSessionNotOpenElsewhere(sessionId, { agentDir: otherAgentDir });
	});

	test("a session id that cannot name a directory gets no mark and is never found held (#4971)", async () => {
		const release = holdSessionOpenMarker("../escape", { agentDir });
		await release();
		assert.equal(existsSync(join(agentDir, "open-sessions")), false);
		assert.equal(existsSync(join(agentDir, "escape")), false);
		mkdirSync(join(agentDir, "escape"), { recursive: true });
		writeFileSync(join(agentDir, "escape", "x.json"), JSON.stringify({ pid: process.pid, host: "another-host" }));
		await assertSessionNotOpenElsewhere("../escape", { agentDir: join(agentDir, "open-sessions") });
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

	test.skipIf(process.platform === "win32")(
		"a mark that does not say when its running holder started counts for a day, and not after (#5058)",
		async () => {
			const target = await saved("target");
			const deleter = await saved("deleter");
			const markers = markersOf(target.getSessionId());
			mkdirSync(markers, { recursive: true });
			const mark = join(markers, "init.json");
			writeFileSync(mark, JSON.stringify({ pid: 1, host: hostname() }));
			const age = (ms: number) => {
				const at = new Date(Date.now() - ms);
				utimesSync(mark, at, at);
			};

			age(23 * 60 * 60_000);
			await assert.rejects(deleter.deleteSession(target.getSessionId()), SessionOpenElsewhereError);
			age(25 * 60 * 60_000);
			await deleter.deleteSession(target.getSessionId());
			assert.equal(existsSync(mark), false);
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

describe("a session open on another host that shares a SQL store (#4971)", () => {
	test("the store's own marks are seen whatever the agent directory, and stale ones are removed (#4971)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-open-sql-"));
		const database = await openNodeSqliteDatabase(join(dir, "shared.sqlite"));
		const store = await SqlSessionStore.open(database);
		try {
			const target = await SessionManager.create(store, dir);
			await target.appendMessage({ role: "user", content: "target", timestamp: Date.now() });
			const deleter = await SessionManager.create(store, dir);
			const sessionId = target.getSessionId();
			const elsewhere = { token: "77-remote", pid: 77, host: "another-host" };
			await store.openMarkers.put(sessionId, elsewhere);
			await assert.rejects(deleter.deleteSession(sessionId), (error: unknown) => {
				assert.ok(error instanceof SessionOpenElsewhereError);
				assert.equal(error.host, "another-host");
				return true;
			});
			assert.equal(existsSync(join(dir, "open-sessions")), false, "no mark is a file");

			// Two minutes without a refresh, on the store's clock.
			await database.run(
				"UPDATE session_open SET heartbeat_at = heartbeat_at - 120000 WHERE token = ?",
				"77-remote",
			);
			await store.openMarkers.put(sessionId, { token: "dead", pid: 999_999_999, host: hostname() });
			await deleter.deleteSession(sessionId);
			assert.deepEqual(await store.openMarkers.list(sessionId), []);
		} finally {
			await store.close();
			await database.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	for (const skew of [-120_000, 120_000]) {
		test(`a held mark counts when the reader's clock is ${skew > 0 ? "ahead of" : "behind"} the holder's by two minutes (#4971)`, async () => {
			const dir = mkdtempSync(join(tmpdir(), "atomic-open-sql-"));
			const database = await openNodeSqliteDatabase(join(dir, "shared.sqlite"));
			const store = await SqlSessionStore.open(database);
			const now = Date.now;
			try {
				const running = await SessionManager.create(store, dir);
				await running.appendMessage({ role: "user", content: "running", timestamp: Date.now() });
				const deleter = await SessionManager.create(store, dir);
				// The holder writes its mark on a clock `skew` behind the reader's.
				Date.now = () => now() - skew;
				const release = running.holdOpen();
				await vi.waitFor(async () =>
					assert.equal((await store.openMarkers.list(running.getSessionId())).length, 1),
				);
				Date.now = now;
				await assert.rejects(deleter.deleteSession(running.getSessionId()), SessionOpenElsewhereError);
				// The reader's clock is ahead of the holder's by `skew`.
				Date.now = () => now() + skew;
				await assert.rejects(deleter.deleteSession(running.getSessionId()), SessionOpenElsewhereError);
				Date.now = now;
				await release();
			} finally {
				Date.now = now;
				await store.close();
				await database.close();
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	test("a running session's mark lives in the store while it is held (#4971)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-open-sql-"));
		const database = await openNodeSqliteDatabase(join(dir, "shared.sqlite"));
		const store = await SqlSessionStore.open(database);
		try {
			const running = await SessionManager.create(store, dir);
			await running.appendMessage({ role: "user", content: "running", timestamp: Date.now() });
			const release = running.holdOpen();
			await vi.waitFor(async () => assert.equal((await store.openMarkers.list(running.getSessionId())).length, 1));
			const [marker] = await store.openMarkers.list(running.getSessionId());
			assert.deepEqual([marker!.pid, marker!.host], [process.pid, hostname()]);
			await release();
			assert.deepEqual(await store.openMarkers.list(running.getSessionId()), []);
		} finally {
			await store.close();
			await database.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
