import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
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
	const errors: string[] = [];
	let selector: SessionSelectorComponent | undefined;
	const mode = {
		runtimeHost: {},
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
		resumedSessions,
		errors,
		get selector() {
			assert.ok(selector);
			return selector;
		},
	};
}

test("mixed picker refresh progress retains the selected session when partial session pages omit it until the final list settles (#5256)", async () => {
	const f = await fixture();
	const sessionId = f.manager.getSessionId();
	InteractiveModeBase.prototype.showSessionSelector.call(f.mode);
	await vi.waitFor(() => assert.match(f.selector.render(160).join("\n"), /Chat objective/));
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
	assert.equal(f.selector.getSessionList().getSelectedSessionId(), sessionId);

	resolveSessions([]);
	await vi.waitFor(() => assert.doesNotMatch(f.selector.render(160).join("\n"), /Chat objective/));
	assert.equal(f.selector.getSessionList().getSelectedSessionId(), undefined);
});

test("an unknown short resume id reports the missing id rather than flags (#5256)", async () => {
	const f = await fixture();
	await InteractiveModeBase.prototype.handleResumeTarget.call(f.mode, "missing");
	assert.equal(f.errors.length, 1);
	assert.match(f.errors[0]!, /No session matches "missing"/);
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

test("direct resume opens an exact saved session (#5256)", async () => {
	const f = await fixture();
	const id = f.manager.getSessionId();
	await InteractiveModeBase.prototype.handleResumeTarget.call(f.mode, id);
	assert.deepEqual(f.resumedSessions, [id]);
	assert.deepEqual(f.errors, []);
});
