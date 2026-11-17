import assert from "node:assert/strict";
import * as fs from "node:fs";
import { setKeybindings } from "@bastani/atomic-tui";
import { beforeAll, beforeEach, describe, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { buildSessionTree, flattenSessionTree } from "../src/modes/interactive/components/session-selector-tree.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, realpathSync: vi.fn(actual.realpathSync) };
});

const HOUR = 3_600_000;
const BACKSPACE = "\x7f";

function sessions(count: number, parentOf: (index: number) => string | undefined): SessionInfo[] {
	return Array.from({ length: count }, (_, index) => ({
		path: `/tmp/resume-cost/s-${index}.jsonl`,
		id: `s-${index}`,
		cwd: "/work/project",
		created: new Date(Date.now() - (index + 2) * HOUR),
		modified: new Date(Date.now() - (index + 1) * HOUR),
		messageCount: 3,
		firstMessage: `message ${index}`,
		allMessagesText: `message ${index}`,
		...(parentOf(index) !== undefined ? { parentSessionPath: parentOf(index) } : {}),
	})) as SessionInfo[];
}

function realpathCalls(): number {
	return vi.mocked(fs.realpathSync).mock.calls.length;
}

describe("resume picker cost follows what changed, not how many sessions there are (#5224)", () => {
	beforeAll(() => {
		initTheme("dark");
	});
	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		vi.mocked(fs.realpathSync).mockClear();
	});

	it("threads 1,000 sessions whose parents are named exactly without touching the disk", () => {
		const rows = sessions(1000, (index) => (index % 10 === 9 ? `/tmp/resume-cost/s-${index - 1}.jsonl` : undefined));
		const flat = flattenSessionTree(buildSessionTree(rows));
		assert.equal(flat.length, 1000);
		assert.equal(flat.filter((node) => node.depth === 1).length, 100);
		assert.equal(realpathCalls(), 0);
	});

	it.each([1, 2, 3])("keeps imported sessions visible through a %i-node parent cycle (#5256)", (length) => {
		const rows = sessions(length + 2, (index) =>
			index < length
				? `/tmp/resume-cost/s-${(index + 1) % length}.jsonl`
				: index === length
					? "/tmp/resume-cost/s-0.jsonl"
					: undefined,
		);
		for (const ordered of [rows, [...rows].reverse()]) {
			const flat = flattenSessionTree(buildSessionTree(ordered));
			assert.equal(flat.length, rows.length);
			assert.deepEqual(new Set(flat.map((node) => node.session.id)), new Set(rows.map((row) => row.id)));
			const parent = flat.find((node) => node.session.id === "s-0");
			const child = flat.find((node) => node.session.id === `s-${length}`);
			assert.ok(parent && child);
			assert.equal(child.depth, parent.depth + 1);
		}
		assert.equal(realpathCalls(), 0);
	});

	it("resolves another spelling of a parent once per session, and a rebuild resolves nothing on the event loop", () => {
		const rows = sessions(1000, (index) => (index === 5 ? "/tmp/resume-cost/./s-4.jsonl" : undefined));
		const flat = flattenSessionTree(buildSessionTree(rows));
		assert.equal(flat.find((node) => node.session.id === "s-5")?.depth, 1, "the other spelling names its parent");
		assert.ok(realpathCalls() <= 1001, `${realpathCalls()} canonicalizations`);
		vi.mocked(fs.realpathSync).mockClear();
		buildSessionTree(rows);
		// Symlinked spellings are resolved off the event loop, before the picker rebuilds; a rebuild reads none.
		assert.equal(realpathCalls(), 0);
	});

	it("opens and clears a search over 1,000 sessions without touching the disk", () => {
		const rows = sessions(1000, () => undefined);
		const picker = new SessionSelectorComponent(
			async () => rows,
			async () => rows,
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager(), initialSessions: rows },
		);
		picker.render(120);
		for (const char of "message 9") picker.handleInput(char);
		for (let index = 0; index < "message 9".length; index++) picker.handleInput(BACKSPACE);
		picker.render(120);
		assert.equal(realpathCalls(), 0);
	});
});
