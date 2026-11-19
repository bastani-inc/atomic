import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeAll, beforeEach, describe, it, vi } from "vitest";
import { _extractUserMessageText, getUserMessagesForForking } from "../src/core/agent-session-tree.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { SessionEntry } from "../src/core/session-manager-types.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import type { SessionStore } from "../src/core/storage/session/types.js";
import { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.ts";
import { FORK_LABEL_CHARS } from "../src/modes/interactive/components/user-message-selector-archive.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const stamp = "2026-11-19T00:00:00.000Z";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const LONG = `${"lorem ipsum ".repeat(300)}\n\n  needle   beyond\tthe preview`;
type Content = Extract<SessionEntry, { type: "message" }>["message"];

function message(id: string, parentId: string | null, message: Content): SessionEntry {
	return { type: "message", id, parentId, timestamp: stamp, message } as SessionEntry;
}
function user(id: string, parentId: string | null, content: unknown): SessionEntry {
	return message(id, parentId, { role: "user", content, timestamp: 1 } as Content);
}

/** Older prompts on two branches, a cleared window, and the prompts main's /fork picker lists for them. */
function transcript(): { entries: SessionEntry[]; listed: { id: string; text: string }[] } {
	const entries: SessionEntry[] = [
		user("p1", null, "fix the login bug"),
		message("a1", "p1", {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "openai-responses",
			provider: "openai",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		} as Content),
		// Key order varies by store; a block's text counts only when its type is text.
		user("p2", "a1", [
			{ text: "second ", type: "text" },
			{ type: "image", data: "aGk=", mimeType: "image/png" },
			{ text: "image caption", type: "image", data: "aGk=", mimeType: "image/png" },
			{ type: "text", text: "part" },
		]),
		user("p3", "p1", "an abandoned branch prompt"),
		user("p4", "p2", LONG),
		// A long block whose type is read after its text: counted when it is text, taken back when it is not.
		user("p8", "p4", [{ text: LONG, type: "text" }]),
		user("p9", "p8", [
			{ text: LONG, type: "image", data: "aGk=", mimeType: "image/png" },
			{ text: "after the image", type: "text" },
		]),
		user("p5", "p9", [{ type: "image", data: "aGk=", mimeType: "image/png" }]),
		user("p6", "p5", " \n "),
		{
			type: "compaction",
			id: "boundary",
			parentId: "p6",
			timestamp: stamp,
			summary: "cleared",
			tokensBefore: 100,
			firstKeptEntryId: "p6",
			details: { strategy: "verbatim-lines", backend: "summary" },
		} as SessionEntry,
		user("p7", "boundary", "the current prompt"),
	];
	return {
		entries,
		listed: [
			{ id: "p1", text: "fix the login bug" },
			{ id: "p2", text: "second part" },
			{ id: "p3", text: "an abandoned branch prompt" },
			{ id: "p4", text: LONG },
			{ id: "p8", text: LONG },
			{ id: "p9", text: "after the image" },
			{ id: "p6", text: " \n " },
			{ id: "p7", text: "the current prompt" },
		],
	};
}

const stores: [string, () => Promise<SessionStore>][] = [
	["memory", async () => new MemorySessionStore()],
	[
		"jsonl",
		async () => {
			const dir = await mkdtemp(join(tmpdir(), "fork-picker-jsonl-"));
			cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10 }));
			return JsonlSessionStore.open(dir, { exactDirectory: true });
		},
	],
	[
		"sqlite",
		async () => {
			const dir = await mkdtemp(join(tmpdir(), "fork-picker-sql-"));
			cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10 }));
			const db = await openNodeSqliteDatabase(join(dir, "s.sqlite"));
			cleanups.push(() => db.close());
			return SqlSessionStore.open(db);
		},
	],
];

async function openWindowed(open: () => Promise<SessionStore>) {
	const store = await open();
	cleanups.push(() => store.close());
	const { entries, listed } = transcript();
	await store.create({ id: "session", version: 4, createdAt: stamp, cwd: "/project" }, entries);
	const manager = await SessionManager.open(store, "session", "/project");
	assert.equal(manager.hasFullHistory(), false, "the session must open at its context window");
	return { manager, listed };
}

async function openForkPicker(manager: SessionManager) {
	let selector: UserMessageSelectorComponent | undefined;
	let dispose: (() => void) | undefined;
	const fork = vi.fn(async (_entryId: string) => ({ cancelled: true }));
	const loadFullHistory = vi.spyOn(manager, "loadFullHistory");
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: {
			fork,
			// The session's own listing, which needs every entry held.
			session: { sessionManager: manager, _extractUserMessageText, getUserMessagesForForking },
		},
		ensureDeferredStartupComplete: async () => {},
		showSelector: (
			create: (done: () => void) => { component: UserMessageSelectorComponent; dispose?: () => void },
		) => {
			const created = create(() => {});
			selector = created.component;
			dispose = created.dispose;
		},
		showStatus: vi.fn(),
		showError: (message: string) => assert.fail(message),
		ui: { requestRender: vi.fn() },
	}) as { showUserMessageSelector(): Promise<void> };
	await mode.showUserMessageSelector();
	assert.ok(selector);
	assert.equal(loadFullHistory.mock.calls.length, 0, "the picker must not load the whole history");
	cleanups.push(async () => dispose?.());
	return { selector, fork };
}

const ids = (selector: UserMessageSelectorComponent) => selector.selector.state.getVisible().map((item) => item.id);

function type(selector: UserMessageSelectorComponent, text: string) {
	for (const ch of text) selector.handleInput(ch);
}

describe("/fork picker on a session opened at its context window (#5554)", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	for (const [name, open] of stores) {
		it(`${name}: lists every older prompt with a bounded label and leaves the history in the store`, async () => {
			const { manager, listed } = await openWindowed(open);
			const { selector } = await openForkPicker(manager);

			assert.deepEqual(ids(selector), ["p1", "p2", "p3", "p4", "p8", "p9", "p6", "p7"]);
			assert.equal(selector.selector.getSelected()?.id, "p7");
			const labels = new Map(selector.selector.state.getVisible().map((item) => [item.id, item.label]));
			assert.equal(labels.get("p2"), "second part");
			assert.equal(labels.get("p6"), "");
			assert.equal(labels.get("p9"), "after the image");
			for (const id of ["p4", "p8"]) {
				const long = labels.get(id) ?? "";
				assert.ok(long.length <= FORK_LABEL_CHARS, `label of ${long.length} code units`);
				assert.ok(long.length > FORK_LABEL_CHARS - 16 && LONG.replace(/\s+/g, " ").trim().startsWith(long), long);
			}
			assert.equal(manager.hasFullHistory(), false);
			assert.equal(manager.getEntry("p1"), undefined);
			assert.equal(manager.getEntry("p4"), undefined);
			assert.equal(listed.length, 8);
		});
	}

	it("finds and forks from an older prompt by text beyond its held label", async () => {
		const { manager } = await openWindowed(stores[2]![1]);
		const { selector, fork } = await openForkPicker(manager);
		type(selector, "needle beyond");
		await vi.waitFor(() => assert.deepEqual(ids(selector), ["p4", "p8"]));
		selector.handleInput("\r");
		await vi.waitFor(() => assert.deepEqual(fork.mock.calls, [["p4"]]));
		assert.equal(manager.hasFullHistory(), false);
	});

	it("matches and orders every search as the picker holding every whole prompt does", async () => {
		const { manager, listed } = await openWindowed(stores[2]![1]);
		const { selector } = await openForkPicker(manager);
		const whole = new UserMessageSelectorComponent(
			listed,
			() => {},
			() => {},
		);
		for (const query of ["p", "lorem", "ipsum part", "needle", "e/r", "the", "sec pr", "zzz", "  "]) {
			type(selector, query);
			type(whole, query);
			await vi.waitFor(() => assert.deepEqual(ids(selector), ids(whole), `query ${JSON.stringify(query)}`));
			assert.equal(
				selector.selector.getSelected()?.id,
				whole.selector.getSelected()?.id,
				`selection for ${JSON.stringify(query)}`,
			);
			selector.handleInput("\x1b");
			whole.handleInput("\x1b");
			assert.deepEqual(ids(selector), ids(whole));
			assert.equal(selector.selector.getSelected()?.id, whole.selector.getSelected()?.id);
		}
		type(selector, "lorem");
		type(whole, "lorem");
		await vi.waitFor(() => assert.deepEqual(ids(selector), ids(whole)));
		for (const key of ["\x7f", "\x7f", "\x7f", "\x7f", "\x7f"]) {
			selector.handleInput(key);
			whole.handleInput(key);
			await vi.waitFor(() => assert.deepEqual(ids(selector), ids(whole)));
			assert.equal(selector.selector.getSelected()?.id, whole.selector.getSelected()?.id);
			assert.equal(selector.selector.state.getTop(), whole.selector.state.getTop());
		}
	});
});
