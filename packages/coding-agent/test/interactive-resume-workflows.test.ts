import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { HostSessionPickerRow } from "../src/core/extensions/ui-types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import type { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import "../src/modes/interactive/interactive-session-routing.ts";
import "../src/modes/interactive/interactive-input-handling.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type SelectorBuilder = (done: () => void) => {
	component: SessionSelectorComponent;
	focus: SessionSelectorComponent;
	dispose?: () => void;
};

let root: string;
const cleanups: (() => void | Promise<void>)[] = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "atomic-mixed-resume-"));
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

async function fixture() {
	const database = await openNodeSqliteDatabase(join(root, "sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	const manager = await SessionManager.create(store, root);
	await manager.appendMessage({ role: "user", content: "Chat objective", timestamp: Date.now() });
	const resumedSessions: string[] = [];
	const resumedRuns: string[] = [];
	const deletedRuns: string[] = [];
	const errors: string[] = [];
	let rows: HostSessionPickerRow[] = [
		{
			path: "workflow-durable:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
			id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
			cwd: "Durable",
			createdAt: Date.now() - 10_000,
			modifiedAt: Date.now(),
			messageCount: 2,
			firstMessage: "Workflow objective",
			allMessagesText: "Workflow objective",
			title: "shipping · Workflow objective",
			detail: "paused · stage 2/3 implement",
		},
	];
	let selector: SessionSelectorComponent | undefined;
	const provider = {
		listResumeEntries: vi.fn(async (_target?: string) => rows),
		resumeFromPicker: vi.fn(async (id: string) => {
			resumedRuns.push(id);
		}),
		deleteResumeEntry: vi.fn(async (id: string) => {
			deletedRuns.push(id);
			rows = rows.filter((row) => row.id !== id);
		}),
	};
	const mode = {
		runtimeHost: {},
		session: {
			extensionRunner: {
				getWorkflowRunControl: () => provider,
				createCommandContext: () => ({ cwd: root }),
			},
		},
		sessionManager: manager,
		keybindings: new KeybindingsManager(),
		ensureDeferredStartupComplete: async () => {},
		ui: { requestRender() {} },
		handleResumeSession: async (id: string) => {
			resumedSessions.push(id);
			return { cancelled: false };
		},
		showError: (message: string) => errors.push(message),
		shutdown: async () => {},
		showSelector: (build: SelectorBuilder) => {
			const mounted = build(() => {});
			selector = mounted.component;
			cleanups.push(() => {
				mounted.dispose?.();
				mounted.component.dispose();
			});
		},
	};
	return {
		mode: mode as unknown as InteractiveModeBase,
		manager,
		provider,
		resumedSessions,
		resumedRuns,
		deletedRuns,
		errors,
		setRows(next: HostSessionPickerRow[]) {
			rows = next;
		},
		get selector() {
			assert.ok(selector);
			return selector;
		},
	};
}

test("the interactive resume picker combines catalogs and routes run selection to its provider (#5256)", async () => {
	const f = await fixture();
	InteractiveModeBase.prototype.showSessionSelector.call(f.mode);
	await vi.waitFor(() => assert.match(f.selector.render(160).join("\n"), /Workflow objective/));
	const rendered = f.selector.render(160).join("\n");
	assert.match(rendered, /Sessions \(1\)/);
	assert.match(rendered, /Workflow runs \(1\)/);
	for (const char of "Workflow objective") f.selector.handleInput(char);
	f.selector.handleInput("\r");
	await vi.waitFor(() => assert.deepEqual(f.resumedRuns, ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]));
	assert.deepEqual(f.resumedSessions, []);
	assert.deepEqual(f.errors, []);
});

test("selecting a workflow after its provider disappears gives actionable feedback (#5256)", async () => {
	const f = await fixture();
	InteractiveModeBase.prototype.showSessionSelector.call(f.mode);
	await vi.waitFor(() => assert.match(f.selector.render(160).join("\n"), /Workflow objective/));
	vi.spyOn(f.mode.session.extensionRunner!, "getWorkflowRunControl").mockReturnValue(undefined);
	for (const char of "Workflow objective") f.selector.handleInput(char);
	f.selector.handleInput("\r");
	await vi.waitFor(() => assert.deepEqual(f.errors, ["Workflow resume is unavailable. Reload Atomic and try again."]));
	assert.deepEqual(f.resumedSessions, []);
	assert.deepEqual(f.resumedRuns, []);
});

test("direct resume resolves workflow prefixes without switching the chat session (#5256)", async () => {
	const f = await fixture();
	await InteractiveModeBase.prototype.handleResumeTarget.call(f.mode, "aaaaaaaa");
	assert.deepEqual(f.resumedRuns, ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]);
	assert.deepEqual(f.provider.listResumeEntries.mock.calls, [["aaaaaaaa"]]);
	assert.deepEqual(f.resumedSessions, []);
	assert.deepEqual(f.errors, []);
});

test("direct resume rejects workflow flags without invoking the provider (#5256)", async () => {
	const f = await fixture();
	await InteractiveModeBase.prototype.handleResumeTarget.call(
		f.mode,
		"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee --accept-entry-changes",
	);
	assert.equal(f.provider.listResumeEntries.mock.calls.length, 0);
	assert.equal(f.provider.resumeFromPicker.mock.calls.length, 0);
	assert.match(f.errors[0]!, /Usage: \/resume/);
});

test("a failed workflow catalog leaves ordinary sessions visible in the picker (#5256)", async () => {
	const f = await fixture();
	f.provider.listResumeEntries.mockRejectedValue(new Error("Workflow history is unavailable"));
	InteractiveModeBase.prototype.showSessionSelector.call(f.mode);
	await vi.waitFor(() => assert.match(f.selector.render(160).join("\n"), /Chat objective/));
	await vi.waitFor(() => assert.match(f.selector.render(160).join("\n"), /Workflow history is unavailable/));
});

test("mixed picker retains previous workflow rows and selection across slow, failed, and out-of-order refreshes while honoring empty catalogs and deletes (#5256)", async () => {
	const f = await fixture();
	const runId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
	let pollCallback: (() => void) | undefined;
	const realSetInterval = globalThis.setInterval;
	vi.spyOn(globalThis, "setInterval").mockImplementation(((handler: TimerHandler, timeout?: number) => {
		if (timeout === 5_000 && typeof handler === "function") {
			pollCallback = handler as () => void;
		}
		return realSetInterval(handler, timeout);
	}) as typeof setInterval);

	InteractiveModeBase.prototype.showSessionSelector.call(f.mode);
	await vi.waitFor(() => assert.match(f.selector.render(160).join("\n"), /Workflow objective/));
	assert.ok(pollCallback);

	f.selector.handleInput("\x1b[B");
	assert.equal(f.selector.getSessionList().getSelectedSessionId(), runId);

	f.provider.listResumeEntries.mockRejectedValueOnce(new Error("Transient metadata failure"));
	pollCallback();
	await vi.waitFor(() => assert.match(f.selector.render(160).join("\n"), /Transient metadata failure/));
	const afterError = f.selector.render(160).join("\n");
	assert.match(afterError, /Sessions \(1\)/);
	assert.match(afterError, /Workflow runs \(1\)/);
	assert.match(afterError, /Workflow objective/);
	assert.equal(f.selector.getSessionList().getSelectedSessionId(), runId);

	let resolveSlowPoll!: (rows: HostSessionPickerRow[]) => void;
	const slowPoll = new Promise<HostSessionPickerRow[]>((resolve) => {
		resolveSlowPoll = resolve;
	});
	f.provider.listResumeEntries.mockImplementationOnce(() => slowPoll);
	pollCallback();
	await vi.waitFor(() => assert.equal(f.provider.listResumeEntries.mock.calls.length, 3));
	await new Promise((resolve) => setTimeout(resolve, 20));
	const duringSlowRefresh = f.selector.render(160).join("\n");
	assert.match(duringSlowRefresh, /Workflow runs \(1\)/);
	assert.match(duringSlowRefresh, /Workflow objective/);
	assert.equal(f.selector.getSessionList().getSelectedSessionId(), runId);

	f.provider.deleteResumeEntry.mockRejectedValueOnce(new Error("Delete rejected"));
	f.selector.handleInput("\x04");
	f.selector.handleInput("\r");
	await vi.waitFor(() => assert.match(f.selector.render(160).join("\n"), /Failed to delete: Delete rejected/));
	assert.match(f.selector.render(160).join("\n"), /Workflow objective/);

	const secondRunId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
	f.setRows([
		{
			path: `workflow-durable:${runId}`,
			id: runId,
			cwd: "Durable",
			createdAt: Date.now() - 10_000,
			modifiedAt: Date.now() - 1_000,
			messageCount: 2,
			firstMessage: "Workflow objective",
			allMessagesText: "Workflow objective",
			title: "shipping · Workflow objective",
			detail: "paused · stage 2/3 implement",
		},
		{
			path: `workflow-durable:${secondRunId}`,
			id: secondRunId,
			cwd: "Durable",
			createdAt: Date.now() - 5_000,
			modifiedAt: Date.now(),
			messageCount: 1,
			firstMessage: "Fresh workflow objective",
			allMessagesText: "Fresh workflow objective",
			title: "deploy · Fresh workflow objective",
			detail: "paused · stage 1/2 verify",
		},
	]);
	f.selector.handleInput("\x04");
	f.selector.handleInput("\r");
	await vi.waitFor(() => assert.deepEqual(f.deletedRuns, [runId]));
	await vi.waitFor(() => assert.match(f.selector.render(160).join("\n"), /Fresh workflow objective/));
	assert.doesNotMatch(f.selector.render(160).join("\n"), /shipping · Workflow objective/);

	resolveSlowPoll([
		{
			path: "workflow-durable:99999999-9999-4999-8999-999999999999",
			id: "99999999-9999-4999-8999-999999999999",
			cwd: "Durable",
			createdAt: Date.now() - 20_000,
			modifiedAt: Date.now(),
			messageCount: 1,
			firstMessage: "Stale out-of-order workflow",
			allMessagesText: "Stale out-of-order workflow",
			title: "stale · Out-of-order workflow",
			detail: "paused · stage 1/1",
		},
	]);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.match(f.selector.render(160).join("\n"), /Fresh workflow objective/);
	assert.doesNotMatch(f.selector.render(160).join("\n"), /Out-of-order workflow/);
	f.provider.listResumeEntries.mockRejectedValueOnce(new Error("Later workflow refresh failed"));
	pollCallback();
	await vi.waitFor(() => assert.match(f.selector.render(160).join("\n"), /Later workflow refresh failed/));
	assert.match(f.selector.render(160).join("\n"), /Fresh workflow objective/);
	assert.doesNotMatch(f.selector.render(160).join("\n"), /Out-of-order workflow/);

	f.setRows([]);
	pollCallback();
	await vi.waitFor(() => assert.doesNotMatch(f.selector.render(160).join("\n"), /Workflow runs/));
	assert.match(f.selector.render(160).join("\n"), /Chat objective/);
});

test("mixed picker refresh progress retains the selected session when partial session pages omit it until the final list settles (#5256)", async () => {
	const f = await fixture();
	const sessionId = f.manager.getSessionId();
	let pollCallback: (() => void) | undefined;
	const realSetInterval = globalThis.setInterval;
	vi.spyOn(globalThis, "setInterval").mockImplementation(((handler: TimerHandler, timeout?: number) => {
		if (timeout === 5_000 && typeof handler === "function") {
			pollCallback = handler as () => void;
		}
		return realSetInterval(handler, timeout);
	}) as typeof setInterval);

	InteractiveModeBase.prototype.showSessionSelector.call(f.mode);
	await vi.waitFor(() => assert.match(f.selector.render(160).join("\n"), /Workflow objective/));
	assert.ok(pollCallback);
	assert.equal(f.selector.getSessionList().getSelectedSessionId(), sessionId);

	let resolveSessions!: (rows: Awaited<ReturnType<typeof SessionManager.list>>) => void;
	vi.spyOn(SessionManager, "list").mockImplementationOnce((_cwd, _store, onProgress) => {
		onProgress?.(0, 1, []);
		return new Promise((resolve) => {
			resolveSessions = resolve;
		});
	});
	void f.selector.refreshSessions();
	await vi.waitFor(() => assert.ok(resolveSessions));
	const duringPartial = f.selector.render(160).join("\n");
	assert.match(duringPartial, /Chat objective/);
	assert.match(duringPartial, /Workflow objective/);
	assert.equal(f.selector.getSessionList().getSelectedSessionId(), sessionId);

	resolveSessions([]);
	await vi.waitFor(() => assert.doesNotMatch(f.selector.render(160).join("\n"), /Chat objective/));
	assert.equal(f.selector.getSessionList().getSelectedSessionId(), "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
});

test("workflow polling keeps saved session catalogs cached in both scopes (#5256)", async () => {
	const f = await fixture();
	let pollCallback: (() => void) | undefined;
	const realSetInterval = globalThis.setInterval;
	vi.spyOn(globalThis, "setInterval").mockImplementation(((handler: TimerHandler, timeout?: number) => {
		if (timeout === 5_000 && typeof handler === "function") pollCallback = handler as () => void;
		return realSetInterval(handler, timeout);
	}) as typeof setInterval);
	const local = vi.spyOn(SessionManager, "list");
	const all = vi.spyOn(SessionManager, "listAll");
	InteractiveModeBase.prototype.showSessionSelector.call(f.mode);
	await vi.waitFor(() => assert.match(f.selector.render(160).join("\n"), /Workflow objective/));
	assert.ok(pollCallback);
	const localScans = local.mock.calls.length;
	const allScans = all.mock.calls.length;
	const workflowScans = f.provider.listResumeEntries.mock.calls.length;
	f.setRows([]);
	pollCallback();
	await vi.waitFor(() => assert.equal(f.provider.listResumeEntries.mock.calls.length, workflowScans + 1));
	await vi.waitFor(() => assert.doesNotMatch(f.selector.render(160).join("\n"), /Workflow runs/));
	assert.match(f.selector.render(160).join("\n"), /Chat objective/);
	assert.equal(local.mock.calls.length, localScans);
	assert.equal(all.mock.calls.length, allScans);
});

test("a slow session scan cannot overwrite newer workflow poll results (#5256)", async () => {
	const f = await fixture();
	let pollCallback: (() => void) | undefined;
	const realSetInterval = globalThis.setInterval;
	vi.spyOn(globalThis, "setInterval").mockImplementation(((handler: TimerHandler, timeout?: number) => {
		if (timeout === 5_000 && typeof handler === "function") pollCallback = handler as () => void;
		return realSetInterval(handler, timeout);
	}) as typeof setInterval);
	InteractiveModeBase.prototype.showSessionSelector.call(f.mode);
	await vi.waitFor(() => assert.match(f.selector.render(160).join("\n"), /Workflow objective/));
	const saved = await SessionManager.list(f.manager.getCwd(), f.manager.getSessionStore());
	let resolveSessions!: (rows: typeof saved) => void;
	let reportProgress: Parameters<typeof SessionManager.list>[2];
	vi.spyOn(SessionManager, "list").mockImplementationOnce((_cwd, _store, progress) => {
		reportProgress = progress;
		return new Promise((resolve) => {
			resolveSessions = resolve;
		});
	});
	const refresh = f.selector.refreshSessions();
	await vi.waitFor(() => assert.ok(resolveSessions));
	f.setRows([
		{
			path: "workflow-durable:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
			id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
			cwd: "Durable",
			createdAt: Date.now() - 10_000,
			modifiedAt: Date.now(),
			messageCount: 2,
			firstMessage: "Latest workflow progress",
			title: "shipping · Latest workflow progress",
			detail: "paused · stage 3/3 verify",
		},
	]);
	assert.ok(pollCallback);
	pollCallback();
	await vi.waitFor(() => assert.match(f.selector.render(160).join("\n"), /Latest workflow progress/));
	reportProgress?.(0, saved.length, []);
	assert.match(f.selector.render(160).join("\n"), /Latest workflow progress/);
	resolveSessions(saved);
	await refresh;
	assert.match(f.selector.render(160).join("\n"), /Latest workflow progress/);
	assert.doesNotMatch(f.selector.render(160).join("\n"), /Workflow objective/);
});

test("an unknown short resume id reports the missing id rather than flags (#5256)", async () => {
	const f = await fixture();
	await InteractiveModeBase.prototype.handleResumeTarget.call(f.mode, "missing");
	assert.equal(f.errors.length, 1);
	assert.match(f.errors[0]!, /No session or resumable workflow matches "missing"/);
	assert.doesNotMatch(f.errors[0]!, /flags/);
});

test("direct resume does not clear a draft restored by the selected session (#5256)", async () => {
	let draft = "/resume aaaaaaaa";
	const editor = {
		getText: () => draft,
		setText: (text: string) => {
			draft = text;
		},
	};
	const defaultEditor: { onSubmit?: (text: string) => Promise<void> } = {};
	const mode = {
		firstSubmitRecorded: true,
		defaultEditor,
		editor,
		handleResumeTarget: async () => {
			draft = "Restored pending message";
		},
	} as unknown as InteractiveModeBase;
	InteractiveModeBase.prototype.setupEditorSubmitHandler.call(mode);
	await defaultEditor.onSubmit?.("/resume aaaaaaaa");
	assert.equal(draft, "Restored pending message");
});

test("direct resume points to the picker when a full id cannot be disambiguated (#5256)", async () => {
	const f = await fixture();
	const id = f.manager.getSessionId();
	f.setRows([
		{
			path: `workflow-durable:${id}`,
			id,
			cwd: "Durable",
			createdAt: Date.now(),
			modifiedAt: Date.now(),
			messageCount: 1,
			firstMessage: "Workflow with a colliding imported session id",
		},
	]);
	await InteractiveModeBase.prototype.handleResumeTarget.call(f.mode, id);
	assert.deepEqual(f.resumedSessions, []);
	assert.deepEqual(f.resumedRuns, []);
	assert.match(f.errors[0]!, /ambiguous/);
	assert.match(f.errors[0]!, /Use \/resume to choose an entry/);
});

test("direct resume keeps an exact saved session available when workflow history fails (#5256)", async () => {
	const f = await fixture();
	f.provider.listResumeEntries.mockRejectedValue(new Error("Workflow history is unavailable"));
	const id = f.manager.getSessionId();
	await InteractiveModeBase.prototype.handleResumeTarget.call(f.mode, id);
	assert.deepEqual(f.resumedSessions, [id]);
	assert.deepEqual(f.resumedRuns, []);
	assert.deepEqual(f.errors, []);
});

test("direct resume does not guess a prefix while the other catalog is unavailable (#5256)", async () => {
	const f = await fixture();
	f.provider.listResumeEntries.mockRejectedValue(new Error("Workflow history is unavailable"));
	await InteractiveModeBase.prototype.handleResumeTarget.call(f.mode, f.manager.getSessionId().slice(0, 8));
	assert.deepEqual(f.resumedSessions, []);
	assert.deepEqual(f.resumedRuns, []);
	assert.match(f.errors[0]!, /Workflow history is unavailable/);
});
