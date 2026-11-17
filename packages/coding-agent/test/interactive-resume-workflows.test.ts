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
