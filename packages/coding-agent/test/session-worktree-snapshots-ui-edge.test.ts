import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Container, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, test } from "vitest";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionEntry, SessionTreeNode, WorktreeSnapshotEntry } from "../src/core/session-manager.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import type { SessionStore } from "../src/core/storage/session/types.ts";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";
import type { WorktreeSnapshot } from "../src/index.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { getEntryDisplayText, getSearchableText } from "../src/modes/interactive/components/tree-selector-content.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void>> = [];
beforeAll(() => initTheme("dark"));
beforeEach(() => {
	sandbox = new GitSandbox();
	setKeybindings(new KeybindingsManager());
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	sandbox.dispose();
});

const plain = (container: Container): string[] =>
	container.children.flatMap((child) => child.render(2000)).map((line) => stripVTControlCharacters(line).trimEnd());

async function store(): Promise<SessionStore> {
	const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	const opened = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await opened.close();
		await database.close();
	});
	return opened;
}

async function recorded(files: Record<string, string> = { "a.txt": "one\n" }) {
	const { clone } = await sandbox.remoteWithClone("repo", files);
	writeFileSync(join(clone, "a.txt"), "twelve\n");
	const sessions = await store();
	const manager = await SessionManager.create(sessions, clone);
	const result = await captureWorktreeSnapshot(clone, { blobs: sessions.snapshotBlobs });
	assert.equal(result.status, "captured");
	const snapshot = (result as { snapshot: WorktreeSnapshot }).snapshot;
	await manager.appendWorktreeSnapshot(clone, snapshot.id, snapshot);
	return { clone, manager, snapshot };
}

type SnapshotHost = {
	sessionManager: SessionManager;
	settingsManager: { getWorktreeSnapshotSettings(): typeof DEFAULT_WORKTREE_SNAPSHOT_SETTINGS };
	chatContainer: Container;
	ui: { requestRender(): void };
	showStatus(message: string): void;
};

const snapshotCommand = (
	InteractiveMode.prototype as unknown as { handleSessionSnapshotCommand(this: SnapshotHost): Promise<void> }
).handleSessionSnapshotCommand;

function snapshotHost(manager: SessionManager): SnapshotHost & { renders: number } {
	const host = {
		sessionManager: manager,
		settingsManager: { getWorktreeSnapshotSettings: () => DEFAULT_WORKTREE_SNAPSHOT_SETTINGS },
		chatContainer: new Container(),
		renders: 0,
		ui: {
			requestRender() {
				host.renders++;
			},
		},
		showStatus() {},
	};
	return host;
}

describe("/session snapshot output", () => {
	test("a matching checkout renders the snapshot's facts and says it matches, as one block", async () => {
		const { clone, manager, snapshot } = await recorded();
		const host = snapshotHost(manager);
		await snapshotCommand.call(host);
		assert.equal(host.renders, 1);
		assert.deepEqual(plain(host.chatContainer), [
			" Worktree Snapshots",
			"",
			` ${clone}`,
			`   snapshot ${snapshot.id} captured ${snapshot.capturedAt}`,
			`   main at ${snapshot.head.slice(0, 12)}, tree ${snapshot.tree.slice(0, 12)}`,
			`   delta chain 1 link(s), ${snapshot.chain[0]?.bytes} bytes; no unpushed commits bundled`,
			"   matches the current tree",
		]);
	});

	test("a drifted checkout renders both trees and the diff stat, indented under the snapshot", async () => {
		const { clone, manager, snapshot } = await recorded();
		writeFileSync(join(clone, "a.txt"), "three\n");
		const host = snapshotHost(manager);
		await snapshotCommand.call(host);
		const lines = plain(host.chatContainer);
		const [, , , , , , differs, ...stat] = lines;
		assert.match(
			differs ?? "",
			new RegExp(`^   differs from the current tree [0-9a-f]{12} at ${snapshot.head.slice(0, 12)}$`),
		);
		assert.deepEqual(stat, ["    a.txt | 2 +-", "    1 file changed, 1 insertion(+), 1 deletion(-)"]);
	});

	test("a descended HEAD with the same tree shows a match and the current HEAD", async () => {
		const { clone, manager } = await recorded();
		const moved = await sandbox.commitAll(clone, "commit the edit");
		const host = snapshotHost(manager);
		await snapshotCommand.call(host);
		assert.deepEqual(plain(host.chatContainer).slice(6), [`   matches the current tree at ${moved.slice(0, 12)}`]);
	});

	test("a missing checkout shows why, and several checkouts are separated by a blank line", async () => {
		const { clone, manager, snapshot } = await recorded();
		const gone = sandbox.path("gone");
		await manager.appendWorktreeSnapshot(gone, "other", { ...snapshot, id: "other", root: gone });
		const host = snapshotHost(manager);
		await snapshotCommand.call(host);
		const lines = plain(host.chatContainer);
		assert.ok(
			lines.includes(
				`   Worktree snapshot unavailable: ${gone} is not inside a Git repository (not-a-repository). Work inside a Git checkout to record snapshots.`,
			),
		);
		const rootLines = lines.filter((line) => line === ` ${clone}` || line === ` ${gone}`);
		assert.deepEqual(rootLines, [` ${clone}`, ` ${gone}`]);
		const between = lines.slice(lines.indexOf(` ${clone}`), lines.indexOf(` ${gone}`));
		assert.equal(between.at(-1), "");
		assert.notEqual(lines.at(-1), "");
	});
});

describe("/session routing", () => {
	test("/session shows the stats and /session snapshot the snapshots, each clearing the editor", async () => {
		const calls: string[] = [];
		const host = {
			firstSubmitRecorded: true,
			startupReplayActiveInput: undefined,
			startupReplayInputs: [] as string[],
			runtimeHost: {},
			defaultEditor: {} as { onSubmit?: (text: string) => Promise<void> },
			editor: {
				setText: (text: string) => calls.push(`setText(${JSON.stringify(text)})`),
				addToHistory() {},
			},
			handleSessionCommand: () => calls.push("session"),
			handleSessionSnapshotCommand: async () => {
				calls.push("snapshot");
			},
		};
		(
			InteractiveMode.prototype as unknown as { setupEditorSubmitHandler(this: typeof host): void }
		).setupEditorSubmitHandler.call(host);
		await host.defaultEditor.onSubmit?.("/session snapshot");
		assert.deepEqual(calls, ['setText("")', "snapshot"]);
		calls.length = 0;
		await host.defaultEditor.onSubmit?.("/session");
		assert.deepEqual(calls, ["session", 'setText("")']);
	});
});

describe("/export of a session file", () => {
	type ExportHost = {
		session: {
			exportToJsonl(path: string): Promise<string>;
			exportToHtml(path: string | undefined, options: object): Promise<string>;
		};
		sessionManager: Pick<SessionManager, "getBranch" | "getWorktreeSnapshotRecords">;
		statuses: string[];
		showStatus(message: string): void;
		showError(message: string): void;
		getPathCommandArgument(text: string, command: string): string | undefined;
	};
	const exportCommand = (
		InteractiveMode.prototype as unknown as { handleExportCommand(this: ExportHost, text: string): Promise<void> }
	).handleExportCommand;
	const pathArgument = Reflect.get(
		InteractiveMode.prototype,
		"getPathCommandArgument",
	) as ExportHost["getPathCommandArgument"];

	function exportHost(manager: Pick<SessionManager, "getBranch" | "getWorktreeSnapshotRecords">): ExportHost {
		const host: ExportHost = {
			session: {
				exportToJsonl: async (path) => path,
				exportToHtml: async () => "/tmp/out.html",
			},
			sessionManager: manager,
			statuses: [],
			showStatus: (message) => host.statuses.push(message),
			showError: (message) => host.statuses.push(`error: ${message}`),
			getPathCommandArgument: (text, command) => pathArgument.call(host, text, command),
		};
		return host;
	}

	test("states what a JSONL export carries when the session has snapshots, and nothing more when it has none", async () => {
		const { manager, snapshot, clone } = await recorded();
		const withSnapshots = exportHost(manager);
		await exportCommand.call(withSnapshots, "/export /tmp/session.jsonl");
		assert.deepEqual(withSnapshots.statuses, [
			"Session exported to: /tmp/session.jsonl",
			`Includes 1 worktree snapshot(s) of ${clone}: ${snapshot.chain.reduce((sum, link) => sum + link.bytes, 0)} bytes of patch and bundle content`,
		]);
		const empty = exportHost({ getBranch: () => [], getWorktreeSnapshotRecords: () => new Map() });
		await exportCommand.call(empty, "/export /tmp/session.jsonl");
		assert.deepEqual(empty.statuses, ["Session exported to: /tmp/session.jsonl"]);
		const html = exportHost(manager);
		await exportCommand.call(html, "/export");
		assert.deepEqual(html.statuses, ["Session exported to: /tmp/out.html"]);
	});
});

describe("tree view of snapshot entries", () => {
	const at = (id: string, parentId: string | null) => ({ id, parentId, timestamp: new Date().toISOString() });
	const user = (id: string, parentId: string | null, content: string): SessionEntry => ({
		type: "message",
		...at(id, parentId),
		message: { role: "user", content, timestamp: Date.now() },
	});
	const snapshotEntry: WorktreeSnapshotEntry = {
		type: "worktree_snapshot",
		...at("snap-1", "user-1"),
		root: "/work/repo",
		snapshotId: "0123456789abcdef0123456789abcdef",
	};
	const titled: SessionEntry = { type: "session_info", ...at("info-1", "snap-1"), name: "A title" };
	const tree = (): SessionTreeNode[] => {
		const root: SessionTreeNode = { entry: user("user-1", null, "hello"), children: [] };
		const snap: SessionTreeNode = { entry: snapshotEntry, children: [] };
		const info: SessionTreeNode = { entry: titled, children: [] };
		const next: SessionTreeNode = { entry: user("user-2", "info-1", "more"), children: [] };
		root.children.push(snap);
		snap.children.push(info);
		info.children.push(next);
		return [root];
	};
	const rendered = (filter?: "all" | "no-tools") =>
		new TreeSelectorComponent(
			tree(),
			"user-2",
			24,
			() => {},
			() => {},
			undefined,
			undefined,
			filter,
		)
			.getTreeList()
			.render(200)
			.map(stripVTControlCharacters)
			.join("\n");

	test("snapshot and title entries are bookkeeping: hidden by default and in no-tools, shown in all with their summaries", () => {
		const standard = rendered();
		assert.doesNotMatch(standard, /snapshot:/);
		assert.doesNotMatch(standard, /title:/);
		const noTools = rendered("no-tools");
		assert.doesNotMatch(noTools, /snapshot:/);
		assert.doesNotMatch(noTools, /title:/);
		const everything = rendered("all");
		assert.match(everything, /\[snapshot: \/work\/repo 0123456789ab\]/);
		assert.match(everything, /\[title: A title\]/);
	});

	test("a snapshot entry is searchable by its root and its summary is its short id", () => {
		const node: SessionTreeNode = { entry: snapshotEntry, children: [] };
		assert.equal(getSearchableText(node), "snapshot /work/repo");
		assert.equal(
			stripVTControlCharacters(getEntryDisplayText(node, false, new Map())),
			"[snapshot: /work/repo 0123456789ab]",
		);
	});
});
