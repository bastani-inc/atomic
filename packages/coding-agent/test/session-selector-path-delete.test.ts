import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { type SessionInfo, SessionManager } from "../src/core/session-manager.ts";
import { resolveSessionStore } from "../src/core/session-storage.js";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (err: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => {};
	let reject: (err: unknown) => void = () => {};
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function makeSession(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
	return {
		path: overrides.path ?? `/tmp/${overrides.id}.jsonl`,
		id: overrides.id,
		cwd: overrides.cwd ?? "",
		name: overrides.name,
		parentSessionPath: overrides.parentSessionPath,
		created: overrides.created ?? new Date(0),
		modified: overrides.modified ?? new Date(0),
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? "hello",
		allMessagesText: overrides.allMessagesText ?? "hello",
	};
}

function createSymlinkedSessionPaths(): {
	baseDir: string;
	parentAliasA: string;
	parentAliasB: string;
	childAliasB: string;
} {
	const baseDir = mkdtempSync(join(tmpdir(), "pi-session-selector-"));
	const realDir = join(baseDir, "real");
	const aliasADir = join(baseDir, "alias-a");
	const aliasBDir = join(baseDir, "alias-b");
	mkdirSync(realDir, { recursive: true });
	mkdirSync(aliasADir, { recursive: true });
	mkdirSync(aliasBDir, { recursive: true });

	const sharedDir = join(realDir, "sessions");
	mkdirSync(sharedDir, { recursive: true });
	const aliasASessions = join(aliasADir, "sessions");
	const aliasBSessions = join(aliasBDir, "sessions");
	symlinkSync(sharedDir, aliasASessions);
	symlinkSync(sharedDir, aliasBSessions);

	const parentRealPath = join(sharedDir, "parent.jsonl");
	const childRealPath = join(sharedDir, "child.jsonl");
	writeFileSync(parentRealPath, "parent\n");
	writeFileSync(childRealPath, "child\n");

	return {
		baseDir,
		parentAliasA: join(aliasASessions, "parent.jsonl"),
		parentAliasB: join(aliasBSessions, "parent.jsonl"),
		childAliasB: join(aliasBSessions, "child.jsonl"),
	};
}

const CTRL_D = "\x04";
const CTRL_BACKSPACE = "\x1b[127;5u";

describe("session selector path/delete interactions", () => {
	const keybindings = new KeybindingsManager();
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	beforeEach(() => {
		// Ensure test isolation: keybindings are a global singleton
		setKeybindings(new KeybindingsManager());
	});

	beforeAll(() => {
		// session selector uses the global theme instance
		initTheme("dark");
	});
	it("deletes a SQLite session through its selected store after confirmation", async () => {
		const directory = mkdtempSync(join(tmpdir(), "session-selector-sqlite-"));
		tempDirs.push(directory);
		const store = await resolveSessionStore(directory, {
			sessionStore: { kind: "sqlite", path: join(directory, "sessions.sqlite") },
		});
		const manager = await SessionManager.create(store, directory);
		await manager.appendMessage({ role: "user", content: "delete me", timestamp: Date.now() });
		const selector = new SessionSelectorComponent(
			() => SessionManager.list(directory, store),
			() => SessionManager.listAll(store),
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings, deleteSession: (id) => store.delete(id) },
		);
		try {
			await vi.waitFor(() => assert.equal(selector.getSessionList().getSelectedSessionId(), manager.getSessionId()));
			selector.handleInput(CTRL_D);
			assert.ok(await store.readHeader(manager.getSessionId()));
			selector.handleInput("\r");
			await vi.waitFor(async () => assert.equal(await store.readHeader(manager.getSessionId()), undefined));
		} finally {
			selector.dispose();
			await store.close();
		}
	});
	it("does not treat Ctrl+Backspace as delete when search query is non-empty", async () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);

		list.handleInput("a");
		list.handleInput(CTRL_BACKSPACE);

		expect(confirmationChanges).toEqual([]);
	});

	it("enters confirmation mode on Ctrl+D even with a non-empty search query", async () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);

		list.handleInput("a");
		list.handleInput(CTRL_D);

		expect(confirmationChanges).toEqual([sessions[0]!.path]);
	});

	it("enters confirmation mode on Ctrl+Backspace when search query is empty", async () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);

		let deletedPath: string | null = null;
		list.onDeleteSession = async (sessionPath) => {
			deletedPath = sessionPath;
		};

		list.handleInput(CTRL_BACKSPACE);
		expect(confirmationChanges).toEqual([sessions[0]!.path]);

		list.handleInput("\r");
		expect(confirmationChanges).toEqual([sessions[0]!.path, null]);
		expect(deletedPath).toBe(sessions[0]!.path);
	});

	it("does not switch scope back to All when All load resolves after toggling back to Current", async () => {
		const currentSessions = [makeSession({ id: "current" })];
		const allDeferred = createDeferred<SessionInfo[]>();
		let allLoadCalls = 0;

		const selector = new SessionSelectorComponent(
			async () => currentSessions,
			async () => {
				allLoadCalls++;
				return allDeferred.promise;
			},
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		list.handleInput("\t"); // current -> all (starts async load)
		list.handleInput("\t"); // all -> current

		allDeferred.resolve([makeSession({ id: "all" })]);
		await flushPromises();

		expect(allLoadCalls).toBe(1);
		const output = selector.render(120).join("\n");
		expect(output).toContain("Resume Session (Current Folder)");
		expect(output).not.toContain("Resume Session (All)");
	});

	it("does not start redundant All loads when toggling scopes while All is already loading", async () => {
		const currentSessions = [makeSession({ id: "current" })];
		const allDeferred = createDeferred<SessionInfo[]>();
		let allLoadCalls = 0;

		const selector = new SessionSelectorComponent(
			async () => currentSessions,
			async () => {
				allLoadCalls++;
				return allDeferred.promise;
			},
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		list.handleInput("\t"); // current -> all (starts async load)
		list.handleInput("\t"); // all -> current
		list.handleInput("\t"); // current -> all again while load pending

		expect(allLoadCalls).toBe(1);

		allDeferred.resolve([makeSession({ id: "all" })]);
		await flushPromises();
	});

	it("threads sessions when parent and child paths use different symlink aliases", async () => {
		const paths = createSymlinkedSessionPaths();
		tempDirs.push(paths.baseDir);

		const sessions = [
			makeSession({
				id: "parent",
				path: paths.parentAliasB,
				name: "Parent",
				modified: new Date("2026-01-01T00:00:00.000Z"),
			}),
			makeSession({
				id: "child",
				path: paths.childAliasB,
				parentSessionPath: paths.parentAliasA,
				name: "Child",
				modified: new Date("2025-12-31T00:00:00.000Z"),
			}),
		];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("Parent");
		expect(output).toContain("└─ Child");
	});

	it("treats the current session as active across symlink aliases", async () => {
		const paths = createSymlinkedSessionPaths();
		tempDirs.push(paths.baseDir);

		const sessions = [makeSession({ id: "parent", path: paths.parentAliasB, name: "Parent" })];
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
			{ id: "parent", directory: dirname(paths.parentAliasA) },
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		let errorMessage: string | undefined;
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);
		list.onError = (message) => {
			errorMessage = message;
		};

		list.handleInput(CTRL_D);

		expect(confirmationChanges).toEqual([]);
		expect(errorMessage).toBe("Cannot delete the currently active session");
	});

	it("keeps the next session selected when a progressive reload after delete starts with another session (#12106)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-selector-"));
		tempDirs.push(dir);
		const sessions = [1, 2, 3, 4, 5].map((i) => {
			const path = join(dir, `s${i}.jsonl`);
			writeFileSync(path, "session\n");
			return makeSession({ id: `s${i}`, path, modified: new Date(10_000 - i * 1000) });
		});

		const selector = new SessionSelectorComponent(
			async (onProgress) => {
				const remaining = sessions.filter((session) => existsSync(session.path));
				onProgress?.(1, remaining.length, [remaining[remaining.length - 1]!]);
				onProgress?.(remaining.length, remaining.length, remaining);
				return remaining;
			},
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		list.handleInput("\x1b[B");
		assert.equal(list.getSelectedSessionPath(), sessions[1]!.path);

		list.handleInput(CTRL_D);
		list.handleInput("\r");
		await vi.waitFor(() => {
			assert.equal(existsSync(sessions[1]!.path), false);
			assert.equal(list.getSelectedSessionPath(), sessions[2]!.path);
		});

		list.handleInput("\x1b[A");
		assert.equal(list.getSelectedSessionPath(), sessions[0]!.path);
		list.handleInput(CTRL_D);
		list.handleInput("\r");
		await vi.waitFor(() => {
			assert.equal(existsSync(sessions[0]!.path), false);
			assert.equal(list.getSelectedSessionPath(), sessions[2]!.path);
		});
	});

	it("handles untouched progressive loads, scope toggles, and user navigation during partial reloads (#12106)", async () => {
		const s1 = makeSession({
			id: "s1",
			path: "/tmp/s1.jsonl",
			cwd: "/proj/a",
			firstMessage: "msg-s1",
			modified: new Date(5000),
		});
		const s2 = makeSession({
			id: "s2",
			path: "/tmp/s2.jsonl",
			cwd: "/proj/a",
			firstMessage: "msg-s2",
			modified: new Date(4000),
		});
		const s3 = makeSession({
			id: "s3",
			path: "/tmp/s3.jsonl",
			cwd: "/proj/b",
			firstMessage: "msg-s3",
			modified: new Date(3000),
		});
		const emptyDraft = makeSession({
			id: "empty",
			path: "/tmp/empty.jsonl",
			messageCount: 0,
			firstMessage: "empty-draft",
		});
		let emitCurrentProgress: ((loaded: number, total: number, partial?: readonly SessionInfo[]) => void) | undefined;
		let emitAllProgress: ((loaded: number, total: number, partial?: readonly SessionInfo[]) => void) | undefined;
		const currentInitial = createDeferred<SessionInfo[]>();
		const allLoad = createDeferred<SessionInfo[]>();
		let allLoadCalls = 0;
		const requestRender = vi.fn();

		const selector = new SessionSelectorComponent(
			(onProgress) => {
				emitCurrentProgress = onProgress;
				return currentInitial.promise;
			},
			(onProgress) => {
				allLoadCalls += 1;
				emitAllProgress = onProgress;
				return allLoad.promise;
			},
			() => {},
			() => {},
			() => {},
			requestRender,
			{ keybindings },
		);

		const list = selector.getSessionList();
		const rendersBeforeProgress = requestRender.mock.calls.length;
		emitCurrentProgress?.(1, 3, [s2, emptyDraft]);
		assert.equal(requestRender.mock.calls.length, rendersBeforeProgress + 1);
		assert.equal(list.getSelectedSessionPath(), s2.path);
		const progressFrame = stripAnsi(selector.render(120).join("\n"));
		assert.equal(progressFrame.includes("Loading 1/3"), true);
		assert.equal(progressFrame.includes("empty-draft"), false);
		assert.equal(progressFrame.includes("/proj/a"), false);

		const rendersBeforeToggleToAll = requestRender.mock.calls.length;
		list.handleInput("\t");
		assert.equal(requestRender.mock.calls.length > rendersBeforeToggleToAll, true);
		assert.equal(allLoadCalls, 1);

		list.handleInput("\t");
		const backToLoadingCurrent = stripAnsi(selector.render(120).join("\n"));
		assert.equal(backToLoadingCurrent.includes("Loading ..."), true);
		assert.equal(backToLoadingCurrent.includes("msg-s2"), true);
		assert.equal(backToLoadingCurrent.includes("/proj/a"), false);

		const rendersBeforeBgAllProgress = requestRender.mock.calls.length;
		emitAllProgress?.(2, 3, [s3]);
		assert.equal(requestRender.mock.calls.length, rendersBeforeBgAllProgress);
		const duringBgAllFrame = stripAnsi(selector.render(120).join("\n"));
		assert.equal(duringBgAllFrame.includes("Loading ..."), true);
		assert.equal(duringBgAllFrame.includes("Loading 2/3"), false);
		assert.equal(duringBgAllFrame.includes("msg-s3"), false);

		currentInitial.resolve([s1, s2]);
		await flushPromises();
		assert.equal(list.getSelectedSessionPath(), s1.path);
		assert.equal(stripAnsi(selector.render(120).join("\n")).includes("◉ Current Folder"), true);

		list.handleInput("\x1b[B");
		assert.equal(list.getSelectedSessionPath(), s2.path);

		list.handleInput("\t");
		const partialAllFrame = stripAnsi(selector.render(120).join("\n"));
		assert.equal(partialAllFrame.includes("Loading ..."), true);
		assert.equal(partialAllFrame.includes("msg-s3"), true);
		assert.equal(partialAllFrame.includes("/proj/b"), true);

		list.handleInput("\t");
		const settledCurrentFrame = stripAnsi(selector.render(120).join("\n"));
		assert.equal(settledCurrentFrame.includes("◉ Current Folder"), true);
		assert.equal(settledCurrentFrame.includes("/proj/a"), false);
		assert.equal(list.getSelectedSessionPath(), s2.path);

		list.handleInput("\t");
		emitAllProgress?.(3, 3, [s1, s2, s3]);
		assert.equal(list.getSelectedSessionPath(), s2.path);
		allLoad.resolve([s1, s3]);
		await flushPromises();
		assert.equal(list.getSelectedSessionPath(), s3.path);
		assert.equal(stripAnsi(selector.render(120).join("\n")).includes("◉ All"), true);

		list.handleInput("\t");
		list.handleInput("\x1b[A");
		list.handleInput("\x1b[B");
		assert.equal(list.getSelectedSessionPath(), s2.path);
		const rendersBeforeLoadedToggle = requestRender.mock.calls.length;
		list.handleInput("\t");
		assert.equal(requestRender.mock.calls.length, rendersBeforeLoadedToggle + 1);
		assert.equal(allLoadCalls, 1);
		assert.equal(list.getSelectedSessionPath(), s3.path);
		list.setSessions([s2, s1, s3], true, false);
		assert.equal(list.getSelectedSessionPath(), s3.path);

		const firstToggleSelector = new SessionSelectorComponent(
			async () => [s1, s2],
			async () => [s1, s2],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();
		const firstToggleList = firstToggleSelector.getSessionList();
		firstToggleList.handleInput("\x1b[B");
		assert.equal(firstToggleList.getSelectedSessionPath(), s2.path);
		firstToggleList.handleInput("\t");
		await flushPromises();
		assert.equal(firstToggleList.getSelectedSessionPath(), s2.path);

		const s0 = makeSession({
			id: "s0",
			path: "/tmp/s0.jsonl",
			cwd: "/proj/a",
			firstMessage: "msg-s0",
			modified: new Date(6000),
		});
		list.setSessions([s0, s1, s2, s3], true, false);
		list.handleInput("\x1b[A");
		list.handleInput("\x1b[A");
		assert.equal(list.getSelectedSessionPath(), s1.path);
		list.setSessions([s2, s3], true, true);
		assert.equal(list.getSelectedSessionPath(), s3.path);
		list.setSessions([s1, s2, s3], true, false);
		assert.equal(list.getSelectedSessionPath(), s1.path);

		list.setSessions([s3], true, true);
		list.handleInput("\x1b[B");
		list.setSessions([s1, s3], true, false);
		assert.equal(list.getSelectedSessionPath(), s3.path);

		selector.dispose();
		emitAllProgress?.(1, 1, [s2]);
		assert.equal(list.getSelectedSessionPath(), s3.path);
	});
});
