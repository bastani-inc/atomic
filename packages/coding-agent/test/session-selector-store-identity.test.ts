import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { resolveSessionStore } from "../src/core/session-storage.js";
import type { SessionStore } from "../src/core/storage/session/types.js";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

test("the selected-store picker protects its active SQLite session from delete confirmation", async () => {
	const root = mkdtempSync(join(tmpdir(), "selector-active-"));
	const store = await resolveSessionStore(root, {
		sessionStore: { kind: "sqlite", path: join(root, "sessions.sqlite") },
	});
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	const manager = await SessionManager.create(store, root);
	await manager.appendSessionInfo("active");
	const rows = await SessionManager.list(root, store);
	const selector = new SessionSelectorComponent(
		async () => rows,
		async () => rows,
		() => {},
		() => {},
		() => {},
		() => {},
		{ initialSessions: rows, deleteSession: (id) => store.delete(id) },
		{ id: manager.getSessionId(), directory: manager.getSessionDir() },
	);
	try {
		selector.handleInput("\x04");
		assert.match(selector.render(120).join("\n"), /Cannot delete the currently active session/);
		selector.handleInput("\r");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.ok(await store.readHeader(manager.getSessionId()));
		await manager.appendSessionInfo("still writable");
		assert.equal((await store.load(manager.getSessionId())).entries.length, 2);
	} finally {
		selector.dispose();
		await store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("confirmed deletion uses the selected ID rather than its display location across reopen", async () => {
	const root = mkdtempSync(join(tmpdir(), "selector-location-"));
	const selection = { kind: "sqlite", path: join(root, "sessions.sqlite") } as const;
	const store = await resolveSessionStore(root, { sessionStore: selection });
	const selected = await SessionManager.create(store, root, { id: "selected" });
	const other = await SessionManager.create(store, root, { id: "other" });
	await selected.appendSessionInfo("selected");
	await other.appendSessionInfo("other");
	const displayedStore: SessionStore = {
		descriptor: store.descriptor,
		create: store.create.bind(store),
		append: store.append.bind(store),
		replace: store.replace.bind(store),
		load: store.load.bind(store),
		readHeader: store.readHeader.bind(store),
		delete: store.delete.bind(store),
		findMostRecent: store.findMostRecent.bind(store),
		close: store.close.bind(store),
		async *list(query) {
			for await (const row of store.list(query)) {
				yield row.id === "selected" ? { ...row, location: "other" } : row;
			}
		},
	};
	const rows = (await SessionManager.list(root, displayedStore)).filter((row) => row.id === "selected");
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	let deletion: Promise<void> | undefined;
	const selector = new SessionSelectorComponent(
		async () => rows,
		async () => rows,
		() => {},
		() => {},
		() => {},
		() => {},
		{ initialSessions: rows, deleteSession: (id) => (deletion = displayedStore.delete(id)) },
	);
	try {
		assert.equal(rows[0]?.path, "other");
		selector.handleInput("\x04");
		selector.handleInput("\r");
		assert.ok(deletion);
		await deletion;
		assert.equal(await store.readHeader("selected"), undefined);
		assert.equal((await store.readHeader("other"))?.id, "other");
	} finally {
		selector.dispose();
		await store.close();
	}
	const reopened = await resolveSessionStore(root, { sessionStore: selection });
	try {
		assert.equal(await reopened.readHeader("selected"), undefined);
		assert.equal((await reopened.load("other")).header.id, "other");
	} finally {
		await reopened.close();
		rmSync(root, { recursive: true, force: true });
	}
});
