/**
 * Resuming a long session keeps the interactive host responsive: the fullscreen transcript renders what its viewport
 * shows, and the rest of the transcript is built and rendered in bounded slices across event-loop turns.
 *
 * Work is counted rather than timed: transcript components rendered and components built, in one frame and in each
 * event-loop turn, at two transcript lengths ten times apart. A bound proportional to the viewport that holds at both
 * leaves no room for work that grows with the transcript.
 */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { ScrollView, type TuiAltScreen } from "@bastani/atomic-tui";
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
/** Turns of four session entries (a prompt, a tool call, its result and an answer); the second length is ten times the first. */
const TURNS = [150, 1_500] as const;
/**
 * Transcript components a frame may render per terminal row: those its viewport shows, and a viewport's worth above and
 * below it, which a page up or down shows next. Each component is at least a row tall.
 */
const RENDERS_PER_ROW = 4;
/**
 * String work a frame may do per terminal cell: each screen row is stripped of prompt marks, checked for cursors and
 * images, reset, normalized and written (see FRAME_WORK_PER_CHARACTER in packages/tui/test/linear-work.test.ts).
 */
const STRING_WORK_PER_CELL = 64;
/**
 * Components one event-loop turn may build and render per terminal row while a resumed transcript fills in: the
 * transcript's tail shown first, then a slice of the history before it, a slice of rendering in the background, and a
 * frame.
 */
const RESUME_WORK_PER_ROW = 12;
/** Event-loop turns a resumed transcript may take to fill in completely, per thousand turns of history. */
const FILL_TURNS_PER_THOUSAND_TURNS = 4_000;
/** Turns without work after which the transcript counts as filled in. */
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

/** The interactive host's fullscreen transcript for a session of `turns` turns, before it renders the session. */
function openResumedSession(turns: number): ResumedTranscript {
	const terminal = new RecordingTerminal();
	terminal.columns = COLUMNS;
	terminal.rows = ROWS;
	const sessionManager = SessionManager.inMemory(tmpdir(), undefined, sessionEntries(turns));
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

/** Transcript components rendered and built so far. */
function workDone(mode: InteractiveMode): number {
	return renders + mode.chatContainer.children.length;
}

/**
 * Runs event-loop turns until the transcript holds a component for every turn's prompt and a run of turns passes without
 * work, reporting the work of each turn.
 */
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

/** Asserts the transcript, rendered in full, holds every turn's prompt once and in order. */
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

test("a frame after the first renders what the viewport shows, however long the resumed transcript", async () => {
	for (const turns of TURNS) {
		const { mode, tui, transcript } = openResumedSession(turns);
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
		const { mode, tui } = openResumedSession(turns);
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
