import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { Text } from "@bastani/atomic-tui";
import { test, vi } from "vitest";
import { exportFromFile, exportSessionToHtml } from "../src/core/export-html/index.js";
import { createToolHtmlRenderer } from "../src/core/export-html/tool-renderer.js";
import { CURRENT_SESSION_VERSION, type SessionEntry, SessionManager } from "../src/core/session-manager.js";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SESSION_HISTORY_PAGE_BYTES, type SessionStore } from "../src/core/storage/session/types.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

async function exportedData(path: string): Promise<{
	header: { id: string };
	entries: SessionEntry[];
	leafId: string | null;
	renderedTools?: Record<string, { callHtml?: string; resultHtmlExpanded?: string }>;
}> {
	const html = await readFile(path, "utf8");
	const encoded = /<script id="session-data" type="application\/json">([^<]*)<\/script>/.exec(html)?.[1];
	assert.ok(encoded);
	return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

test("an HTML export reads a long saved session in a few large pages a pass, from the live session and from a file (#5571)", async () => {
	initTheme("dark");
	const dir = await mkdtemp(join(tmpdir(), "export-html-scan-pages-"));
	const store = new MemorySessionStore();
	// 3000 short turns: fewer entries and bytes than one scan page holds, 47 pages of the default 64 entries.
	const entries = Array.from(
		{ length: 3000 },
		(_, i): SessionEntry => ({
			type: "message",
			id: `turn-${i}`,
			parentId: i === 0 ? null : `turn-${i - 1}`,
			timestamp: new Date(i * 1000).toISOString(),
			message: { role: "user", content: `turn ${i}`, timestamp: i },
		}),
	);
	const ranges = [
		vi.spyOn(MemorySessionStore.prototype, "readRange"),
		vi.spyOn(JsonlSessionStore.prototype, "readRange"),
	];
	try {
		await store.create({ id: "live", cwd: dir, version: 4, createdAt: new Date(0).toISOString() }, entries);
		const manager = await SessionManager.open(store, "live");
		const file = join(dir, "saved.jsonl");
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "saved",
			timestamp: new Date(0).toISOString(),
			cwd: dir,
		};
		await writeFile(file, `${[header, ...entries].map((line) => JSON.stringify(line)).join("\n")}\n`);
		for (const range of ranges) range.mockClear();

		// The live session's export (/export, RPC export_html) reads the renderer inputs, then the data.
		const live = await exportSessionToHtml(manager, undefined, {
			outputPath: join(dir, "live.html"),
			toolRenderer: { renderCall: () => undefined, renderResult: () => undefined },
		});
		// The file's export (--export) reads the saved-agent cards, then the data.
		const saved = await exportFromFile(file, join(dir, "saved.html"));

		assert.deepEqual(
			ranges.map((range) => range.mock.calls.length),
			[2, 2],
			"one range read a pass, not one every 64 entries",
		);
		for (const path of [live, saved])
			assert.deepEqual(
				(await exportedData(path)).entries.map((row) => row.id),
				entries.map((row) => row.id),
			);
	} finally {
		for (const range of ranges) range.mockRestore();
		await store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("HTML exports the durable session through the start of the export, while retaining the caller's selected leaf (#5554)", async () => {
	initTheme("dark");
	const dir = await mkdtemp(join(tmpdir(), "export-durable-cut-"));
	const store = new MemorySessionStore();
	try {
		const manager = await SessionManager.create(store, dir);
		const first = await manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const peer = await SessionManager.open(store, manager.getSessionId());
		const second = await peer.appendMessage({ role: "user", content: "second writer", timestamp: 2 });
		assert.equal(manager.getLastSeq(), 1);
		const data = await exportedData(await exportSessionToHtml(manager, undefined, join(dir, "cut.html")));
		assert.deepEqual(
			data.entries.map((row) => row.id),
			[first, second],
		);
		assert.equal(data.leafId, first);
		assert.equal(manager.getLastSeq(), 1);
	} finally {
		await store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("an HTML export in flight keeps reading oversized entries from the session it started on (#5554)", async () => {
	initTheme("dark");
	const dir = await mkdtemp(join(tmpdir(), "export-original-session-"));
	const store = new MemorySessionStore();
	const started = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	try {
		const manager = await SessionManager.create(store, dir);
		const original = manager.getSessionId();
		const text = "x".repeat(SESSION_HISTORY_PAGE_BYTES + 23);
		const old = await manager.appendMessage({ role: "user", content: text, timestamp: 1 });
		const size = store.readEntrySizes.bind(store);
		store.readEntrySizes = async (id, lo, hi) => {
			const page = await size(id, lo, hi);
			if (id === original) {
				started.resolve();
				await gate.promise;
			}
			return page;
		};
		const exporting = exportSessionToHtml(manager, undefined, join(dir, "original.html"));
		await started.promise;
		await manager.newSession();
		await manager.appendMessage({ role: "user", content: "replacement", timestamp: 2 });
		gate.resolve();
		const data = await exportedData(await exporting);
		assert.equal(data.header.id, original);
		assert.equal(data.leafId, old);
		assert.deepEqual(
			data.entries.map((row) => (row.type === "message" ? row.message.content : null)),
			[text],
		);
	} finally {
		gate.resolve();
		await store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("HTML custom renderers keep their exact call arguments and state through the last repeated result, across pages (#5554)", async () => {
	initTheme("dark");
	const dir = await mkdtemp(join(tmpdir(), "export-renderer-state-"));
	const store = new MemorySessionStore();
	try {
		const manager = await SessionManager.create(store, dir);
		for (const id of ["A", "B"])
			await manager.appendMessage(
				fauxAssistantMessage([fauxToolCall("extension", { value: "recorded" }, { id })], { stopReason: "toolUse" }),
			);
		for (let i = 0; i < 63; i++) await manager.appendCustomEntry("filler");
		for (const id of ["A", "B", "A"])
			await manager.appendMessage({
				role: "toolResult",
				toolCallId: id,
				toolName: "extension",
				content: [{ type: "text", text: id }],
				details: { value: id },
				isError: false,
				timestamp: 3,
			});
		const calls: string[] = [];
		const first = new Map<string, { value: string }>();
		const resultStates: string[] = [];
		const renderer = createToolHtmlRenderer({
			theme,
			cwd: dir,
			getToolRenderers: () => ({
				renderCall(args, _theme, context) {
					const id = context.toolCallId;
					calls.push(`call ${id}`);
					const value = args as { value: string };
					if (!first.has(id)) {
						first.set(id, value);
						value.value = "edited-in-render";
					}
					return new Text(`call ${id}`, 0, 0);
				},
				renderResult(_result, options, _theme, context) {
					const id = context.toolCallId;
					calls.push(`result ${id}`);
					const state = context.state as { results?: number };
					state.results = (state.results ?? 0) + 1;
					if (id === "B" && options.expanded) first.get("A")!.value = "late";
					const value = context.args as { value: string };
					const label = `${id}:${context.args === first.get(id)}:${value.value}:${state.results}:${context.lastComponent ? "seen" : "new"}`;
					resultStates.push(label);
					return new Text(label, 0, 0);
				},
			}),
		});
		const releases: string[] = [];
		const release = renderer.releaseCall!;
		renderer.releaseCall = (id) => {
			releases.push(`${id}:${calls.length}`);
			release(id);
		};
		const data = await exportedData(
			await exportSessionToHtml(manager, undefined, { outputPath: join(dir, "state.html"), toolRenderer: renderer }),
		);
		assert.deepEqual(calls, [
			"call A",
			"call B",
			"result A",
			"result A",
			"call A",
			"result B",
			"result B",
			"call B",
			"result A",
			"result A",
			"call A",
		]);
		assert.deepEqual(releases, ["B:8", "A:11"]);
		assert.equal(resultStates[0], "A:true:edited-in-render:1:new");
		assert.match(data.renderedTools?.A?.resultHtmlExpanded ?? "", /A:true:late:4:seen/);
		const arg = (rows: readonly SessionEntry[]) => {
			const e = rows[0];
			const b = e?.type === "message" && e.message.role === "assistant" ? e.message.content[0] : undefined;
			return b?.type === "toolCall" ? b.arguments.value : undefined;
		};
		assert.equal(arg(data.entries), "late");
		assert.equal(arg((await store.readRange(manager.getSessionId(), 1, 1)).entries), "recorded");
	} finally {
		await store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("HTML serialization freezes exposed renderer inputs together before the first raw page is written (#5554)", async () => {
	initTheme("dark");
	const dir = await mkdtemp(join(tmpdir(), "export-exposed-input-cut-"));
	const store = new MemorySessionStore();
	try {
		const manager = await SessionManager.create(store, dir);
		const call = (id: string) =>
			manager.appendMessage(
				fauxAssistantMessage([fauxToolCall("extension", { value: "old" }, { id })], { stopReason: "toolUse" }),
			);
		await call("A");
		for (let i = 0; i < 63; i++) await manager.appendCustomEntry("filler");
		await call("B");
		const seen: { value: string }[] = [];
		const size = store.readEntrySizes.bind(store);
		let mutated = false;
		store.readEntrySizes = async (id, from, to) => {
			if (!mutated && seen.length === 2 && from === 65) {
				mutated = true;
				for (const value of seen) value.value = "new";
			}
			return size(id, from, to);
		};
		const data = await exportedData(
			await exportSessionToHtml(manager, undefined, {
				outputPath: join(dir, "atomic.html"),
				toolRenderer: {
					renderCall(_id, _name, args) {
						seen.push(args as { value: string });
						return undefined;
					},
					renderResult() {
						return undefined;
					},
				},
			}),
		);
		assert.equal(mutated, true);
		const values = data.entries.flatMap((row) =>
			row.type === "message" && row.message.role === "assistant"
				? row.message.content.flatMap((block) => (block.type === "toolCall" ? [block.arguments.value] : []))
				: [],
		);
		assert.deepEqual(values, ["old", "old"]);
	} finally {
		await store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("HTML renders oversized extension calls and results while streaming unrelated message fields (#5554)", async () => {
	initTheme("dark");
	const dir = await mkdtemp(join(tmpdir(), "export-large-tool-"));
	const store = new MemorySessionStore();
	try {
		const m = await SessionManager.create(store, dir);
		const unrelated = "unrelated-large-text" + "x".repeat(SESSION_HISTORY_PAGE_BYTES);
		const content = "large tool output " + "y".repeat(SESSION_HISTORY_PAGE_BYTES);
		await m.appendMessage(
			fauxAssistantMessage([
				{ type: "text", text: unrelated },
				fauxToolCall("custom_tool", { word: "initial" }, { id: "ext" }),
			]),
		);
		await m.appendMessage({
			role: "toolResult",
			toolCallId: "ext",
			toolName: "custom_tool",
			timestamp: 0,
			isError: false,
			content: [{ type: "text", text: content }],
			details: { phase: "before" },
		});
		const raw = (await store.load(m.getSessionId())).entries;
		const seen: string[] = [];
		let first: unknown;
		const parse = JSON.parse;
		let unrelatedParses = 0;
		const trap = vi.spyOn(JSON, "parse").mockImplementation((s, r) => {
			if (s.length > SESSION_HISTORY_PAGE_BYTES && s.includes("unrelated-large-text")) unrelatedParses++;
			return parse(s, r);
		});
		let output: string;
		try {
			output = await exportSessionToHtml(m, undefined, {
				outputPath: join(dir, "large.html"),
				toolRenderer: {
					renderCall(_id, _name, args) {
						seen.push("call");
						if (!first) first = args;
						else assert.equal(args, first);
						(args as { word: string }).word = "modified";
						return "call-html";
					},
					renderResult(_id, _name, blocks, details) {
						seen.push("result");
						assert.equal(blocks[0]?.text, content);
						blocks[0]!.text = "changed";
						(details as { phase: string }).phase = "after";
						return { expanded: "result-html" };
					},
				},
			});
		} finally {
			trap.mockRestore();
		}
		assert.deepEqual(seen, ["call", "result", "call"]);
		assert.equal(unrelatedParses, 0);
		const decoded = await exportedData(output);
		const a = raw[0]!,
			b = raw[1]!;
		assert.ok(
			a.type === "message" &&
				a.message.role === "assistant" &&
				b.type === "message" &&
				b.message.role === "toolResult",
		);
		const call = a.message.content[1]!;
		assert.ok(call.type === "toolCall");
		call.arguments.word = "modified";
		b.message.content = [{ type: "text", text: "changed" }];
		b.message.details = { phase: "after" };
		const expected = {
			header: m.getHeader(),
			entries: raw,
			leafId: m.getLeafId(),
			renderedTools: { ext: { callHtml: "call-html", resultHtmlExpanded: "result-html" } },
		};
		assert.equal(JSON.stringify(decoded), JSON.stringify(expected));
	} finally {
		await store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("HTML export streams previous windows, including exact oversized Unicode entries, without hydrating them into the manager (#5554)", async () => {
	initTheme("dark");
	const dir = await mkdtemp(join(tmpdir(), "export-html-window-"));
	const store = new MemorySessionStore();
	try {
		const timestamp = new Date(0).toISOString();
		const old: SessionEntry = {
			type: "message",
			id: "large",
			parentId: null,
			timestamp,
			message: { role: "user", content: "é🚀".repeat(SESSION_HISTORY_PAGE_BYTES / 4), timestamp: 0 },
		};
		const boundary: SessionEntry = {
			type: "compaction",
			id: "window",
			parentId: old.id,
			timestamp,
			details: { strategy: "verbatim-lines" },
			summary: "cleared",
			tokensBefore: 1000,
			firstKeptEntryId: null,
		};
		await store.create({ id: "export", cwd: dir, version: 4, createdAt: timestamp }, [old, boundary]);
		const guarded: SessionStore = Object.assign(Object.create(store), {
			load: () => {
				throw new Error("HTML export read the entire store");
			},
		});
		const manager = await SessionManager.open(guarded, "export");
		const file = await exportSessionToHtml(manager, undefined, join(dir, "out.html"));
		assert.equal(manager.getEntryCount(), 1);
		const data = await exportedData(file);
		assert.deepEqual(data.entries, [old, boundary]);
		assert.equal(data.leafId, boundary.id);
	} finally {
		await store.close();
		await rm(dir, { recursive: true, force: true });
	}
});
