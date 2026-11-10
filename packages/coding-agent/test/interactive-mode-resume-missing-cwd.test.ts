import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MissingSessionCwdError } from "../src/core/session-cwd.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.ts";
import type { SessionStore } from "../src/core/storage/session/types.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import type { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import type { MissingCwdForkSource } from "../src/modes/interactive/interactive-mode-surface.ts";

type SwitchOptions = {
	cwdOverride?: string;
	sessionDirectory?: string;
	withSession?: unknown;
	projectTrustContextFactory?: (cwd: string) => unknown;
};
type SwitchSession = (sessionId: string, options?: SwitchOptions) => Promise<{ cancelled: boolean }>;

type InteractiveModePrototype = {
	handleResumeSession(
		this: InteractiveModeBase,
		sessionId: string,
		options?: { withSession?: unknown },
		sessionDirectory?: string,
	): Promise<{ cancelled: boolean }>;
	switchToForkedSession(
		this: InteractiveModeBase,
		source: MissingCwdForkSource,
		cwd: string,
		options?: { withSession?: unknown },
	): Promise<{ cancelled: boolean }>;
	promptForMissingSessionCwd: unknown;
};

const prototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

type Choice = "continue" | "fork" | undefined;

const roots: string[] = [];
const openStores: SessionStore[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const store of openStores.splice(0)) await store.close().catch(() => undefined);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function listIds(store: SessionStore): Promise<string[]> {
	const ids: string[] = [];
	for await (const summary of store.list({})) ids.push(summary.id);
	return ids.sort();
}

async function setup(options: {
	choice: Choice;
	switchCancelled?: boolean;
	sourceInActiveStore?: boolean;
	memoryActiveStore?: boolean;
}) {
	const root = mkdtempSync(join(tmpdir(), "atomic-resume-missing-cwd-"));
	roots.push(root);
	const currentCwd = join(root, "current");
	const missingCwd = join(root, "renamed-away");
	mkdirSync(currentCwd, { recursive: true });
	const currentDirectory = join(root, "current-sessions");
	const oldDirectory = join(root, "old-sessions");

	const current = options.memoryActiveStore
		? await SessionManager.create(new MemorySessionStore(), currentCwd)
		: await SessionManager.create(currentCwd, currentDirectory);
	await current.appendMessage({ role: "user", content: "current", timestamp: 1 });
	const activeStore = current.getSessionStore();
	openStores.push(activeStore);

	const source = options.sourceInActiveStore
		? await SessionManager.create(activeStore, missingCwd)
		: await SessionManager.create(missingCwd, oldDirectory);
	await source.appendMessage({ role: "user", content: "hello from the old project", timestamp: 2 });
	if (source.getSessionStore() !== activeStore) openStores.push(source.getSessionStore());
	const sourceId = source.getSessionId();
	const sourceDirectory = options.sourceInActiveStore ? undefined : oldDirectory;
	const originalEntries = source.getEntries();

	const switchSession = vi.fn<SwitchSession>(async (id, switchOptions) => {
		if (id === sourceId && switchOptions?.cwdOverride === undefined) {
			throw new MissingSessionCwdError({ sessionFile: "x.jsonl", sessionCwd: missingCwd, fallbackCwd: currentCwd });
		}
		return { cancelled: options.switchCancelled === true };
	});
	const showStatus = vi.fn();
	const renderCurrentSessionState = vi.fn();
	const startSessionRecovery = vi.fn();
	const showExtensionSelector = vi.fn(async (_title: string, labels: string[]) => {
		const index = ["continue", "fork", undefined].indexOf(options.choice);
		return labels[index];
	});
	const host = {
		statusContainer: new Container(),
		settingsManager: { getClearOnShrink: () => false },
		ensureDeferredStartupComplete: async () => {},
		clearWorkingLoader() {},
		firstRunNoticeVisible: false,
		clearFirstRunOnboardingUi: vi.fn(),
		sessionManager: current,
		runtimeHost: { switchSession, takeResumeNotices: () => [] },
		renderCurrentSessionState,
		startSessionRecovery,
		showStatus,
		showExtensionSelector,
		createProjectTrustContext: vi.fn(() => ({})),
		handleFatalRuntimeError: vi.fn(async () => {
			throw new Error("unexpected fatal error");
		}),
		promptForMissingSessionCwd: prototype.promptForMissingSessionCwd,
		switchToForkedSession: prototype.switchToForkedSession,
	};
	const resume = (resumeOptions?: { withSession?: unknown }) =>
		prototype.handleResumeSession.call(
			host as unknown as InteractiveModeBase,
			sourceId,
			resumeOptions,
			sourceDirectory,
		);
	return {
		host,
		resume,
		activeStore,
		currentCwd,
		missingCwd,
		sourceId,
		sourceDirectory,
		originalEntries,
		current,
		switchSession,
		showStatus,
		renderCurrentSessionState,
		startSessionRecovery,
		showExtensionSelector,
		root,
	};
}

describe("InteractiveMode /resume with a missing session cwd (earendil-works/pi#11060)", () => {
	it("asks with the three options and the stored cwd", async () => {
		const { resume, showExtensionSelector, currentCwd, missingCwd } = await setup({ choice: undefined });

		await resume();

		expect(showExtensionSelector).toHaveBeenCalledTimes(1);
		expect(showExtensionSelector).toHaveBeenCalledWith(`Session cwd does not exist: ${missingCwd}`, [
			`Continue in ${currentCwd} (asks again next time)`,
			`Fork into ${currentCwd} (new session ID, original kept)`,
			"Cancel",
		]);
	});

	it("forks the session into the current store and leaves the original unchanged", async () => {
		const setupResult = await setup({ choice: "fork" });
		const { resume, activeStore, currentCwd, sourceId, originalEntries, switchSession } = setupResult;
		const { showStatus, renderCurrentSessionState, startSessionRecovery, current } = setupResult;
		const withSession = vi.fn();

		const result = await resume({ withSession });

		expect(result).toEqual({ cancelled: false });
		expect(switchSession).toHaveBeenCalledTimes(2);
		const [forkId, forkOptions] = switchSession.mock.calls[1] ?? [];
		expect(forkId).not.toBe(sourceId);
		expect(forkOptions?.cwdOverride).toBeUndefined();
		expect(forkOptions?.sessionDirectory).toBeUndefined();
		expect(forkOptions?.withSession).toBe(withSession);
		expect(forkOptions?.projectTrustContextFactory?.(currentCwd)).toEqual({});

		const forked = await activeStore.load(forkId ?? "");
		expect(forked.header.cwd).toBe(currentCwd);
		expect(forked.header.parentSessionId).toBe(sourceId);
		expect(forked.entries).toEqual(originalEntries);
		expect(await listIds(activeStore)).toEqual([current.getSessionId(), forkId].sort());
		expect(showStatus).toHaveBeenCalledWith(`Forked into new session ${forkId} in ${currentCwd}`);
		expect(renderCurrentSessionState).toHaveBeenCalledTimes(1);
		expect(setupResult.host.clearFirstRunOnboardingUi).not.toHaveBeenCalled();
		expect(startSessionRecovery).toHaveBeenCalledWith("resume");

		const reopened = await current.openSessionById(sourceId, undefined, setupResult.sourceDirectory);
		openStores.push(reopened.getSessionStore());
		expect(reopened.getCwd()).toBe(setupResult.missingCwd);
		expect(reopened.getEntries()).toEqual(originalEntries);
	});

	it("forks a session the active store already holds without opening another store", async () => {
		const { resume, activeStore, currentCwd, sourceId, switchSession, current } = await setup({
			choice: "fork",
			sourceInActiveStore: true,
		});

		await resume();

		const forkId = switchSession.mock.calls[1]?.[0] ?? "";
		const forked = await activeStore.load(forkId);
		expect(forked.header).toMatchObject({ cwd: currentCwd, parentSessionId: sourceId });
		expect((await activeStore.load(sourceId)).header.cwd).not.toBe(currentCwd);
		expect(await listIds(activeStore)).toEqual([current.getSessionId(), sourceId, forkId].sort());
	});

	it("closes the store it opened to read the session and never the active one", async () => {
		const stores = await import("../src/core/storage/session/jsonl-session-store.ts");
		const closed = vi.spyOn(stores.JsonlSessionStore.prototype, "close");
		for (const sourceInActiveStore of [false, true]) {
			const { resume, activeStore } = await setup({ choice: "fork", sourceInActiveStore });
			closed.mockClear();

			await resume();

			expect(closed).toHaveBeenCalledTimes(1);
			expect(closed.mock.contexts[0]).not.toBe(activeStore);
		}
	});

	it("leaves an active store that also holds the session open", async () => {
		const { resume, activeStore, current, sourceId, switchSession } = await setup({
			choice: "fork",
			sourceInActiveStore: true,
			memoryActiveStore: true,
		});
		const close = vi.spyOn(activeStore, "close");

		await resume();

		expect(close).not.toHaveBeenCalled();
		const forkId = switchSession.mock.calls[1]?.[0] ?? "";
		expect(await listIds(activeStore)).toEqual([current.getSessionId(), sourceId, forkId].sort());
	});

	it("cancels when the selector is dismissed without choosing an option", async () => {
		const { resume, host, switchSession, showStatus } = await setup({ choice: "fork" });
		host.showExtensionSelector.mockResolvedValueOnce(undefined);

		const result = await resume();

		expect(result).toEqual({ cancelled: true });
		expect(switchSession).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith("Resume cancelled");
	});

	it("shows the first-run onboarding as finished once the session switched", async () => {
		const { resume, host } = await setup({ choice: "fork" });
		host.firstRunNoticeVisible = true;

		await resume();

		expect(host.clearFirstRunOnboardingUi).toHaveBeenCalledTimes(1);
	});

	it("continues the original session in the current cwd without writing a copy", async () => {
		const setupResult = await setup({ choice: "continue" });
		const { resume, activeStore, currentCwd, sourceId, sourceDirectory, switchSession, showStatus, current } =
			setupResult;
		const withSession = vi.fn();

		const result = await resume({ withSession });

		expect(result).toEqual({ cancelled: false });
		expect(switchSession).toHaveBeenCalledTimes(2);
		expect(switchSession.mock.calls[1]?.[0]).toBe(sourceId);
		expect(switchSession.mock.calls[1]?.[1]).toMatchObject({
			cwdOverride: currentCwd,
			sessionDirectory: sourceDirectory,
			withSession,
		});
		const continueOptions = switchSession.mock.calls[1]?.[1];
		expect(continueOptions?.projectTrustContextFactory?.(currentCwd)).toEqual({});
		expect(setupResult.host.createProjectTrustContext).toHaveBeenCalledWith(currentCwd);
		expect(setupResult.host.clearFirstRunOnboardingUi).not.toHaveBeenCalled();
		expect(await listIds(activeStore)).toEqual([current.getSessionId()]);
		expect(showStatus).toHaveBeenCalledWith(`Resumed session in ${currentCwd}`);
		expect(setupResult.startSessionRecovery).toHaveBeenCalledWith("resume");
	});

	it("shows the resumed transcript before it starts recovery after Continue", async () => {
		const order: string[] = [];
		const { resume, host } = await setup({ choice: "continue" });
		host.renderCurrentSessionState.mockImplementation(() => order.push("render"));
		host.showStatus.mockImplementation((message: string) => order.push(`status:${message}`));
		host.startSessionRecovery.mockImplementation(() => order.push("recover"));
		host.firstRunNoticeVisible = true;
		host.clearFirstRunOnboardingUi.mockImplementation(() => order.push("clear-first-run"));

		await resume();

		expect(order).toEqual([
			"render",
			"clear-first-run",
			expect.stringMatching(/^status:Resumed session in /),
			"recover",
		]);
	});

	it("starts no recovery when an extension cancels the continued switch", async () => {
		const { resume, showStatus, startSessionRecovery, renderCurrentSessionState } = await setup({
			choice: "continue",
			switchCancelled: true,
		});

		expect(await resume()).toEqual({ cancelled: true });

		expect(showStatus).not.toHaveBeenCalled();
		expect(renderCurrentSessionState).not.toHaveBeenCalled();
		expect(startSessionRecovery).not.toHaveBeenCalled();
	});

	it("removes the fork when an extension cancels the switch to it", async () => {
		const { resume, activeStore, current, showStatus, startSessionRecovery } = await setup({
			choice: "fork",
			switchCancelled: true,
		});

		const result = await resume();

		expect(result).toEqual({ cancelled: true });
		expect(await listIds(activeStore)).toEqual([current.getSessionId()]);
		expect(showStatus).not.toHaveBeenCalled();
		expect(startSessionRecovery).not.toHaveBeenCalled();
	});

	it("creates no copy and keeps the current session when the user cancels", async () => {
		const { resume, activeStore, current, switchSession, showStatus, startSessionRecovery } = await setup({
			choice: undefined,
		});

		const result = await resume();

		expect(result).toEqual({ cancelled: true });
		expect(switchSession).toHaveBeenCalledTimes(1);
		expect(await listIds(activeStore)).toEqual([current.getSessionId()]);
		expect(showStatus).toHaveBeenCalledWith("Resume cancelled");
		expect(startSessionRecovery).not.toHaveBeenCalled();
	});

	it("hands any failure other than a missing cwd to the fatal-error path", async () => {
		const { resume, host, switchSession } = await setup({ choice: "fork" });
		const failure = new Error("storage is down");
		switchSession.mockRejectedValueOnce(failure);

		await expect(resume()).rejects.toThrow("unexpected fatal error");

		expect(host.handleFatalRuntimeError).toHaveBeenCalledWith("Failed to resume session", failure);
	});
});

describe("InteractiveMode forking a session export whose cwd is missing (earendil-works/pi#11060)", () => {
	it("copies the export into the current store under a new id and switches to the copy", async () => {
		const { host, activeStore, currentCwd, missingCwd, switchSession, showStatus, current, root } = await setup({
			choice: "fork",
		});
		const exportSource = await SessionManager.create(missingCwd, join(root, "exports"));
		await exportSource.appendMessage({ role: "user", content: "exported", timestamp: 3 });
		openStores.push(exportSource.getSessionStore());
		const exportPath = exportSource.getSessionFile() ?? "";

		const result = await prototype.switchToForkedSession.call(
			host as unknown as InteractiveModeBase,
			{ exportPath },
			currentCwd,
		);

		expect(result).toEqual({ cancelled: false });
		const forkId = switchSession.mock.calls[0]?.[0] ?? "";
		expect(forkId).not.toBe(exportSource.getSessionId());
		const forked = await activeStore.load(forkId);
		expect(forked.header).toMatchObject({ cwd: currentCwd, parentSessionId: exportSource.getSessionId() });
		expect(forked.entries).toEqual(exportSource.getEntries());
		expect(await listIds(activeStore)).toEqual([current.getSessionId(), forkId].sort());
		expect(showStatus).toHaveBeenCalledWith(`Forked into new session ${forkId} in ${currentCwd}`);
	});

	it("leaves no copy when an extension cancels the switch", async () => {
		const { host, activeStore, currentCwd, missingCwd, current, root } = await setup({
			choice: "fork",
			switchCancelled: true,
		});
		const exportSource = await SessionManager.create(missingCwd, join(root, "exports"));
		await exportSource.appendMessage({ role: "user", content: "exported", timestamp: 3 });
		openStores.push(exportSource.getSessionStore());

		const result = await prototype.switchToForkedSession.call(
			host as unknown as InteractiveModeBase,
			{ exportPath: exportSource.getSessionFile() ?? "" },
			currentCwd,
		);

		expect(result).toEqual({ cancelled: true });
		expect(await listIds(activeStore)).toEqual([current.getSessionId()]);
	});
});
