import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { MULTI_CLICK_INTERVAL_MS, ScrollView, type TuiAltScreen } from "@bastani/atomic-tui";
import { afterEach, beforeAll, test } from "vitest";
import type { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { type FileEntry, SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { AssistantMessageComponent } from "../../packages/coding-agent/src/modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent } from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../../packages/coding-agent/src/modes/interactive/components/user-message.ts";
import { InteractiveMode } from "../../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { releaseStartupChatOutput } from "../../packages/coding-agent/src/modes/interactive/interactive-startup-chat-container.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { RecordingTerminal } from "../../packages/coding-agent/test/helpers/interactive-fullscreen-layout.ts";
import { measureStringWork } from "../../packages/tui/test/string-work.ts";

const COLUMNS = 100;
const ROWS = 24;
const TURNS = [150, 1_500] as const;
const RENDERS_PER_ROW = 4;
const STRING_WORK_PER_CELL = 64;
const RESUME_WORK_PER_ROW = 12;
const FILL_TURNS_PER_THOUSAND_TURNS = 4_000;
const QUIET_TURNS = 20;

let renders = 0;
const restoreRenders: Array<() => void> = [];

beforeAll(() => {
	initTheme("dark");
	for (const prototype of [
		AssistantMessageComponent.prototype,
		UserMessageComponent.prototype,
		ToolExecutionComponent.prototype,
	]) {
		const render = prototype.render;
		prototype.render = function (this: typeof prototype, width: number): string[] {
			renders++;
			return render.call(this, width);
		};
		restoreRenders.push(() => {
			prototype.render = render;
		});
	}
	return () => {
		for (const restore of restoreRenders) restore();
	};
});

const stops: Array<() => void> = [];
afterEach(() => {
	for (const stop of stops.splice(0)) stop();
});

function sessionEntries(turns: number): FileEntry[] {
	const entries: FileEntry[] = [
		{ type: "session", version: 4, id: "resumed", createdAt: new Date(0).toISOString(), cwd: tmpdir() } as FileEntry,
	];
	const usage = {
		input: 100,
		output: 100,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 200,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const assistant = { api: "openai-completions", provider: "scripted", model: "scripted", usage };
	let parentId: string | null = null;
	const append = (message: Record<string, unknown>) => {
		const id = entries.length.toString(16).padStart(8, "0");
		const timestamp = 1_700_000_000_000 + entries.length * 1_000;
		entries.push({
			type: "message",
			id,
			parentId,
			timestamp: new Date(timestamp).toISOString(),
			message: { ...message, timestamp },
		} as FileEntry);
		parentId = id;
	};
	for (let turn = 0; turn < turns; turn++) {
		append({
			role: "user",
			content: [{ type: "text", text: `Turn ${turn}: check the loader handles case ${turn}.` }],
		});
		append({
			role: "assistant",
			...assistant,
			stopReason: "toolUse",
			content: [
				{ type: "toolCall", id: `call_${turn}`, name: "bash", arguments: { command: `npm test -- ${turn}` } },
			],
		});
		append({
			role: "toolResult",
			toolCallId: `call_${turn}`,
			toolName: "bash",
			isError: false,
			content: [{ type: "text", text: `PASS case-${turn}\nTests: 148 passed` }],
		});
		append({
			role: "assistant",
			...assistant,
			stopReason: "stop",
			content: [
				{
					type: "text",
					text: `## Answer ${turn}\n\nThe **loader** handles case ${turn}:\n\n- first item with \`code\`\n- second item\n\n\`\`\`ts\nexport const value = ${turn};\n\`\`\`\n`,
				},
			],
		});
	}
	return entries;
}

function runtimeHostFor(sessionManager: SessionManager): AgentSessionRuntime {
	const session = {
		settingsManager: SettingsManager.inMemory({}),
		sessionManager,
		modelRuntime: { findModel: () => undefined, getAllModels: () => [] },
		resourceLoader: { getThemes: () => ({ themes: [], diagnostics: [] }) },
		extensionRunner: {
			getMarkdownTransformers: () => [],
			getEntryRenderer: () => undefined,
			getMessageRenderer: () => undefined,
			resolveToolRenderers: () => undefined,
		},
		getToolDefinition: () => undefined,
		autoCompactionEnabled: false,
		state: { messages: [] },
		isStreaming: false,
		scopedModels: [],
		thinkingLevel: "off",
	};
	return {
		session,
		services: { agentDir: tmpdir() },
		diagnostics: [],
		setBeforeSessionInvalidate: () => {},
		setRebindSession: () => {},
		dispose: async () => {},
	} as unknown as AgentSessionRuntime;
}

interface ResumedTranscript {
	readonly mode: InteractiveMode;
	readonly tui: TuiAltScreen;
	readonly transcript: ScrollView;
	readonly terminal: RecordingTerminal;
}

async function openResumedSession(turns: number): Promise<ResumedTranscript> {
	const terminal = new RecordingTerminal();
	terminal.columns = COLUMNS;
	terminal.rows = ROWS;
	const sessionManager = await SessionManager.inMemory(tmpdir(), undefined, sessionEntries(turns));
	const mode = new InteractiveMode(runtimeHostFor(sessionManager), { terminal });
	const tui = mode.ui as unknown as TuiAltScreen;
	const transcript = new ScrollView(mode.documentContainer, { follow: "end", primary: true });
	mode.transcriptScrollView = transcript;
	tui.setLayoutRoot(transcript);
	releaseStartupChatOutput(mode);
	tui.start();
	stops.push(() => tui.stop());
	return { mode, tui, transcript, terminal };
}

function nextTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function workDone(mode: InteractiveMode): number {
	return renders + mode.chatContainer.children.length;
}

async function fillIn(mode: InteractiveMode, turns: number, onTurn: (work: number) => void = () => {}): Promise<void> {
	let quietTurns = 0;
	for (let turn = 0; quietTurns < QUIET_TURNS; turn++) {
		assert.ok(
			turn < FILL_TURNS_PER_THOUSAND_TURNS * (turns / 1_000),
			`${turns} turns: the transcript never filled in`,
		);
		const before = workDone(mode);
		await nextTurn();
		const work = workDone(mode) - before;
		onTurn(work);
		const prompts = mode.chatContainer.children.filter((child) => child instanceof UserMessageComponent).length;
		quietTurns = prompts === turns && work === 0 ? quietTurns + 1 : 0;
	}
}

function assertHoldsEveryTurn(mode: InteractiveMode, turns: number): void {
	const prompts = mode.documentContainer
		.render(COLUMNS)
		.map((line) => /Turn (\d+): check/.exec(line)?.[1])
		.filter((turn) => turn !== undefined)
		.map(Number);
	assert.deepEqual(
		prompts,
		Array.from({ length: turns }, (_, turn) => turn),
	);
}

test("the main chat can scroll to saved messages before its current context and return to the live tail (#5593)", async () => {
	const { mode, tui, transcript } = await openResumedSession(100);
	const manager = mode.sessionManager;
	await manager.appendCompaction("cleared history", null, 100, {
		strategy: "verbatim-lines",
		promptVersion: 7,
		parameters: { query: "test" },
		stats: {
			linesBefore: 1,
			linesDeleted: 1,
			linesKept: 0,
			rangeCount: 0,
			tokensBefore: 100,
			tokensAfter: 2,
			percentReduction: 98,
		},
		form: "cleared",
	});
	await manager.appendMessage({ role: "user", content: "current input", timestamp: Date.now() });
	mode.renderInitialMessages();
	tui.renderNow();
	assert.match(tui.getScreenLines().join("\n"), /current input/);
	assert.doesNotMatch(mode.documentContainer.render(COLUMNS).join("\n"), /Turn 0:/);
	transcript.scrollToStart();
	for (let i = 0; i < 30; i++) {
		await nextTurn();
		tui.renderNow();
		if (tui.getScreenLines().join("\n").includes("Turn 0:")) break;
	}
	assert.match(tui.getScreenLines().join("\n"), /Turn 0:/);
	transcript.scrollToEnd();
	await nextTurn();
	tui.renderNow();
	assert.match(tui.getScreenLines().join("\n"), /current input/);
	assert.doesNotMatch(mode.documentContainer.render(COLUMNS).join("\n"), /Turn 0:/);
});

test.each([false, true])(
	"returning to an archived extension card preserves its instance unless it opted into replay (%s, #5593)",
	async (replayable) => {
		const { mode, tui, transcript } = await openResumedSession(0);
		const manager = mode.sessionManager;
		let created = 0;
		Object.assign(mode.session.extensionRunner, {
			getMessageRenderer: (kind: string) =>
				kind === "private-card"
					? () => {
							const serial = ++created;
							return {
								historyReplayable: replayable,
								render: () => [`private card ${serial}`],
								invalidate() {},
							};
						}
					: undefined,
		});
		await manager.appendCustomMessageEntry("private-card", "card", true);
		for (let i = 0; i < 100; i++) await manager.appendMessage({ role: "user", content: `saved-${i}`, timestamp: i });
		await manager.appendCompaction("cut", null, 100, {
			strategy: "verbatim-lines",
			promptVersion: 7,
			parameters: { query: "test" },
			stats: {
				linesBefore: 1,
				linesDeleted: 1,
				linesKept: 0,
				rangeCount: 0,
				tokensBefore: 100,
				tokensAfter: 2,
				percentReduction: 98,
			},
			form: "cleared",
		});
		await manager.appendMessage({ role: "user", content: "at the end", timestamp: 200 });
		mode.renderInitialMessages();
		tui.renderNow();
		const visit = async () => {
			transcript.scrollToStart();
			for (let i = 0; i < 35; i++) {
				await nextTurn();
				tui.renderNow();
				const serial = /private card (\d+)/.exec(tui.getScreenLines().join("\n"))?.[1];
				if (serial) return serial;
			}
			throw new Error("saved card was not shown");
		};
		const first = await visit();
		transcript.scrollToEnd();
		await nextTurn();
		tui.renderNow();
		const second = await visit();
		assert.equal(second === first, !replayable);
	},
);

type SavedStep =
	| { readonly call: { readonly id: string; readonly name: string; readonly args: Record<string, string> } }
	| { readonly result: { readonly id: string; readonly name: string; readonly text: string } };

/** Saves `through` entries, prompts `P-<seq>` except `steps`, then, unless `clear` is false, a clear and one prompt. */
async function appendSavedHistory(
	manager: SessionManager,
	through: number,
	steps: Readonly<Record<number, SavedStep>>,
	clear = true,
): Promise<void> {
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (let seq = 1; seq <= through; seq++) {
		const step = steps[seq];
		if (step && "call" in step)
			await manager.appendMessage({
				role: "assistant",
				api: "openai-completions",
				provider: "scripted",
				model: "scripted",
				usage,
				stopReason: "toolUse",
				timestamp: 0,
				content: [{ type: "toolCall", id: step.call.id, name: step.call.name, arguments: step.call.args }],
			});
		else if (step)
			await manager.appendMessage({
				role: "toolResult",
				toolCallId: step.result.id,
				toolName: step.result.name,
				content: [{ type: "text", text: step.result.text }],
				isError: false,
				timestamp: 0,
			});
		else await manager.appendMessage({ role: "user", content: `P-${String(seq).padStart(3, "0")}`, timestamp: seq });
	}
	if (!clear) return;
	await manager.appendCompaction("cut", null, 100, {
		strategy: "verbatim-lines",
		promptVersion: 7,
		parameters: { query: "test" },
		stats: {
			linesBefore: 1,
			linesDeleted: 1,
			linesKept: 0,
			rangeCount: 0,
			tokensBefore: 100,
			tokensAfter: 2,
			percentReduction: 98,
		},
		form: "cleared",
	});
	await manager.appendMessage({ role: "user", content: "at the end", timestamp: 200 });
}

const thirtyLines = (label: string) => Array.from({ length: 30 }, (_, i) => `${label} line ${i + 1}`).join("\n");

test("saved pages of the main chat draw each call once, finished, with its arguments and its click's expansion, read in either direction (#5593)", async () => {
	const { mode, tui, transcript, terminal } = await openResumedSession(0);
	// Pages of 64 entries: read back from entry 140 they cut at 12|13 and 76|77; read on from the start at 64|65 and
	// 128|129. The call of y.txt ends a page read back, that of x.txt one read on; z.txt never got a result.
	await appendSavedHistory(mode.sessionManager, 140, {
		12: { call: { id: "call-y", name: "read", args: { path: "y.txt" } } },
		13: { result: { id: "call-y", name: "read", text: thirtyLines("y") } },
		64: { call: { id: "call-x", name: "write", args: { path: "x.txt", content: "x" } } },
		65: { result: { id: "call-x", name: "write", text: "wrote" } },
		128: { call: { id: "call-z", name: "read", args: { path: "z.txt" } } },
	});
	mode.renderInitialMessages();
	tui.renderNow();
	const held = () => stripVTControlCharacters(mode.chatContainer.render(COLUMNS).join("\n"));
	const scrollUntil = async (lines: number, shown: RegExp) => {
		for (let i = 0; i < 80 && !shown.test(held()); i++) {
			transcript.scrollBy(lines);
			for (let turn = 0; turn < 4; turn++) await nextTurn();
			tui.renderNow();
		}
		assert.match(held(), shown);
	};
	const drawnOnce = (header: RegExp, argless: RegExp) => {
		const rows = held();
		assert.equal(rows.match(new RegExp(header, "g"))?.length, 1, rows);
		assert.doesNotMatch(rows, argless, "a result's card shows its call's arguments");
		assert.doesNotMatch(rows, /∀ (Read|Write)\((y|x)\.txt\)/, "a call whose result is saved is not running");
	};

	await scrollUntil(-20, /P-001/);
	drawnOnce(/Read\(y\.txt\)/, /Read\(\)/);
	drawnOnce(/Write\(x\.txt\)/, /Write\(\)/);

	const document = mode.documentContainer.render(COLUMNS).map((line) => stripVTControlCharacters(line));
	transcript.scrollTo(document.findIndex((line) => /Read\(y\.txt\)/.test(line)) - 2);
	tui.renderNow();
	const row = tui.getScreenLines().findIndex((line) => /Read\(y\.txt\)/.test(stripVTControlCharacters(line)));
	assert.notEqual(row, -1);
	terminal.input(`\x1b[<0;10;${row + 1}M`);
	terminal.input(`\x1b[<0;10;${row + 1}m`);
	await new Promise((resolve) => setTimeout(resolve, MULTI_CLICK_INTERVAL_MS + 50));
	tui.renderNow();
	assert.match(held(), /y line 30/, "the click expands the card");

	// Read on from the start, the call of y.txt and its result share a page; the call of x.txt ends one.
	transcript.scrollToStart();
	for (let i = 0; i < 30 && !/P-001/.test(held()); i++) await nextTurn();
	assert.doesNotMatch(held(), /P-100/, "the pages read back were released");
	assert.match(held(), /y line 30/, "the card read again keeps the click's expansion");
	await scrollUntil(20, /P-140/);
	drawnOnce(/Write\(x\.txt\)/, /Write\(\)/);
	assert.equal(held().match(/Read\(z\.txt\)/g)?.length, 1, "a call that never got a result still shows");
});

/** The rows of the card whose header matches `header`, up to the next prompt or clear, without blank rows. */
function cardRows(text: string, header: RegExp): string[] {
	const lines = text.split("\n").map((line) => line.trimEnd());
	const at = lines.findIndex((line) => header.test(line));
	assert.notEqual(at, -1, `no card ${header}:\n${text}`);
	const end = lines.findIndex((line, index) => index > at && /P-\d{3}|Context cleared/.test(line));
	return lines.slice(at, end < 0 ? undefined : end).filter((line) => line.trim() !== "");
}

test("a saved page whose neighbour is not read draws its edge cards as the whole transcript does, reading one saved entry per card (#5593)", async () => {
	// Read back from entry 140, pages cut at 76|77; read on from the start, at 64|65 and 128|129.
	const steps: Record<number, SavedStep> = {
		64: { call: { id: "call-x", name: "write", args: { path: "x.txt", content: "x" } } },
		65: { result: { id: "call-x", name: "write", text: "wrote" } },
		76: { call: { id: "call-w", name: "read", args: { path: "w.txt" } } },
		77: { result: { id: "call-w", name: "read", text: thirtyLines("w") } },
		128: { call: { id: "call-z", name: "read", args: { path: "z.txt" } } },
	};
	const whole = await openResumedSession(0);
	await appendSavedHistory(whole.mode.sessionManager, 140, steps, false);
	whole.mode.renderInitialMessages();
	const main = () => stripVTControlCharacters(whole.mode.chatContainer.render(COLUMNS).join("\n"));
	for (let i = 0; i < 60 && !/P-001/.test(main()); i++) await nextTurn();

	const { mode, tui, transcript } = await openResumedSession(0);
	const manager = mode.sessionManager;
	await appendSavedHistory(manager, 140, steps);
	const read = manager.readHistory.bind(manager);
	let entryReads = 0;
	manager.readHistory = (options) => {
		if (options?.limit === 1) entryReads++;
		return read(options);
	};
	mode.renderInitialMessages();
	tui.renderNow();
	const held = () => stripVTControlCharacters(mode.chatContainer.render(COLUMNS).join("\n"));
	const settle = async (shown: RegExp) => {
		for (let i = 0; i < 40 && !shown.test(held()); i++) {
			await nextTurn();
			tui.renderNow();
		}
		assert.match(held(), shown);
	};

	// Read back from the end, the page from entry 77 starts with the result of a call the page before ends with.
	transcript.scrollBy(-1);
	await settle(/Read\(w\.txt\)/);
	assert.doesNotMatch(held(), /P-075/, "the page before is not read");
	assert.deepEqual(cardRows(held(), /Read\(w\.txt\)/), cardRows(main(), /Read\(w\.txt\)/));
	assert.equal(entryReads, 1, "one saved entry is read for the card");

	// Read on from the start, the first page ends with a call whose result starts the next page.
	transcript.scrollToStart();
	await settle(/Write\(x\.txt\)/);
	assert.doesNotMatch(held(), /P-066/, "the page after is not read");
	assert.deepEqual(cardRows(held(), /Write\(x\.txt\)/), cardRows(main(), /Write\(x\.txt\)/));
	assert.equal(entryReads, 2, "one saved entry is read for the card");

	// The next page ends with a call that never got a result: the prompt after it shows that.
	for (let i = 0; i < 80 && !/P-066/.test(held()); i++) {
		transcript.scrollBy(20);
		for (let turn = 0; turn < 4; turn++) await nextTurn();
		tui.renderNow();
	}
	await settle(/Read\(z\.txt\)/);
	assert.doesNotMatch(held(), /P-129/, "the page after is not read");
	const pending = (text: string) => cardRows(text, /Read\(z\.txt\)/).map((row) => row.replace(/^\s*\S+ /, ""));
	assert.deepEqual(pending(held()), pending(main()));
	assert.match(held(), /∀ Read\(z\.txt\)/);
	assert.equal(entryReads, 3, "one saved entry is read for the card");
	assert.equal(held().match(/Write\(x\.txt\)/g)?.length, 1, "the finished card stands in for the result's card");
});

test("a frame after the first renders what the viewport shows, however long the resumed transcript", async () => {
	for (const turns of TURNS) {
		const { mode, tui, transcript } = await openResumedSession(turns);
		mode.renderInitialMessages();
		tui.renderNow();
		await fillIn(mode, turns);
		tui.renderNow();
		transcript.scrollBy(-(ROWS - 4));
		renders = 0;
		const { work } = measureStringWork(() => tui.renderNow());
		const rendered = renders;
		assert.ok(rendered <= RENDERS_PER_ROW * ROWS, `${turns} turns: a frame rendered ${rendered} components`);
		const bound = STRING_WORK_PER_CELL * ROWS * COLUMNS;
		assert.ok(work <= bound, `${turns} turns: a frame did ${work} string work, bound ${bound}`);
		assert.match(tui.getScreenLines().join("\n"), new RegExp(`Answer ${turns - 2}`));
		assertHoldsEveryTurn(mode, turns);
	}
});

test("resuming a long transcript builds and renders it in bounded slices across event-loop turns", async () => {
	for (const turns of TURNS) {
		const { mode, tui } = await openResumedSession(turns);
		const before = workDone(mode);
		mode.renderInitialMessages();
		tui.renderNow();
		const slices = [workDone(mode) - before];
		assert.match(tui.getScreenLines().join("\n"), new RegExp(`Answer ${turns - 1}`));
		await fillIn(mode, turns, (work) => slices.push(work));
		const longest = Math.max(...slices);
		assert.ok(
			longest <= RESUME_WORK_PER_ROW * ROWS,
			`${turns} turns: one event-loop turn built and rendered ${longest} components`,
		);
		assertHoldsEveryTurn(mode, turns);
	}
});
