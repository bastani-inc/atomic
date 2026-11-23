import assert from "node:assert/strict";
import { setKeybindings } from "@bastani/atomic-tui";
import { beforeAll, beforeEach, describe, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { filterAndSortSessions } from "../src/modes/interactive/components/session-selector-search.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const HOUR = 3_600_000;
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const ESCAPE = "\x1b";
const ENTER = "\r";
const BACKSPACE = "\x7f";
const KEYS = [UP, DOWN, RIGHT, PAGE_UP, PAGE_DOWN, ESCAPE, ENTER, BACKSPACE, " ", "a", "b", "f", "x", "z", "1"];
const WORDS = ["fix", "the", "shipping", "resume", "picker", "graph", "bench", "zone", "a1", "b2"];

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function makeSessions(random: () => number, count: number): SessionInfo[] {
	return Array.from({ length: count }, (_, index) => {
		const words = Array.from({ length: 3 }, () => WORDS[Math.floor(random() * WORDS.length)]!);
		return {
			path: `/tmp/sessions/s-${index}.jsonl`,
			id: `s-${index}`,
			cwd: "/work/project",
			created: new Date(Date.now() - (index + 3) * HOUR),
			modified: new Date(Date.now() - (index + 1) * HOUR),
			messageCount: 2 + index,
			firstMessage: words.join(" "),
			allMessagesText: words.join(" "),
		} as SessionInfo;
	});
}

function strip(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_[^\x07]*\x07/g, "");
}

/** What the picker should do, kept apart from how it does it: the search text, the preview, and what was chosen. */
interface Model {
	query: string;
	preview: boolean;
	cancels: number;
	chosen: string[];
}

describe("resume picker: selection, search, preview and leaving stay consistent under any key sequence (#5224)", () => {
	beforeAll(() => {
		initTheme("dark");
	});
	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("holds every invariant across 400 seeded key sequences", () => {
		let checks = 0;
		const visited = new Set<string>();
		for (let seed = 1; seed <= 400; seed++) {
			const random = mulberry32(seed);
			const sessions = makeSessions(random, 1 + Math.floor(random() * 9));
			const byPath = new Map(sessions.map((session) => [session.path, session]));
			const model: Model = { query: "", preview: false, cancels: 0, chosen: [] };
			const chosen: string[] = [];
			let cancels = 0;
			const picker = new SessionSelectorComponent(
				async () => sessions,
				async () => sessions,
				(session) => chosen.push(session.path),
				() => {
					cancels++;
				},
				() => {},
				() => {},
				{ keybindings: new KeybindingsManager(), initialSessions: sessions, canDelete: false },
			);
			const list = picker.getSessionList();
			for (let step = 0; step < 60; step++) {
				const key = KEYS[Math.floor(random() * KEYS.length)]!;
				const before = list.getSelectedSessionPath();
				const queryBefore = model.query;
				picker.handleInput(key);

				// Advance the model by what the key means, not by how the picker implements it.
				if (key === ESCAPE) {
					if (model.preview) model.preview = false;
					else if (model.query) model.query = "";
					else model.cancels++;
				} else if (key === ENTER || (key === RIGHT && !model.query)) {
					if (before !== undefined) model.chosen.push(before);
				} else if (key === " " && !model.query) {
					if (before !== undefined) model.preview = !model.preview;
				} else if (key === BACKSPACE) {
					model.query = model.query.slice(0, -1);
				} else if (key === " " || /^[a-z0-9]$/.test(key)) {
					model.query += key;
				}
				const expected = filterAndSortSessions(sessions, model.query, "relevance");
				if (expected.length === 0) model.preview = false;
				const queryChanged = model.query.trim() !== queryBefore.trim();

				const selected = list.getSelectedSessionPath();
				const lines = picker.render(120).map(strip);
				const hint = lines.at(-2) ?? "";
				const where = `seed ${seed} step ${step} key ${JSON.stringify(key)} query ${JSON.stringify(model.query)}`;

				// A row is selected exactly when there are rows, and it is one of them.
				if (expected.length === 0) assert.equal(selected, undefined, where);
				else {
					assert.ok(selected !== undefined, `nothing selected with ${expected.length} rows: ${where}`);
					assert.ok(
						expected.some((session) => session.path === selected),
						`selected row is not listed: ${where}`,
					);
					assert.equal(lines.filter((line) => line.includes("∀ ")).length, 1, where);
				}
				// A changed search selects its best match; emptying it returns to the row selected before.
				if (queryChanged && model.query.trim()) assert.equal(selected, expected[0]?.path, where);
				if (queryChanged && !model.query.trim() && before !== undefined) assert.equal(selected, before, where);
				// The preview is open exactly when the model says so, and only shows with a selected row.
				assert.equal(list.isPreviewOpen(), model.preview, where);
				const previewBoxes = lines.filter((line) => line.trimStart().startsWith("╭")).length - 1;
				assert.equal(previewBoxes, model.preview ? 1 : 0, where);
				// Leaving and choosing did what the model expects.
				assert.equal(cancels, model.cancels, where);
				assert.deepEqual(chosen, model.chosen, where);
				for (const path of chosen) assert.ok(byPath.has(path), where);
				// The hint names exactly the keys that work now.
				assert.equal(/space (preview|close preview)/.test(hint), selected !== undefined && !model.query, where);
				assert.equal(hint.includes("enter resume"), selected !== undefined, where);
				const esc = model.preview ? "esc close" : model.query ? "esc clear" : "esc cancel";
				assert.ok(hint.includes(esc), `${esc} missing from ${hint}: ${where}`);
				checks += 10;
				visited.add(`${model.preview}/${model.query === ""}/${expected.length === 0}`);
			}
		}
		assert.ok(checks >= 200_000, `only ${checks} checks ran`);
		// Every reachable combination of preview, search and empty list was exercised.
		for (const state of [
			"false/true/false",
			"true/true/false",
			"false/false/false",
			"true/false/false",
			"false/false/true",
		]) {
			assert.ok(visited.has(state), `never reached ${state}`);
		}
	});

	it.each([
		{ name: "↓", key: DOWN },
		{ name: "Page Down", key: PAGE_DOWN },
	])("keeps a row selected after $name on an empty search result once the search matches again (#5224)", ({ key }) => {
		const sessions = makeSessions(mulberry32(7), 3);
		const picker = new SessionSelectorComponent(
			async () => sessions,
			async () => sessions,
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager(), initialSessions: sessions },
		);
		const list = picker.getSessionList();
		for (const char of "qqq") picker.handleInput(char);
		assert.equal(list.getSelectedSessionPath(), undefined);
		picker.handleInput(key);
		picker.handleInput(ESCAPE);
		assert.ok(list.getSelectedSessionPath() !== undefined);
	});

	it("closes the preview when a search leaves no rows, so esc then clears the search (#5224)", () => {
		const sessions = makeSessions(mulberry32(9), 3);
		const picker = new SessionSelectorComponent(
			async () => sessions,
			async () => sessions,
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager(), initialSessions: sessions },
		);
		const list = picker.getSessionList();
		picker.handleInput(" ");
		assert.equal(list.isPreviewOpen(), true);
		for (const char of "qqq") picker.handleInput(char);
		assert.equal(list.isPreviewOpen(), false);
		const hint = strip(picker.render(120).at(-2) ?? "");
		assert.ok(hint.includes("esc clear"), hint);
	});

	it("→ resumes the selected row like enter when the search is empty (#5224)", () => {
		const sessions = makeSessions(mulberry32(11), 2);
		const chosen: string[] = [];
		const picker = new SessionSelectorComponent(
			async () => sessions,
			async () => sessions,
			(session) => chosen.push(session.path),
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager(), initialSessions: sessions },
		);
		const selected = picker.getSessionList().getSelectedSessionPath();
		picker.handleInput(RIGHT);
		assert.deepEqual(chosen, [selected]);
	});
});
