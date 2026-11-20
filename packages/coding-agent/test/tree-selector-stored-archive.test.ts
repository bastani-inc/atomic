import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { CURRENT_SESSION_VERSION } from "../src/core/session-manager-types.ts";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { StoredTreeView } from "../src/modes/interactive/components/stored-tree-view.js";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const stamp = new Date(0).toISOString();
const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];

beforeEach(() => {
	initTheme("dark", false);
	setKeybindings(new KeybindingsManager());
});
afterEach(async () => {
	while (closers.length) await closers.pop()!();
	while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A saved session whose lines are written byte for byte, so arguments can be stored the way any writer stored them. */
class Lines {
	readonly lines: string[] = [];
	private last: string | null = null;
	private n = 0;
	add(entry: Record<string, unknown>, raw?: Record<string, string>): string {
		const id = String(entry.id ?? `e${++this.n}`);
		let line = JSON.stringify({ id, parentId: this.last, timestamp: stamp, ...entry });
		for (const [mark, text] of Object.entries(raw ?? {})) line = line.replace(JSON.stringify(mark), () => text);
		this.lines.push(line);
		this.last = id;
		return id;
	}
	user(text: string) {
		return this.add({ type: "message", message: { role: "user", content: text, timestamp: 0 } });
	}
	/** One assistant turn calling a tool with these stored argument bytes, and the tool's result. */
	call(name: string, rawArguments: string) {
		const callId = `call-${this.n + 1}`;
		this.add(
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: `calling ${name}` },
						{ type: "toolCall", id: callId, name, arguments: "@@args@@" },
					],
					api: "faux",
					provider: "faux",
					model: "faux",
					usage,
					stopReason: "toolUse",
					timestamp: 0,
				},
			},
			{ "@@args@@": rawArguments },
		);
		return this.add({
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: callId,
				toolName: name,
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 0,
			},
		});
	}
	compact() {
		return this.add({
			type: "compaction",
			summary: "C",
			firstKeptEntryId: null,
			tokensBefore: 100,
			details: { strategy: "verbatim-lines" },
		});
	}
	async write(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "atomic-stored-tree-"));
		dirs.push(dir);
		const file = join(dir, "session.jsonl");
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "stored-tree",
			createdAt: stamp,
			cwd: dir,
		};
		await writeFile(file, `${[JSON.stringify(header), ...this.lines].join("\n")}\n`);
		return file;
	}
}

async function opened(file: string) {
	const manager = await SessionManager.open(file);
	closers.push(() => manager.getSessionStore().close());
	return manager;
}

const screen = (selector: TreeSelectorComponent, width: number) =>
	selector.render(width).map((line) => stripVTControlCharacters(line));

/** The rows a session with every entry loaded shows: the tree as it was before archived history stayed on disk. */
async function loadedRows(file: string, width: number, rows: number) {
	const manager = await opened(file);
	await manager.loadFullHistory();
	const selector = new TreeSelectorComponent(
		manager.getTree(),
		manager.getLeafId(),
		rows,
		() => {},
		() => {},
		undefined,
		undefined,
		"all",
	);
	return screen(selector, width);
}

/** The rows a windowed session shows once every visible stored row has been read. */
async function storedRows(file: string, width: number, rows: number) {
	const manager = await opened(file);
	assert.equal(manager.hasFullHistory(), false, "the fixture keeps archived history on disk");
	const { view, tree, leaf } = await StoredTreeView.open(manager);
	closers.push(async () => view.dispose());
	const errors: Error[] = [];
	view.onError = (error) => errors.push(error);
	const selector = new TreeSelectorComponent(
		tree,
		leaf,
		rows,
		() => {},
		() => {},
		undefined,
		undefined,
		"all",
		view,
	);
	selector.render(width);
	await vi.waitFor(() => {
		assert.deepEqual(errors, []);
		for (const id of view.rows.keys()) assert.ok(view.peek(id), `row ${id} was read`);
	}, 10_000);
	return screen(selector, width);
}

test("an archived custom tool call shows exactly the argument preview of a loaded session (#5554)", async () => {
	const s = new Lines();
	s.user("first");
	// Stored the way JSON.parse reads it, not the way JSON.stringify writes it.
	s.call("custom_tool", `{"b": 1, "2": "two", "a" : [1.0, 1e2, "x\\u0041"], "1": null, "b": "dup"}`);
	s.call("grep", `{"pattern":"foo","path":"/tmp"}`);
	s.call("proto_tool", `{"__proto__": {"x": 1}, "z": 2}`);
	s.call("shrinks", `{"a":"${"x".repeat(60)}","b":1,"c":2,"a":0}`);
	s.call("late_index", `{"z":"${"y".repeat(30)}","10":1,"9":2,"0":3}`);
	s.call("long_key", `{"${"k".repeat(100)}":1,"a":2}`);
	s.call("emoji", `{"ee":"${"😀".repeat(24)}"}`);
	s.call("nested", `{"a":{"b":{"c":{"d":[[[[1,2,3]]]]}}},"e":"after"}`);
	s.call("text_args", `"raw text arguments"`);
	s.call("escapes", `{"s":"line\\nbreak\\ttab\\"quote\\\\back\\u0001ctl\\ud800lone"}`);
	s.call("forty", `{"k":"${"x".repeat(32)}"}`);
	s.call("forty_one", `{"k":"${"x".repeat(33)}"}`);
	s.call("big", JSON.stringify({ content: "a".repeat(100_000), tail: "x" }));
	s.call("bash", JSON.stringify({ command: `   ${"\n".repeat(3000)}ls -la${" ".repeat(80)}` }));
	s.call("bash", JSON.stringify({ command: `a${" ".repeat(60)}b` }));
	s.call("read", JSON.stringify({ path: `/srv/${"d".repeat(300)}/file.ts`, offset: "10", limit: 5 }));
	s.call("read", `{ "path" : "/a/b.ts" , "offset" : 1.50e1 }`);
	s.call("find", `{"pattern":"*.ts","path":42}`);
	s.call("find", JSON.stringify({ pattern: `${" ".repeat(3000)}*.md`, path: "." }));
	s.call("ls", `{"path":false}`);
	s.compact();
	s.user("current");
	const file = await s.write();

	const loaded = await loadedRows(file, 160, 200);
	const stored = await storedRows(file, 160, 200);
	assert.ok(loaded.some((line) => line.includes("[custom_tool: ")));
	assert.deepEqual(stored, loaded);
});

test("archived row previews trim leading whitespace before clipping text, as the ordinary tree does (#5554)", async () => {
	const s = new Lines(),
		pad = " \t\n".repeat(1600);
	s.add({ type: "custom_message", customType: "extension", display: true, content: pad + "custom preview" });
	s.add({
		type: "custom_message",
		customType: "extension",
		display: true,
		content: [
			{ type: "text", text: pad },
			{ type: "text", text: "joined preview" },
		],
	});
	s.add({ type: "branch_summary", fromId: "old", summary: pad + "branch preview" });
	s.add({ type: "session_summary", summarizedThroughId: "old", summary: pad + "summary preview" });
	s.add({
		type: "message",
		message: {
			role: "bashExecution",
			command: pad + "command preview",
			output: "",
			cancelled: false,
			truncated: false,
			timestamp: 0,
		},
	});
	s.add({
		type: "message",
		message: {
			role: "assistant",
			content: [],
			errorMessage: pad + "error preview",
			stopReason: "error",
			provider: "faux",
			model: "faux",
			api: "faux",
			usage,
			timestamp: 0,
		},
	});
	s.compact();
	s.user("current");
	const f = await s.write();
	const loaded = await loadedRows(f, 120, 40),
		stored = await storedRows(f, 120, 40);
	assert.ok(loaded.some((row) => row.includes("command preview")));
	assert.deepEqual(stored, loaded);
});

/** A store whose archived reads can be held or failed, counting each entry read for a preview. */
class ArchiveStore extends MemorySessionStore {
	previewGate?: PromiseWithResolvers<void>;
	searchGate?: PromiseWithResolvers<void>;
	previewFailure?: Error;
	searchFailure?: Error;
	previewReads = 0;
	override async readEntryChunk(...args: Parameters<MemorySessionStore["readEntryChunk"]>) {
		if (args[1] === 0) this.previewReads++;
		await this.previewGate?.promise;
		if (this.previewFailure) throw this.previewFailure;
		return super.readEntryChunk(...args);
	}
	override async readRange(...args: Parameters<MemorySessionStore["readRange"]>) {
		await this.searchGate?.promise;
		if (this.searchFailure) throw this.searchFailure;
		return super.readRange(...args);
	}
}

const longLabel = `${"a long label ".repeat(30)}end`;

/** `count` user messages behind a compaction, a long label on the first, and one message in the current window. */
async function archivedSession(count: number) {
	const store = new ArchiveStore();
	closers.push(() => store.close());
	const manager = await SessionManager.create(store, "/project");
	const ids: string[] = [];
	for (let i = 0; i < count; i++)
		ids.push(await manager.appendMessage({ role: "user", content: `archived ${i}`, timestamp: i }));
	await manager.appendLabelChange(ids[0]!, longLabel);
	await manager.appendCompaction("clear", null, 10, {
		strategy: "verbatim-lines",
		backend: "summary",
	} as unknown as Parameters<SessionManager["appendCompaction"]>[3]);
	await manager.appendMessage({ role: "user", content: "current", timestamp: count });
	assert.equal(manager.getEntry(ids[0]!), undefined, "the archived messages are not held by the session");
	return { store, manager, ids };
}

async function storedSelector(
	manager: SessionManager,
	options: { rows?: number; selected?: string; onLabelChange?: (id: string, label: string | undefined) => void } = {},
) {
	const { view, tree, leaf } = await StoredTreeView.open(manager);
	closers.push(async () => view.dispose());
	const updates = { count: 0, errors: [] as Error[] };
	view.onUpdate = () => updates.count++;
	view.onError = (error) => updates.errors.push(error);
	const selector = new TreeSelectorComponent(
		tree,
		leaf,
		options.rows ?? 40,
		() => {},
		() => {},
		options.onLabelChange,
		options.selected,
		"default",
		view,
	);
	return { view, selector, updates, text: () => screen(selector, 100).join("\n") };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("rows that stay on screen are not read again when the stored tree scrolls (#5554)", async () => {
	const { store, manager } = await archivedSession(20);
	const { selector, text } = await storedSelector(manager, { rows: 10 });
	const opened = store.previewReads;
	selector.render(100);
	await vi.waitFor(() => assert.match(text(), /user: archived 19/));
	await vi.waitFor(() => assert.match(text(), /user: archived 17/));
	const before = store.previewReads;
	assert.equal(before - opened, 3, "the three archived rows on screen were each read once");
	for (let i = 0; i < 3; i++) {
		selector.handleInput("\x1b[A");
		selector.render(100);
	}
	await vi.waitFor(() => assert.match(text(), /user: archived 16/));
	assert.match(text(), /user: archived 17/);
	assert.equal(store.previewReads - before, 1, "only the row that came into view was read");
});

test("editing a long archived label starts from the whole label (#5554)", async () => {
	const { manager, ids } = await archivedSession(3);
	const saved: (string | undefined)[] = [];
	const { selector, text } = await storedSelector(manager, {
		selected: ids[0],
		onLabelChange: (_id, label) => {
			saved.push(label);
		},
	});
	selector.render(100);
	selector.handleInput("L");
	await vi.waitFor(() => assert.match(text(), /Label \(empty to remove\):/));
	selector.handleInput("\r");
	await vi.waitFor(() => assert.equal(saved.length, 1));
	assert.equal(saved[0], longLabel);
	assert.doesNotMatch(text(), /Label \(empty to remove\):/);
});

test("a stored row keeps its leading label while it is read and says when it cannot be read (#5554)", async () => {
	const { store, manager } = await archivedSession(12);
	const cold = await storedSelector(manager);
	store.previewGate = Promise.withResolvers();
	cold.selector.render(100);
	await turn();
	assert.match(cold.text(), /user: …/, "a row being read keeps the start of its text");
	assert.doesNotMatch(cold.text(), /\[user\]/);
	store.previewGate.resolve();
	store.previewGate = undefined;
	await vi.waitFor(() => assert.match(cold.text(), /user: archived 3/));
	assert.doesNotMatch(cold.text(), /user: …/);
	cold.view.dispose();

	const failed = await storedSelector(manager, { rows: 10 });
	store.previewFailure = new Error("archive unavailable");
	failed.selector.render(100);
	await vi.waitFor(() => assert.match(failed.text(), /user: unavailable/));
	assert.deepEqual(
		failed.updates.errors.map((error) => error.message),
		["archive unavailable"],
		"one failure is reported once, not once per row",
	);
	for (let i = 0; i < 4; i++) {
		failed.selector.handleInput("\x1b[A");
		failed.selector.render(100);
	}
	await vi.waitFor(() => assert.equal(failed.text().match(/user: unavailable/g)?.length, 5));
	assert.equal(failed.updates.errors.length, 1, "scrolling does not report the same failure again");
});

test("a stored search shows that it is still reading, then its matches or its failure (#5554)", async () => {
	const { store, manager, ids } = await archivedSession(5);
	const { selector, text } = await storedSelector(manager);
	store.searchGate = Promise.withResolvers();
	selector.render(100);
	selector.handleInput("archived 3");
	await turn();
	assert.match(text(), /Searching…/);
	assert.doesNotMatch(text(), /No entries match/);
	store.searchGate.resolve();
	store.searchGate = undefined;
	await vi.waitFor(() => assert.equal(selector.getTreeList().getSelectedNode()?.entry.id, ids[3]));
	assert.doesNotMatch(text(), /Searching…/);

	store.searchFailure = new Error("archive unavailable");
	selector.handleInput("x");
	await vi.waitFor(() => assert.match(text(), /Search failed: archive unavailable/));
	assert.doesNotMatch(text(), /No entries match/);
});

test("closing a stored tree abandons its reads, search and label load without showing them (#5554)", async () => {
	const { store, manager, ids } = await archivedSession(5);
	const { view, selector, updates, text } = await storedSelector(manager, { selected: ids[0] });
	const labelEvents: string[] = [];
	selector.onLabelUpdate = () => labelEvents.push("update");
	selector.onLabelError = (error) => labelEvents.push(error.message);
	store.previewGate = Promise.withResolvers();
	store.searchGate = Promise.withResolvers();
	selector.render(100);
	selector.handleInput("L");
	assert.doesNotMatch(text(), /Label \(empty to remove\):/, "the input waits for the whole label");
	view.dispose();
	view.dispose();
	const seen = updates.count;
	store.previewGate.resolve();
	store.searchGate.resolve();
	for (let i = 0; i < 10; i++) await turn();
	assert.equal(updates.count, seen);
	assert.deepEqual(updates.errors, []);
	assert.deepEqual(labelEvents, []);
	assert.equal(view.peek(ids[0]!), undefined);
	assert.doesNotMatch(text(), /Label \(empty to remove\):/);
});
