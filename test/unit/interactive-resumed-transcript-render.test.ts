import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import type { Message } from "@bastani/atomic-ai/compat";
import { ScrollView, type TuiAltScreen } from "@bastani/atomic-tui";
import { afterEach, beforeAll, test } from "vitest";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.ts";
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
	return { mode, tui, transcript };
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

const CLEARED = {
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
} as const;

/** Compact the session live, as `compaction_end` redraws the chat, keeping entries from `keptId` on. */
async function compactLive(mode: InteractiveMode, keptId: string | null): Promise<void> {
	await mode.sessionManager.appendCompaction("new context", keptId, 100, CLEARED);
	const result = {
		compactedText: "new context",
		firstKeptEntryId: keptId,
		tokensBefore: 100,
		parameters: CLEARED.parameters,
		stats: CLEARED.stats,
		promptVersion: CLEARED.promptVersion,
		form: CLEARED.form,
	};
	mode.rebuildChatFromMessages({ suppressCompactionBoundary: result });
	mode.addCompactionBoundaryToChat(result);
}

const plainScreen = (tui: TuiAltScreen) =>
	tui.getScreenLines().map((line) => stripVTControlCharacters(line).replace(/\]8;;/g, "").trimEnd());
/** The turn numbers the chat holds, in order, as its rows show their prompts. */
const heldTurns = (mode: InteractiveMode) =>
	mode.documentContainer
		.render(COLUMNS)
		.map((line) => /Turn (\d+): check/.exec(line)?.[1])
		.filter((turn) => turn !== undefined)
		.map(Number);

async function parkAboveTheEnd(turns: number): Promise<ResumedTranscript> {
	const opened = await openResumedSession(turns);
	opened.mode.renderInitialMessages();
	opened.tui.renderNow();
	await fillIn(opened.mode, turns);
	opened.tui.renderNow();
	opened.transcript.scrollBy(-(ROWS * 3));
	opened.tui.renderNow();
	return opened;
}

/** The retired window is released: the chat holds only turns the screen shows a row of. */
function assertHoldsOnlyWhatIsShown(mode: InteractiveMode, tui: TuiAltScreen): void {
	const screen = plainScreen(tui).join("\n");
	const held = heldTurns(mode);
	assert.ok(held.length > 0);
	for (const turn of held)
		assert.match(screen, new RegExp(`(Turn|Answer) ${turn}\\b`), `turn ${turn} is held but not shown: ${held}`);
}

function terminalSelect(tui: TuiAltScreen): void {
	const terminal = (tui as unknown as { terminal: RecordingTerminal }).terminal;
	terminal.input("\x1b[<0;3;6M");
	terminal.input("\x1b[<32;20;8M");
	terminal.input("\x1b[<0;20;8m");
	tui.renderNow();
}

test("a compaction while the reader is above the end keeps their rows on screen and releases the rest (#5593)", async () => {
	const { mode, tui, transcript } = await parkAboveTheEnd(100);
	terminalSelect(tui);
	assert.equal(tui.hasActiveSelection(), true);
	const parked = plainScreen(tui).slice(1);
	assert.match(parked.join("\n"), /Turn 95: check/);
	await compactLive(mode, null);
	tui.renderNow();
	assert.deepEqual(plainScreen(tui).slice(1), parked, "the reader keeps the rows they were reading");
	assert.equal(transcript.isFollowingEnd, false);
	assert.equal(tui.hasActiveSelection(), true, "the reader keeps their selection");
	assertHoldsOnlyWhatIsShown(mode, tui);
	// Earlier saved messages continue right above the kept rows, once each.
	for (let i = 0; i < 40 && !heldTurns(mode).includes(80); i++) {
		transcript.scrollBy(-ROWS);
		await nextTurn();
		tui.renderNow();
	}
	const above = heldTurns(mode);
	assert.ok(above.includes(80), `older pages load above the kept rows: ${above}`);
	assert.equal(new Set(above).size, above.length, `no saved row repeats: ${above}`);
	assert.deepEqual(
		above,
		Array.from({ length: above.length }, (_, i) => above[0]! + i),
		`saved rows stay in order, none skipped: ${above}`,
	);
	// Later saved messages continue below them until the new context.
	for (let i = 0; i < 80 && !/Context cleared/.test(plainScreen(tui).join("\n")); i++) {
		transcript.scrollBy(ROWS);
		await nextTurn();
		tui.renderNow();
	}
	const below = heldTurns(mode);
	assert.ok(below.includes(99), `newer pages reach the end of the retired window: ${below}`);
	assert.deepEqual(
		below,
		Array.from({ length: below.length }, (_, i) => below[0]! + i),
		`saved rows stay in order, none repeated or skipped: ${below}`,
	);
});

test("a compaction that keeps the rows the reader sees draws them once, where they were (#5593)", async () => {
	const { mode, tui, transcript } = await parkAboveTheEnd(100);
	const parked = plainScreen(tui).slice(1);
	const kept = mode.sessionManager
		.getEntries()
		.find((entry) => entry.type === "message" && JSON.stringify(entry.message).includes("Turn 93:"));
	assert.ok(kept);
	await compactLive(mode, kept.id);
	tui.renderNow();
	assert.deepEqual(plainScreen(tui).slice(1), parked, "the reader keeps the rows they were reading");
	assert.equal(transcript.isFollowingEnd, false);
	assert.deepEqual(heldTurns(mode), [93, 94, 95, 96, 97, 98, 99], "kept turns are drawn once");
});

test.each(["the session", "the engine's message_end"])(
	"rows drawn as their messages streamed are placed by save receipts from %s across a compaction (#5593)",
	async (from) => {
		const { mode, tui, transcript } = await openResumedSession(0);
		const manager = mode.sessionManager;
		const receipts = new WeakMap<object, { seq: number }>();
		Object.assign(mode.session, {
			...(from === "the session" ? { entryReceipt: (message: object) => receipts.get(message) } : {}),
			getSteeringMessages: () => [],
			getFollowUpMessages: () => [],
		});
		mode.isInitialized = true;
		mode.renderInitialMessages();
		const stream = async (message: AgentMessage) => {
			await mode.handleEvent({ type: "message_start", message } as AgentSessionEvent);
			const entryId = await manager.appendMessage(message as Message);
			const seq = manager.getEntrySeq(entryId)!;
			receipts.set(message, { seq });
			const end = { type: "message_end", message, ...(from === "the session" ? {} : { entryId, seq }) };
			await mode.handleEvent(end as AgentSessionEvent);
		};
		for (let turn = 0; turn < 60; turn++) {
			await stream({ role: "user", content: `Turn ${turn}: check the loader`, timestamp: turn });
			await stream({
				role: "assistant",
				content: [{ type: "text", text: `Answer ${turn}\n\nline one\nline two` }],
				api: "openai-completions",
				provider: "scripted",
				model: "scripted",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: turn,
			} as AgentMessage);
		}
		tui.renderNow();
		transcript.scrollBy(-(ROWS * 3));
		tui.renderNow();
		const parked = plainScreen(tui).slice(1);
		await compactLive(mode, null);
		tui.renderNow();
		assert.deepEqual(plainScreen(tui).slice(1), parked, "the reader keeps the rows they were reading");
		assertHoldsOnlyWhatIsShown(mode, tui);
		for (let i = 0; i < 40 && !heldTurns(mode).includes(40); i++) {
			transcript.scrollBy(-ROWS);
			await nextTurn();
			tui.renderNow();
		}
		for (let i = 0; i < 80 && !/Context cleared/.test(plainScreen(tui).join("\n")); i++) {
			transcript.scrollBy(ROWS);
			await nextTurn();
			tui.renderNow();
		}
		const read = heldTurns(mode);
		assert.ok(read.includes(59), `newer pages reach the end of the retired window: ${read}`);
		assert.deepEqual(
			read,
			Array.from({ length: read.length }, (_, i) => read[0]! + i),
			`saved rows stay in order, none repeated or skipped: ${read}`,
		);
	},
);

test("rows an older engine streamed without save receipts are released by a compaction, as before (#5593)", async () => {
	const { mode, tui, transcript } = await openResumedSession(0);
	const manager = mode.sessionManager;
	Object.assign(mode.session, { getSteeringMessages: () => [], getFollowUpMessages: () => [] });
	mode.isInitialized = true;
	mode.renderInitialMessages();
	for (let turn = 0; turn < 60; turn++) {
		const message = { role: "user", content: `Turn ${turn}: check the loader`, timestamp: turn } as Message;
		await mode.handleEvent({ type: "message_start", message } as AgentSessionEvent);
		await manager.appendMessage(message);
		await mode.handleEvent({ type: "message_end", message } as AgentSessionEvent);
	}
	tui.renderNow();
	transcript.scrollBy(-(ROWS * 3));
	tui.renderNow();
	await compactLive(mode, null);
	tui.renderNow();
	assert.deepEqual(heldTurns(mode), [], "unplaced rows are not kept above saved pages they cannot be ordered with");
	assert.match(plainScreen(tui).join("\n"), /Earlier messages are saved above this point|Context cleared/);
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
