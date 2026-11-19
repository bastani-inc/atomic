/**
 * The renderer inputs pass of an HTML export lets a store skip every entry RENDER_INPUT_SELECTION leaves out (#5571).
 * That is only sound if no entry the pass reads is left out: this stores every kind of entry the pass tells apart and
 * checks, for each kind after every kind of tool call that can precede it, that an entry the pass reads is selected,
 * on a SQLite file and, when their URLs are set, on a libSQL server and Postgres.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { ToolHtmlRenderer } from "../../packages/coding-agent/src/core/export-html/index.js";
import {
	RENDER_INPUT_SELECTION,
	renderHtmlInputs,
} from "../../packages/coding-agent/src/core/export-html/render-inputs.js";
import type { captureHtmlHistory } from "../../packages/coding-agent/src/core/export-html/session-data.js";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager.js";
import { selectedHistoryPages } from "../../packages/coding-agent/src/core/storage/session/history-pages.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { storageBackends } from "../helpers/storage-backends.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

type Source = Awaited<ReturnType<typeof captureHtmlHistory>>;
const at = new Date(0).toISOString();
const TOOLS = ["bash", "read", "write", "edit", "ls", "custom_tool", "subagent", "", 7, null, undefined] as const;

function call(id: string, name: (typeof TOOLS)[number]) {
	return { type: "toolCall", id, ...(name === undefined ? {} : { name }), arguments: { path: "x" } };
}

/** Every content block the pass tells apart, alone and beside a tool call. */
function contents(id: string): unknown[] {
	const blocks = [
		{ type: "text", text: "text \"toolCall\" 'toolResult'" },
		{ type: "thinking", thinking: "thought" },
		{ type: "image", data: "aGk=", mimeType: "image/png" },
		"bare string",
		...TOOLS.map((name) => call(id, name)),
	];
	return [
		"plain",
		[],
		...blocks.map((block) => [block]),
		...TOOLS.map((name) => [{ type: "text", text: "a" }, call(id, name), call(`${id}-2`, "custom_tool")]),
		{ unexpected: call(id, "custom_tool") },
	];
}

/** Every entry kind, with every message role and content the pass looks at. */
function kinds(): SessionEntry[] {
	const entries: unknown[] = [];
	const add = (entry: object) => entries.push({ id: `k${entries.length}`, parentId: null, timestamp: at, ...entry });
	for (const role of ["user", "assistant", "toolResult", "bashExecution", "branchSummary", "custom", "system"])
		for (const [index, content] of contents("call").entries()) {
			// A store summarizes user and assistant messages, whose content is a string or an array of blocks.
			if ((role === "user" || role === "assistant") && typeof content === "object" && !Array.isArray(content))
				continue;
			for (const toolName of TOOLS)
				for (const toolCallId of ["call", "", undefined])
					add({
						type: "message",
						message: {
							role,
							content,
							...(toolName === undefined ? {} : { toolName }),
							...(toolCallId === undefined ? {} : { toolCallId }),
							details: { from: "details" },
							isError: index % 2 === 0,
							timestamp: 1,
						},
					});
		}
	for (const type of [
		"thinking_level_change",
		"model_change",
		"usage",
		"compaction",
		"context_compaction",
		"branch_summary",
		"custom",
		"custom_message",
		"context_edit",
		"label",
		"session_info",
		"session_summary",
		"worktree_snapshot",
	])
		add({
			type,
			customType: "ext",
			data: { message: { role: "assistant", content: [call("call", "custom_tool")] } },
			content: [{ type: "text", text: "custom" }],
			display: true,
			summarizedThroughId: "k0",
		});
	return entries as SessionEntry[];
}

/** Each renderer call, and each row given inputs to restore, of the pass over `entries` with an always-rendering renderer. */
async function rendered(entries: readonly SessionEntry[]): Promise<string[]> {
	const calls: string[] = [];
	const renderer: ToolHtmlRenderer = {
		renderCall: (id, name) => {
			calls.push(`call:${id}:${name}`);
			return `<b>${name}</b>`;
		},
		renderResult: (id, name) => {
			calls.push(`result:${id}:${name}`);
			return { collapsed: "c", expanded: "e" };
		},
	};
	const source = {
		readHistory: async function* () {
			yield { items: entries.map((entry, i) => ({ seq: i + 1, entry })) };
		},
		readHistoryChunks: () => {
			throw new Error("no oversized entry here");
		},
	} as unknown as Source;
	const inputs = await renderHtmlInputs(source, renderer);
	inputs.freezeInputs();
	for (const [i, entry] of entries.entries()) if (inputs.entry(i + 1, entry) !== entry) calls.push(`patch:${i + 1}`);
	return calls;
}

/** The kinds the pass reads, each after every tool call that can precede it. */
async function readKinds(entries: readonly SessionEntry[]): Promise<Set<number>> {
	const before: SessionEntry[][] = [
		[],
		...TOOLS.map(
			(name) =>
				[
					{
						type: "message",
						id: "before",
						parentId: null,
						timestamp: at,
						message: { role: "assistant", content: [call("call", name)], timestamp: 0 },
					},
				] as unknown as SessionEntry[],
		),
	];
	const read = new Set<number>();
	for (const [index, entry] of entries.entries())
		for (const prefix of before) {
			const without = await rendered(prefix);
			const withEntry = await rendered([...prefix, entry]);
			if (withEntry.length !== without.length || withEntry.some((value, i) => value !== without[i])) read.add(index);
		}
	return read;
}

for (const backend of storageBackends) {
	const run = backend.skipReason === undefined ? test : test.skip;
	run(
		`every entry an HTML export's renderer inputs pass reads is one ${backend.name} selects for it (#5571)`,
		async () => {
			const entries = kinds();
			const read = await readKinds(entries);
			// Not vacuous: calls and results of extension tools, and results after a rendered call, are read.
			assert.ok(read.size > 500 && read.size < entries.length, `${read.size} of ${entries.length}`);
			const scope = await backend.openScope();
			try {
				const store = await SqlSessionStore.open(await scope.connect(), { prefix: scope.prefix });
				const created = await store.create({ id: "kinds", version: 4, createdAt: at, cwd: "/project" }, entries);
				const selected = new Set<number>();
				for await (const { items } of selectedHistoryPages(
					store as Required<Pick<SqlSessionStore, "readScanPage">>,
					"kinds",
					created.epoch!,
					entries.length,
					RENDER_INPUT_SELECTION,
				))
					for (const item of items) selected.add(item.seq - 1);
				const missed = [...read].filter((index) => !selected.has(index));
				assert.deepEqual(
					missed.map((index) => entries[index]),
					[],
					"entries the pass reads that the store left out",
				);
				// And the selection is a selection: the store skips entries the pass never reads.
				assert.ok(selected.size < entries.length, `${selected.size} of ${entries.length} selected`);
				await store.close();
			} finally {
				await scope.close();
			}
		},
		300_000,
	);
}
