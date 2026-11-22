import assert from "node:assert/strict";
import { getKeybindings, setKeybindings, visibleWidth } from "@bastani/atomic-tui";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { TaskId, TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import {
	ownerTaskViewSource,
	type TaskViewSource,
} from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskFixture } from "../helpers/task-projection.js";
import { taskRecord } from "../helpers/task-record.js";
import { taskTranscriptEnvironment } from "../helpers/task-transcript-environment.js";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";

const LEFT = "\x1b[D";
const ESC = "\x1b";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const CTRL_HOME = "\x1b[1;5H";
const CTRL_END = "\x1b[1;5F";

const flush = async () => {
	for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

function plainLines(rows: readonly string[]): string[] {
	return rows.map((row) =>
		stripVTControlCharacters(row)
			.replace(/\x1b_[^\x07]*\x07/g, "")
			.trimEnd(),
	);
}

function leadingSpaces(line: string): number {
	const match = /^ */.exec(line);
	return match ? match[0].length : 0;
}

async function createShellHost(
	shell: TaskRecord,
	options: {
		output?:
			| string
			| (() => Promise<
					{ ok: true; value: { text: string; omitted: boolean } } | { ok: false; error: { message: string } }
			  >);
		themeName?: "dark" | "light";
		keys?: KeybindingsManager;
		onCancel?: (id: TaskId) => void;
	} = {},
) {
	initTheme(options.themeName ?? "dark");
	const keys = options.keys ?? new KeybindingsManager();
	setKeybindings(keys);
	const fixture = taskFixture();
	const owner = ownerTaskViewSource(fixture.store);
	const environment = taskTranscriptEnvironment({ keybindings: keys });
	const listeners = new Set<() => void>();
	let tasks = [shell];
	const source: TaskViewSource = {
		...owner,
		get tasks() {
			return tasks;
		},
		get backgroundTasks() {
			return tasks;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		readTaskOutput: async () =>
			typeof options.output === "function"
				? options.output()
				: { ok: true as const, value: { text: options.output ?? "line 1\nline 2", omitted: false } },
		cancelTask: async (id) => {
			options.onCancel?.(id);
			return { ok: true as const, value: undefined };
		},
	};
	const inspector = new TaskInspector(
		source,
		() => {},
		() => {},
		undefined,
		() => environment,
	);
	inspector.open(shell.ref.taskId);
	inspector.handleInput("\r");
	await flush();
	return {
		inspector,
		fixture,
		updateTasks(next: TaskRecord[]) {
			tasks = next;
			for (const listener of listeners) listener();
		},
		render: (width = 80, rows = 24) => inspector.renderViewport(width, rows),
		plain: (width = 80, rows = 24) => plainLines(inspector.renderViewport(width, rows)),
		async dispose() {
			inspector.dispose();
			await fixture.dispose();
		},
	};
}

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	previousKeys = getKeybindings();
});
afterEach(() => {
	setKeybindings(previousKeys);
	vi.restoreAllMocks();
});

describe("shell viewer layout and alignment", () => {
	test("aligns header, metadata, rounded output box, retention note and hint line on one 2-space left edge across widths", async () => {
		const shell = taskRecord("shell-align", "command");
		shell.title = "npm run build -- --watch";
		shell.metrics = { elapsedMs: 12_000 };
		const h = await createShellHost(shell, {
			output: Array.from({ length: 8 }, (_, i) => `build step ${i + 1}`).join("\n"),
		});
		try {
			for (const width of [60, 80, 120, 200]) {
				const raw = h.render(width, 28);
				const lines = plainLines(raw);
				assert.equal(raw.length, 28, `width ${width}: exact viewport height`);
				for (const [index, row] of raw.entries()) {
					assert.ok(visibleWidth(row) <= width, `width ${width} row ${index} overflows: ${visibleWidth(row)}`);
				}
				assert.match(lines[0] ?? "", /^▔+$/, `width ${width}: top edge rule`);
				const contentLines = lines.slice(1).filter((line) => line.length > 0);
				assert.ok(contentLines.length >= 8, `width ${width}: expected content rows:\n${lines.join("\n")}`);
				for (const line of contentLines) {
					assert.equal(leadingSpaces(line), 2, `width ${width}: misaligned line "${line}"\n${lines.join("\n")}`);
				}
				const topBox = lines.find((line) => line.includes("╭"));
				const bottomBox = lines.find((line) => line.includes("╰"));
				assert.ok(topBox && bottomBox, `width ${width}: expected rounded output box\n${lines.join("\n")}`);
				assert.equal(visibleWidth(topBox), width - 2, `width ${width}: symmetric 2-space box right margin`);
				assert.equal(visibleWidth(bottomBox), width - 2, `width ${width}: symmetric bottom border`);
				const text = lines.join("\n");
				assert.match(text, /npm run build -- --watch/);
				assert.match(text, /\bshell\b/);
				assert.match(text, /Status:\s+⧗ Running/);
				assert.match(text, /Runtime:\s+12s/);
				assert.match(text, /Command:\s+npm run build/);
				assert.match(text, /Retained shell output/);
				assert.match(lines.at(-1) ?? "", /^ {2}← tasks · pgup\/pgdn scroll/);
			}
		} finally {
			await h.dispose();
		}
	});

	test("ticks live elapsed time on running shells and shows settled exit code and error details", async () => {
		let now = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const shell = taskRecord("shell-live", "command");
		shell.title = "sleep 30";
		shell.metrics = { elapsedMs: 1_000 };
		const h = await createShellHost(shell, { output: "ticking..." });
		try {
			assert.match(h.plain(80, 26).join("\n"), /Runtime:\s+1s/);
			now += 5_000;
			assert.match(h.plain(80, 26).join("\n"), /Runtime:\s+6s/);

			const failed: TaskRecord = {
				...shell,
				execution: {
					kind: "settled",
					result: {
						kind: "failed",
						code: "command-failed",
						message: "command exited with status 42",
						exitCode: 42,
					},
				},
				metrics: { elapsedMs: 6_000 },
			};
			h.updateTasks([failed]);
			await flush();
			const settledText = h.plain(80, 26).join("\n");
			assert.match(settledText, /Status:\s+✗ Failed · exit 42/);
			assert.match(settledText, /Error:\s+command exited with status 42/);
			assert.doesNotMatch(h.plain(80, 26).at(-1) ?? "", /x stop/, "settled shell offers no stop key");
		} finally {
			await h.dispose();
		}
	});

	test("handles empty output, very long lines, and raw ANSI escape sequences safely", async () => {
		const emptyRunning = taskRecord("shell-empty", "command");
		emptyRunning.title = "sleep 10";
		const pending = Promise.withResolvers<{ ok: true; value: { text: string; omitted: boolean } }>();
		const hEmpty = await createShellHost(emptyRunning, { output: () => pending.promise });
		try {
			const loadingLines = hEmpty.plain(80, 24);
			assert.equal(
				loadingLines.filter((line) => line.includes("Loading output…")).length,
				1,
				`loading label should appear once:\n${loadingLines.join("\n")}`,
			);
			pending.resolve({ ok: true, value: { text: "", omitted: false } });
			await flush();
			const lines = hEmpty.plain(80, 24);
			const text = lines.join("\n");
			assert.match(text, /No output yet/);
			assert.ok(!lines.some((line) => line.includes("╭")), "empty output renders without an empty box");
			const noteLine = lines.find((line) => line.includes("No output yet"));
			assert.equal(leadingSpaces(noteLine ?? ""), 2);
		} finally {
			await hEmpty.dispose();
		}

		const longAndAnsi = taskRecord("shell-ansi", "command");
		longAndAnsi.title = "printf ansi";
		const longLine = `prefix-${"X".repeat(140)}-suffix`;
		const hAnsi = await createShellHost(longAndAnsi, {
			output: `${longLine}\n\x1b[31mred-danger\x1b[0m\x07\x1b]0;title\x07`,
		});
		try {
			const raw = hAnsi.render(60, 26);
			const lines = plainLines(raw);
			for (const row of raw) {
				assert.ok(visibleWidth(row) <= 60, `overflowed 60 cols: ${visibleWidth(row)}`);
				assert.ok(!row.includes("\x1b[31m"), "raw ANSI SGR from shell output must not leak");
				assert.ok(!row.includes("\x1b]0;"), "raw OSC from shell output must not leak");
			}
			const boxRows = lines.filter((line) => line.trimStart().startsWith("│"));
			assert.ok(boxRows.length >= 3, "long line wraps inside the box");
			for (const boxRow of boxRows) {
				assert.equal(visibleWidth(boxRow), 58, `box border stays aligned: "${boxRow}"`);
				assert.ok(boxRow.endsWith("│"), `right border intact: "${boxRow}"`);
			}
			assert.match(lines.join("\n"), /red-danger/);
		} finally {
			await hAnsi.dispose();
		}
	});

	test("supports scrolling to top and bottom with aligned range indicator and handles ultra-narrow viewports", async () => {
		const shell = taskRecord("shell-scroll", "command");
		shell.title = "seq 1 40";
		const h = await createShellHost(shell, {
			output: Array.from({ length: 40 }, (_, i) => `row-${String(i + 1).padStart(2, "0")}`).join("\n"),
		});
		try {
			const atBottom = h.plain(80, 24);
			assert.match(atBottom.join("\n"), /row-40/);
			assert.match(atBottom.join("\n"), /Retained shell output · lines \d+–40 of 40/);

			h.inspector.handleInput(CTRL_HOME);
			const atTop = h.plain(80, 24);
			assert.match(atTop.join("\n"), /row-01/);
			assert.match(atTop.join("\n"), /Retained shell output · lines 1–\d+ of 40/);

			h.inspector.handleInput(PAGE_DOWN);
			const mid = h.plain(80, 24);
			assert.doesNotMatch(mid.join("\n"), /row-01/);

			h.inspector.handleInput(CTRL_END);
			const backBottom = h.plain(80, 24);
			assert.match(backBottom.join("\n"), /row-40/);

			// Ultra-narrow and compact fallback never overflows or crashes
			for (const [w, b] of [
				[16, 8],
				[20, 10],
				[60, 12],
			] as const) {
				const compact = h.render(w, b);
				assert.ok(compact.length >= 1 && compact.length <= b);
				for (const row of compact) assert.ok(visibleWidth(row) <= w);
			}
		} finally {
			await h.dispose();
		}
	});

	test("shows aligned shell-specific ? help overlay and two-press x stop safety", async () => {
		const cancelled: TaskId[] = [];
		const shell = taskRecord("shell-help", "command");
		shell.title = "npm test";
		const h = await createShellHost(shell, {
			output: "running tests...",
			onCancel: (id) => cancelled.push(id),
		});
		try {
			h.inspector.handleInput("?");
			const helpLines = h.plain(80, 24);
			const helpText = helpLines.join("\n");
			assert.match(helpText, /╭─ keys · shell ─/);
			assert.doesNotMatch(helpText, /keys · task chat|empty prompt|latest message/);
			for (const line of helpLines.slice(1).filter((l) => l.length > 0)) {
				assert.equal(leadingSpaces(line), 2, `help overlay misaligned: "${line}"`);
			}
			// Keys wait while help overlay is open
			h.inspector.handleInput("x");
			assert.deepEqual(cancelled, []);
			h.inspector.handleInput(ESC);
			assert.doesNotMatch(h.plain(80, 24).join("\n"), /keys · shell/);

			// Two-press x stop: first press arms notice aligned at col 2, second press cancels
			h.inspector.handleInput("x");
			assert.deepEqual(cancelled, [], "single x press must not cancel");
			const armedLines = h.plain(80, 24);
			const armedNotice = armedLines.find((line) => line.includes("Press x again within 3s"));
			assert.ok(armedNotice, `expected stop confirm notice:\n${armedLines.join("\n")}`);
			assert.equal(leadingSpaces(armedNotice), 2, "stop confirm notice aligns at 2-space left edge");
			// Pressing another key disarms
			h.inspector.handleInput(PAGE_UP);
			assert.doesNotMatch(h.plain(80, 24).join("\n"), /Press x again/);

			// Arm and confirm with second press
			h.inspector.handleInput("x");
			h.inspector.handleInput("x");
			await flush();
			assert.deepEqual(cancelled, [shell.ref.taskId]);
		} finally {
			await h.dispose();
		}
	});

	test("preserves identical alignment and geometry across dark, light and NO_COLOR themes", async () => {
		const shell = taskRecord("shell-theme", "command");
		shell.title = "echo hello";
		shell.metrics = { elapsedMs: 3_000 };
		const frames: string[][] = [];
		const prevNoColor = process.env.NO_COLOR;
		try {
			for (const [themeName, noColor] of [
				["dark", undefined],
				["light", undefined],
				["dark", "1"],
			] as const) {
				if (noColor === undefined) delete process.env.NO_COLOR;
				else process.env.NO_COLOR = noColor;
				const h = await createShellHost(shell, { themeName, output: "hello world" });
				try {
					frames.push(h.plain(80, 24));
				} finally {
					await h.dispose();
				}
			}
			assert.deepEqual(frames[1], frames[0], "light theme matches dark theme geometry exactly");
			assert.deepEqual(frames[2], frames[0], "NO_COLOR matches dark theme geometry exactly");
		} finally {
			if (prevNoColor === undefined) delete process.env.NO_COLOR;
			else process.env.NO_COLOR = prevNoColor;
		}
	});

	test("does not leave a phantom blank line at the bottom of the box for newline-terminated output", async () => {
		const shell = taskRecord("shell-trail", "command");
		shell.title = "seq 1 12";
		const h = await createShellHost(shell, {
			output: `${Array.from({ length: 12 }, (_, i) => `item-${i + 1}`).join("\n")}\n`,
		});
		try {
			const lines = h.plain(100, 28);
			const boxRows = lines.filter((line) => line.trimStart().startsWith("│"));
			assert.equal(boxRows.length, 12, `expected exact 12 output rows:\n${lines.join("\n")}`);
			assert.match(boxRows.at(-1) ?? "", /│ item-12\s+│$/);
		} finally {
			await h.dispose();
		}
	});

	test("aligns sibling notices in TaskInspector (board, detail, agent transcript)", async () => {
		initTheme("dark");
		const keys = new KeybindingsManager();
		setKeybindings(keys);
		const fixture = taskFixture();
		const owner = ownerTaskViewSource(fixture.store);
		const environment = taskTranscriptEnvironment({ keybindings: keys });
		const inspector = new TaskInspector(
			owner,
			() => {},
			() => {},
			undefined,
			() => environment,
		);
		try {
			await fixture.start("Sibling task");
			const session = SessionManager.inMemory();
			await session.appendMessage({ role: "user", content: "hello", timestamp: 0 });
			fixture.runners[0].context.bindTranscript(session);

			// Board stop notice aligns at col 2 with hint line
			inspector.renderViewport(100, 20);
			inspector.handleInput("x");
			const boardLines = plainLines(inspector.renderViewport(100, 20));
			const boardNotice = boardLines.find((l) => l.includes("Press x again"));
			assert.ok(boardNotice);
			assert.equal(leadingSpaces(boardNotice), 2, `board stop notice misaligned: "${boardNotice}"`);
			assert.equal(leadingSpaces(boardLines.at(-1) ?? ""), 2);
			inspector.handleInput(ESC); // clears nothing or closes; reopen to check detail

			// Detail view stop notice aligns at col 2 with hint line
			inspector.open(fixture.store.tasks[0]!.ref.taskId);
			inspector.handleInput(" ");
			inspector.handleInput("\r");
			await flush();
			inspector.renderViewport(100, 24);
			inspector.handleInput("x");
			const detailLines = plainLines(inspector.renderViewport(100, 24));
			const detailNotice = detailLines.find((l) => l.includes("Press x again"));
			assert.ok(detailNotice);
			assert.equal(leadingSpaces(detailNotice), 2, `detail stop notice misaligned: "${detailNotice}"`);

			// Agent transcript view back navigation works
			inspector.handleInput("\r");
			await flush();
			inspector.handleInput(LEFT);
			await flush();
			assert.match(plainLines(inspector.renderViewport(100, 24)).join("\n"), /Inspect transcript/);
		} finally {
			inspector.dispose();
			await fixture.dispose();
		}
	});

	test("clears finished-while-armed notice on x when a shell settles after the first stop press", async () => {
		const cancelled: TaskId[] = [];
		const shell = taskRecord("shell-settle-armed", "command");
		shell.title = "sleep 5";
		const h = await createShellHost(shell, {
			output: "working...",
			onCancel: (id) => cancelled.push(id),
		});
		try {
			h.inspector.handleInput("x");
			assert.match(h.plain(80, 24).join("\n"), /Press x again within 3s to stop sleep 5/);
			assert.deepEqual(cancelled, []);

			// Shell finishes on its own before the second x arrives.
			const settled: TaskRecord = {
				...shell,
				execution: { kind: "settled", result: { kind: "completed", output: shell.output, exitCode: 0 } },
			};
			h.updateTasks([settled]);
			await flush();
			const afterSettle = h.plain(80, 24).join("\n");
			assert.match(afterSettle, /sleep 5 finished · x to acknowledge/);
			assert.doesNotMatch(afterSettle, /Press x again/);

			// Pressing x acknowledges and clears the finished notice instead of leaving it stuck.
			h.inspector.handleInput("x");
			const afterAck = h.plain(80, 24).join("\n");
			assert.doesNotMatch(afterAck, /finished · x to acknowledge/, `notice stayed stuck:\n${afterAck}`);
			assert.deepEqual(cancelled, [], "settled shell must never be cancelled");
		} finally {
			await h.dispose();
		}
	});

	test("waited-shell view keeps the parent subagent extension status row and direct shell releases old watches", async () => {
		initTheme("dark");
		const keys = new KeybindingsManager();
		setKeybindings(keys);
		const fixture = taskFixture();
		const owner = ownerTaskViewSource(fixture.store);
		const environment = taskTranscriptEnvironment({ keybindings: keys });
		const agent: TaskRecord = {
			...taskRecord("wait-agent", "agent"),
			agentName: "builder",
			title: "build workspace",
			wasBackground: true,
			observation: { kind: "none", reason: "task-settled" },
			execution: {
				kind: "settled",
				result: {
					kind: "cancelled",
					cause: "pause",
					released: { waitingOn: [{ toolCallId: "bash-1", toolName: "bash" }] },
				},
			},
		};
		const waitedShell: TaskRecord = {
			...taskRecord("wait-shell", "command"),
			title: "npm run build",
			parentTaskId: agent.ref.taskId,
		};
		const directShell: TaskRecord = {
			...taskRecord("direct-shell", "command"),
			title: "echo standalone",
		};
		let watchReleases = 0;
		const source: TaskViewSource = {
			...owner,
			get tasks() {
				return [agent, directShell];
			},
			get backgroundTasks() {
				return [agent, directShell];
			},
			get ownerTasks() {
				return [agent, waitedShell, directShell];
			},
			get ownerBackgroundTasks() {
				return [agent, waitedShell, directShell];
			},
			extensionStatuses: (id) => (id === agent.ref.taskId ? new Map([["meter", "42 tok/s"]]) : new Map()),
			watchExtensionStatuses: () => () => {
				watchReleases++;
			},
			readTaskOutput: async (id) => ({ ok: true as const, value: { text: `output of ${id}`, omitted: false } }),
		};
		const inspector = new TaskInspector(
			source,
			() => {},
			() => {},
			undefined,
			() => environment,
		);
		try {
			inspector.open(agent.ref.taskId);
			inspector.renderViewport(100, 24);
			// Alt+W opens the waited shell while keeping the subagent's extension status row.
			inspector.handleInput("\x1bw");
			await flush();
			const waitedLines = plainLines(inspector.renderViewport(100, 24));
			assert.match(waitedLines.join("\n"), /npm run build/);
			assert.match(
				waitedLines.at(-1) ?? "",
				/42 tok\/s/,
				`waited shell dropped extension status:\n${waitedLines.join("\n")}`,
			);

			// Back to list, then open the standalone direct shell: previous agent's status watch must be released.
			inspector.handleInput(LEFT);
			inspector.open(directShell.ref.taskId);
			inspector.handleInput("\r");
			await flush();
			const directLines = plainLines(inspector.renderViewport(100, 24));
			assert.match(directLines.join("\n"), /echo standalone/);
			assert.doesNotMatch(directLines.join("\n"), /42 tok\/s/);
			assert.ok(watchReleases >= 1, "opening a direct shell must release any previous agent status watch");
		} finally {
			inspector.dispose();
			await fixture.dispose();
		}
	});
});
