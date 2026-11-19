import assert from "node:assert/strict";
import type { FSWatcher, Stats, WatchFileOptions, WatchListener } from "node:fs";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, unwatchFile } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { afterEach, test, vi } from "vitest";
import { FooterDataProvider } from "../../packages/coding-agent/src/core/footer-data-provider.js";
import { FooterComponent } from "../../packages/coding-agent/src/modes/interactive/components/footer.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import * as fsWatch from "../../packages/coding-agent/src/utils/fs-watch.js";
import { fakeFooterAgentSession } from "../helpers/footer-session.js";
import { writeFileEnsuringDir } from "../helpers/runtime.js";

const observed = vi.hoisted(() => [] as Array<{ path: string; watcher: FSWatcher; closed: boolean }>);
const polling = vi.hoisted(() => new Set<string>());
const watchFailure = vi.hoisted(() => ({ path: "", attempts: 0 }));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		watchFile(
			path: string,
			options: WatchFileOptions & { bigint?: false },
			listener: (current: Stats, previous: Stats) => void,
		) {
			polling.add(path);
			return fs.watchFile(path, options, listener);
		},
		unwatchFile(path: string, listener?: (current: Stats, previous: Stats) => void) {
			polling.delete(path);
			return fs.unwatchFile(path, listener);
		},
		watch(path: string, listener: WatchListener<string>) {
			if (watchFailure.path && fs.realpathSync.native(path) === watchFailure.path) {
				watchFailure.attempts++;
				throw Object.assign(new Error(`EMFILE opening ${path}`), { code: "EMFILE" });
			}
			const watcher = fs.watch(path, listener);
			const record = { path, watcher, closed: false };
			observed.push(record);
			const close = watcher.close.bind(watcher);
			vi.spyOn(watcher, "close").mockImplementation(() => {
				record.closed = true;
				return close();
			});
			return watcher;
		},
	};
});

afterEach(() => {
	for (const record of observed) record.watcher.close();
	observed.length = 0;
	watchFailure.path = "";
	watchFailure.attempts = 0;
	vi.useRealTimers();
});

// Native Windows watchers canonicalize aliases and short temp paths before opening.
const liveAt = (path: string) => {
	const canonical = realpathSync.native(path);
	return observed.filter((record) => !record.closed && realpathSync.native(record.path) === canonical);
};
const live = (cwd: string) => liveAt(join(cwd, ".git"));

const eventually = (assertion: () => void) => vi.waitFor(assertion);
const renderedUntil = async (render: () => string[], pattern: RegExp) =>
	eventually(() => assert.match(stripAnsi(render().join("\n")), pattern));

// PR #2926: keep simultaneous viewers live, but release the final viewer's cwd.
test("footer disposal and cwd replacement release only unused branch watchers", async () => {
	initTheme("dark", false);
	const directory = mkdtempSync(join(tmpdir(), "footer-lifetime-"));
	const main = join(directory, "main");
	const stage = join(directory, "stage");
	const next = join(directory, "next");
	for (const [cwd, branch] of [
		[main, "main"],
		[stage, "stage"],
		[next, "next"],
	]) {
		await writeFileEnsuringDir(join(cwd, ".git/HEAD"), `ref: refs/heads/${branch}\n`);
	}
	const provider = new FooterDataProvider(main);
	const session = fakeFooterAgentSession();
	let cwd = stage;
	session.sessionManager.getCwd = () => cwd;
	const first = new FooterComponent(session, provider);
	const second = new FooterComponent(session, provider);
	provider.startGitWatcher();
	try {
		await renderedUntil(() => first.render(160), /\(stage\)/);
		second.render(160);
		await eventually(() => assert.equal(live(stage).length, 1, "viewers of the same cwd share a watcher"));
		first.dispose();
		assert.equal(live(stage).length, 1, "one viewer cannot evict its sibling");
		cwd = next;
		second.render(160);
		assert.equal(live(stage).length, 0, "replacement releases the last viewer of the old cwd");
		await renderedUntil(() => second.render(160), /\(next\)/);
		await eventually(() => assert.equal(live(next).length, 1));
		second.dispose();
		second.dispose();
		assert.equal(live(next).length, 0, "viewer disposal closes its alternate watcher");
		assert.equal(live(main).length, 1, "main provider remains live");
		first.render(160);
		second.render(160);
		assert.equal(live(next).length, 0, "disposed viewers cannot reacquire watchers");
	} finally {
		first.dispose();
		second.dispose();
		provider.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
});

// PR #2926: stage renders share one footer lease owned by the chat host.
// PR #2926: an already queued native error must not resurrect a released child.
test("released branch subscriptions reject late watcher errors and pending refreshes", async () => {
	const directory = mkdtempSync(join(tmpdir(), "released-footer-"));
	const cwd = join(directory, "stage");
	const head = join(cwd, ".git/HEAD");
	await writeFileEnsuringDir(head, "ref: refs/heads/stage\n");
	const provider = new FooterDataProvider(directory);
	const callback = vi.fn();
	const release = provider.onBranchChange(callback, cwd);
	await eventually(() => assert.equal(provider.getGitBranch(cwd), "stage"));
	provider.startGitWatcher();
	await eventually(() => assert.equal(live(cwd).length, 1));
	callback.mockClear();
	vi.useFakeTimers();
	try {
		const watcher = live(cwd)[0].watcher;
		const onError = watcher.listeners("error")[0];
		watcher.emit("change", "rename", "HEAD");
		release();
		release();
		onError(
			Object.assign(new Error("late canonicalization failure"), {
				code: "ERR_SAFE_FS_WATCH_CANONICALIZATION_FAILED",
				watchedPath: cwd,
			}),
		);
		assert.equal(polling.size, 0, "a late error cannot install polling after release");
		await vi.advanceTimersByTimeAsync(6000);
		assert.equal(live(cwd).length, 0);
		assert.equal(callback.mock.calls.length, 0);
		assert.equal(vi.getTimerCount(), 0);
		provider.dispose();
		provider.onBranchChange(callback, cwd)();
		provider.setCwd(cwd);
		provider.startGitWatcher();
		assert.equal(provider.getGitBranch(cwd), null);
		assert.equal(live(cwd).length, 0);
	} finally {
		release();
		provider.dispose();
		for (const path of polling) (await import("node:fs")).unwatchFile(path);
		rmSync(directory, { recursive: true, force: true });
	}
});

// PR #2926: changing the primary cwd cannot evict its still-visible old viewer.
test("parent cwd replacement preserves leased branches and rejects old in-flight results", async () => {
	const directory = mkdtempSync(join(tmpdir(), "replaced-footer-"));
	const main = join(directory, "main");
	const stage = join(directory, "stage");
	await writeFileEnsuringDir(join(main, ".git/HEAD"), "ref: refs/heads/main\n");
	await writeFileEnsuringDir(join(stage, ".git/HEAD"), "ref: refs/heads/stage\n");
	const provider = new FooterDataProvider(main);
	const callback = vi.fn();
	const releaseMain = provider.onBranchChange(callback, main);
	const releaseStage = provider.onBranchChange(callback, stage);
	const releaseStageSibling = provider.onBranchChange(callback, stage);
	await eventually(() => assert.equal(provider.getGitBranch(), "main"));
	await eventually(() => assert.equal(provider.getGitBranch(stage), "stage"));
	assert.equal(observed.length, 0, "leases respect lazy watcher startup");
	provider.startGitWatcher();
	await eventually(() => assert.equal(live(main).length + live(stage).length, 2));
	vi.useFakeTimers();
	try {
		const oldWatcher = live(main)[0].watcher;
		await writeFileEnsuringDir(join(main, ".git/HEAD"), "ref: refs/heads/old-update\n");
		oldWatcher.emit("change", "rename", "HEAD");
		vi.advanceTimersByTime(500);
		provider.setCwd(stage);
		await eventually(() => assert.equal(provider.getGitBranch(), "stage"));
		await Promise.resolve();
		assert.equal(provider.getGitBranch(), "stage", "an old refresh cannot overwrite the replacement cwd");
		await eventually(() => assert.equal(provider.getGitBranch(main), "old-update"));
		await eventually(() => assert.equal(live(main).length, 1));
		await eventually(() =>
			assert.equal(live(stage).length, 1, "promoting a leased cwd must not duplicate its watcher"),
		);
		oldWatcher.emit("error", new Error("late EMFILE from replaced watcher"));
		assert.equal(live(stage).length, 1, "stale watcher errors cannot tear down the replacement watcher");
		releaseStage();
		releaseStage();
		callback.mockClear();
		await writeFileEnsuringDir(join(stage, ".git/HEAD"), "ref: refs/heads/live-stage\n");
		live(stage)[0].watcher.emit("change", "rename", "HEAD");
		await vi.advanceTimersByTimeAsync(500);
		await eventually(() => assert.equal(provider.getGitBranch(), "live-stage"));
		assert.equal(callback.mock.calls.length, 2, "identical callbacks have independent scoped subscriptions");
		releaseMain();
		assert.equal(live(main).length, 0);
		releaseStageSibling();
		assert.equal(live(stage).length, 1, "primary cwd remains parent-owned");
		provider.dispose();
		assert.equal(live(stage).length, 0);
	} finally {
		releaseMain();
		releaseStage();
		releaseStageSibling();
		provider.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
});

// PR #2926: ordinary lookups cannot recreate the former unbounded child cache.
test("unleased alternate reads remain fresh without retaining watchers", async () => {
	const directory = mkdtempSync(join(tmpdir(), "unleased-footer-"));
	const provider = new FooterDataProvider(directory);
	const changed = vi.fn();
	provider.onBranchChange(changed);
	provider.startGitWatcher();
	try {
		for (let i = 0; i < 20; i++) {
			const cwd = join(directory, String(i));
			const head = join(cwd, ".git/HEAD");
			await writeFileEnsuringDir(head, "ref: refs/heads/first\n");
			changed.mockClear();
			await eventually(() => assert.equal(provider.getGitBranch(cwd), "first"));
			assert.ok(changed.mock.calls.length > 0, "listeners hear that the read finished, so the viewer repaints");
			await writeFileEnsuringDir(head, "ref: refs/heads/second\n");
			await eventually(() => assert.equal(provider.getGitBranch(cwd), "second"));
		}
		assert.equal(observed.length, 0);
		const missing = join(directory, "missing");
		await writeFileEnsuringDir(join(missing, ".git/HEAD"), "ref: refs/heads/present\n");
		await eventually(() => assert.equal(provider.getGitBranch(missing), "present"));
		rmSync(missing, { recursive: true, force: true });
		await eventually(() => assert.equal(provider.getGitBranch(missing), null));
	} finally {
		provider.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
});

// PR #2926: reftable polling and retry timers belong to the same viewer lease.
test("last release tears down reftable polling and watcher retries", async () => {
	const directory = mkdtempSync(join(tmpdir(), "reftable-footer-lifetime-"));
	const cwd = join(directory, "stage");
	const tables = join(cwd, ".git/reftable/tables.list");
	await writeFileEnsuringDir(join(cwd, ".git/HEAD"), "ref: refs/heads/stage\n");
	await writeFileEnsuringDir(tables, "0\n");
	const provider = new FooterDataProvider(directory);
	const callback = vi.fn();
	let release = provider.onBranchChange(callback, cwd);
	await eventually(() => assert.equal(provider.getGitBranch(cwd), "stage"));
	provider.startGitWatcher();
	await eventually(() => assert.equal(observed.filter((record) => !record.closed).length, 3));
	callback.mockClear();
	vi.useFakeTimers();
	try {
		assert.equal(polling.has(tables), true);
		const lateError = liveAt(tables)[0].watcher.listeners("error")[0];
		release();
		assert.equal(polling.size, 0);
		assert.ok(observed.every((record) => record.closed));
		lateError(
			Object.assign(new Error("late tables.list failure"), {
				code: "ERR_SAFE_FS_WATCH_CANONICALIZATION_FAILED",
				watchedPath: tables,
			}),
		);
		assert.equal(polling.size, 0);
		release = provider.onBranchChange(callback, cwd);
		await eventually(() => assert.equal(live(cwd).length, 1));
		live(cwd)[0].watcher.emit("error", new Error("EMFILE"));
		assert.ok(vi.getTimerCount() > 0, "a live watcher schedules recovery");
		release();
		await vi.advanceTimersByTimeAsync(6000);
		assert.equal(vi.getTimerCount(), 0);
		assert.ok(observed.every((record) => record.closed));
		assert.equal(polling.size, 0);
		assert.equal(callback.mock.calls.length, 0);
	} finally {
		release();
		provider.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
});

// PR #2926: synchronous OS watch failures must not outlive the final alternate-cwd lease.
test("last release removes polling after synchronous tables.list watch failure", async () => {
	const directory = mkdtempSync(join(tmpdir(), "sync-reftable-footer-"));
	const cwd = join(directory, "stage");
	const tables = join(cwd, ".git/reftable/tables.list");
	await writeFileEnsuringDir(join(cwd, ".git/HEAD"), "ref: refs/heads/stage\n");
	await writeFileEnsuringDir(tables, "0\n");
	const provider = new FooterDataProvider(directory);
	const callback = vi.fn();
	const release = provider.onBranchChange(callback, cwd);
	watchFailure.path = realpathSync.native(tables);
	await eventually(() => assert.equal(provider.getGitBranch(cwd), "stage"));
	callback.mockClear();
	vi.useFakeTimers();
	try {
		provider.startGitWatcher();
		await eventually(() =>
			assert.equal(watchFailure.attempts, 1, "the OS-boundary watch installation fails synchronously"),
		);
		assert.equal(vi.getTimerCount(), 1, "the live lease retains its recovery timer");
		release();
		assert.equal(polling.size, 0, "final release removes all polling after synchronous watch failure");
		assert.ok(
			observed.every((record) => record.closed),
			"final release closes all native watchers",
		);
		assert.equal(vi.getTimerCount(), 0, "final release cancels recovery");
		await vi.advanceTimersByTimeAsync(6000);
		assert.equal(watchFailure.attempts, 1, "released recovery cannot install another watcher");
		assert.equal(callback.mock.calls.length, 0);
		assert.equal(polling.size, 0);
		assert.equal(vi.getTimerCount(), 0);
	} finally {
		release();
		provider.dispose();
		for (const path of polling) unwatchFile(path);
		rmSync(directory, { recursive: true, force: true });
	}
});

// PR #2926: Windows opens canonical paths even when the viewer cwd uses an alias.
test("canonical native watch paths retain alias-cwd leases until the last release", async () => {
	const directory = mkdtempSync(join(tmpdir(), "canonical-footer-lifetime-"));
	const target = join(directory, "stage");
	const cwd = join(directory, "alias");
	await writeFileEnsuringDir(join(target, ".git/HEAD"), "ref: refs/heads/stage\n");
	await writeFileEnsuringDir(join(target, ".git/reftable/tables.list"), "0\n");
	symlinkSync(target, cwd, "junction");
	const watch = fsWatch.watchWithErrorHandlerAsync;
	const canonicalWatch = vi
		.spyOn(fsWatch, "watchWithErrorHandlerAsync")
		.mockImplementation((path, listener, onError) => watch(path, listener, onError, { platform: "win32" }));
	const provider = new FooterDataProvider(directory);
	const first = provider.onBranchChange(() => {}, cwd);
	const second = provider.onBranchChange(() => {}, cwd);
	try {
		provider.startGitWatcher();
		await eventually(() => assert.equal(provider.getGitBranch(cwd), "stage"));
		await eventually(() =>
			assert.equal(observed.length, 3, "real native watchers cover HEAD, reftable and tables.list"),
		);
		assert.notEqual(observed[0].path, join(cwd, ".git"), "the OS receives the canonical target, not the alias");
		assert.equal(live(cwd).length, 1, "canonical watcher lookup finds the aliased viewer's resource");
		assert.equal(liveAt(join(cwd, ".git/reftable/tables.list")).length, 1);
		first();
		assert.equal(live(cwd).length, 1, "the sibling retains its real native watcher");
		assert.equal(polling.size, 1);
		second();
		assert.equal(live(cwd).length, 0);
		assert.equal(liveAt(join(cwd, ".git/reftable/tables.list")).length, 0);
		assert.ok(observed.every((record) => record.closed));
		assert.equal(polling.size, 0);
	} finally {
		first();
		second();
		provider.dispose();
		canonicalWatch.mockRestore();
		rmSync(directory, { recursive: true, force: true });
	}
});
