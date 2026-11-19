import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScrollView, type TuiAltScreen, WindowedContainer } from "@bastani/atomic-tui";
import { afterEach, beforeAll, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { SessionHistoryReadOptions } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { InteractiveMode } from "../../packages/coding-agent/src/modes/interactive/interactive-mode.js";
import { releaseStartupChatOutput } from "../../packages/coding-agent/src/modes/interactive/interactive-startup-chat-container.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { createEngineHostPair } from "../../packages/coding-agent/test/helpers/in-process-engine-pair.js";
import { RecordingTerminal } from "../../packages/coding-agent/test/helpers/interactive-fullscreen-layout.js";
import { stripTerminalSequences } from "../../packages/tui/src/utils.js";

const COLUMNS = 100;
const ROWS = 30;
const TURNS = 100;

beforeAll(() => initTheme("dark", false));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

/**
 * Saves `TURNS` turns. Even replies read the whole prompt from cache; odd ones re-bill it, a miss after a reply that
 * reported cache. Each reply reports the provider's cumulative dropped thinking blocks, `floor(turn / 2)`: it grows
 * at even replies, so only they draw a drop, and an odd reply repeats its predecessor's count. An unrendered record
 * every third turn makes pages of 64 entries, read back from the end or on from the start, begin at odd turns too.
 */
async function saveTurns(manager: SessionManager): Promise<void> {
	for (let turn = 0; turn < TURNS; turn++) {
		if (turn % 3 === 1) await manager.appendCustomEntry("unrendered-record", { turn });
		await manager.appendMessage({ role: "user", content: `Q${turn} ask`, timestamp: turn * 2 });
		const missed = turn % 2 === 1;
		const drops = Math.floor(turn / 2);
		await manager.appendMessage({
			role: "assistant",
			api: "openai-completions",
			provider: "scripted",
			model: "scripted",
			stopReason: "stop",
			content: [{ type: "text", text: `A${turn} done` }],
			usage: {
				input: missed ? 25_000 : 0,
				output: 1,
				cacheRead: missed ? 0 : 25_000,
				cacheWrite: 0,
				totalTokens: 25_001,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			...(drops > 0
				? {
						diagnostics: [
							{ type: "anthropic_input_transformations", timestamp: 0, details: { droppedBlockCount: drops } },
						],
					}
				: {}),
			timestamp: turn * 2 + 1,
		});
	}
}

const WARNING = /Prompt cache miss|Anthropic dropped \d+ thinking/;

/** The warnings drawn after each reply `A<turn> done`, before the next prompt, in rendered chat lines. */
function warningsByReply(lines: readonly string[]): Map<number, string[]> {
	const byReply = new Map<number, string[]>();
	let reply: number | undefined;
	for (const raw of lines) {
		const line = stripTerminalSequences(raw).trim();
		const answer = /\bA(\d+) done\b/.exec(line);
		if (answer) {
			reply = Number(answer[1]);
			byReply.set(reply, []);
		} else if (/\bQ\d+ ask\b/.test(line)) reply = undefined;
		else if (reply !== undefined && WARNING.test(line)) byReply.get(reply)!.push(line);
	}
	return byReply;
}

function fullscreenChat(session: AgentSessionRuntime["session"]) {
	const host = {
		session,
		services: { agentDir: tmpdir() },
		diagnostics: [],
		setBeforeSessionInvalidate() {},
		setRebindSession() {},
		async dispose() {},
	} as unknown as AgentSessionRuntime;
	const terminal = new RecordingTerminal();
	terminal.columns = COLUMNS;
	terminal.rows = ROWS;
	const mode = new InteractiveMode(host, { terminal });
	(mode as unknown as { isInitialized: boolean }).isInitialized = true;
	const tui = mode.ui as unknown as TuiAltScreen;
	const transcript = new ScrollView(mode.documentContainer, { follow: "end", primary: true });
	mode.transcriptScrollView = transcript;
	tui.setLayoutRoot(transcript);
	releaseStartupChatOutput(mode);
	tui.start();
	cleanups.push(() => {
		tui.stop();
		mode.stop();
	});
	return { mode, tui, transcript };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Every saved read of `manager` from now on: the turn of each drawn page's first reply, the reads made for those
 * replies, and how many reads are in flight.
 */
function recordReads(manager: SessionManager) {
	const reads = {
		pages: [] as (number | undefined)[],
		bounded: [] as { limit: number; entries: number }[],
		active: 0,
	};
	const read = manager.readHistory.bind(manager);
	manager.readHistory = (options?: SessionHistoryReadOptions) => {
		const pages = read(options);
		reads.active++;
		return (async function* () {
			try {
				for await (const page of pages) {
					if (options?.limit === undefined) {
						const reply = page.items.find(
							(item) =>
								"entry" in item && item.entry.type === "message" && item.entry.message.role === "assistant",
						);
						const turn = reply && /\bA(\d+) done\b/.exec(JSON.stringify("entry" in reply && reply.entry))?.[1];
						reads.pages.push(turn === undefined ? undefined : Number(turn));
					} else reads.bounded.push({ limit: options.limit, entries: page.items.length });
					yield page;
				}
			} finally {
				reads.active--;
			}
		})();
	};
	return reads;
}

/**
 * A chat open on `host` over the saved turns, drawn whole, then compacted live through the engine, as a reader keeps
 * a chat open across a compaction. `shown` holds the warnings of each reply as the chat drew them before it.
 */
async function openThenCompact(host: string, notices: boolean) {
	const root = await mkdtemp(join(tmpdir(), "atomic-saved-warnings-"));
	cleanups.push(() => rm(root, { force: true, recursive: true }));
	const manager = await SessionManager.create(root, join(root, "sessions"));
	await saveTurns(manager);
	const pair = await createEngineHostPair({
		sessionManager: manager,
		hostSessionManager: await SessionManager.open(manager.getSessionFile()!),
		settings: { showCacheMissNotices: notices },
		engineExtensions: [
			(pi) => {
				pi.on("session_before_compact", () => ({ compactedText: "retained" }));
			},
		],
	});
	pair.hostHarness.settingsManager.setShowCacheMissNotices(notices);
	cleanups.push(() => pair.cleanup());
	const session = host === "isolated" ? pair.runtime.session : pair.engine.session;
	const { mode, tui, transcript } = fullscreenChat(session);
	cleanups.push(session.subscribe((event) => void mode.handleEvent(event as never)));
	mode.renderInitialMessages();
	const document = () => mode.documentContainer.render(COLUMNS);
	await vi.waitFor(async () => {
		await nextTurn();
		assert.equal(warningsByReply(document()).size, TURNS);
	});
	const shown = warningsByReply(document());

	await pair.engine.session.compact();
	await pair.drain();
	await vi.waitFor(() => assert.match(document().join("\n"), /Earlier messages are saved above this point/));
	// The isolated host reads saved pages through its own view of the session, not the engine's.
	assert.equal(mode.sessionManager === pair.engine.sessionManager, host === "in-process");
	const reads = recordReads(mode.sessionManager);
	// Scrolling again at the end restarts a page read in flight: let each read finish, as a reader would.
	const settle = async () => {
		await nextTurn();
		await vi.waitFor(() => assert.equal(reads.active, 0), { timeout: 5_000, interval: 2 });
		for (let turn = 0; turn < 2; turn++) await nextTurn();
		tui.renderNow();
	};
	/** Scroll through every saved page by `lines`: each reply shows the warnings the chat drew before the compaction. */
	const scrollThrough = async (lines: number) => {
		const saved = new Map<number, string[]>();
		for (let step = 0; step < 400 && saved.size < TURNS; step++) {
			transcript.scrollBy(lines);
			await settle();
			for (const [reply, warnings] of warningsByReply(document())) {
				const before = saved.get(reply);
				if (before) assert.deepEqual(warnings, before, `reply ${reply} changed its warnings`);
				saved.set(reply, warnings);
			}
		}
		assert.equal(saved.size, TURNS, "every saved reply was shown");
		for (let reply = 0; reply < TURNS; reply++)
			assert.deepEqual(saved.get(reply), shown.get(reply), `reply A${reply} on its saved page`);
		// A page that starts at an odd turn: its first reply's miss and repeated count depend on the page before.
		assert.ok(
			reads.pages.some((turn) => turn !== undefined && turn > 1 && turn % 2 === 1),
			`a page starts at a reply that misses: ${reads.pages}`,
		);
	};
	return { mode, transcript, shown, reads, settle, scrollThrough };
}

test.each(["in-process", "isolated"])(
	"on the %s host, saved pages draw each reply's cache-miss and dropped-thinking warnings as the chat drew them before its compaction (#5606)",
	async (host) => {
		const { mode, transcript, shown, reads, settle, scrollThrough } = await openThenCompact(host, true);
		// What the open chat shows, and main's isolated host keeps showing after a compaction.
		assert.deepEqual(shown.get(3), ["Prompt cache miss: 25,000 tokens re-billed (cost unknown)"]);
		assert.deepEqual(shown.get(4), ["Anthropic dropped 2 thinking blocks (details in session)"]);

		// Up from the end, as a reader does after the compaction, then down from the start: the two directions cut
		// pages at different entries.
		await scrollThrough(-ROWS);
		const back = reads.pages.splice(0);
		transcript.scrollToStart();
		await settle();
		await scrollThrough(ROWS);
		assert.notDeepEqual(reads.pages, back.toReversed(), "pages read on from the start are cut elsewhere");
		reads.pages.push(...back);
		// One small read before each page at most.
		assert.ok(reads.bounded.length <= reads.pages.length, JSON.stringify(reads));
		for (const read of reads.bounded) assert.ok(read.entries <= read.limit && read.limit <= 16, JSON.stringify(read));

		// A copy of the saved rows draws them again, page by page, with the same warnings.
		assert.ok(mode.documentContainer instanceof WindowedContainer);
		const anchor = mode.documentContainer
			.layoutWindow({ width: COLUMNS, height: ROWS, top: 0, followEnd: false, requestRender: () => {} })
			.historyAnchor?.();
		assert.ok(anchor);
		const copied = warningsByReply((await anchor.read(1, anchor.last)).flatMap((block) => block.lines));
		for (let reply = 0; reply < TURNS; reply++)
			assert.deepEqual(copied.get(reply), shown.get(reply), `reply A${reply} copied`);
	},
);

test("with cache-miss notices off, as by default, saved pages read nothing more and draw no warnings (#5606)", async () => {
	const { shown, reads, scrollThrough } = await openThenCompact("in-process", false);
	assert.deepEqual([...shown.values()].flat(), []);
	await scrollThrough(-ROWS);
	assert.deepEqual(reads.bounded, []);
});
