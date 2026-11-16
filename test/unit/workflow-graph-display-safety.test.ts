import assert from "node:assert/strict";
import { BackgroundCompactionPersistError } from "@bastani/atomic";
import { StoragePayloadTooLargeError, StorageRollbackError, StorageUnavailableError } from "@bastani/atomic/storage";
import {
	type Component,
	stripTerminalSequences,
	type Terminal,
	TuiMainScreen,
	visibleWidth,
} from "@bastani/atomic-tui";
import { test, vi } from "vitest";
import { renderAgentPanelRows } from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { themedAgentPanelStyle } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import { inspectRun } from "../../packages/workflows/src/runs/background/run-inspect.js";
import { MAX_CAUSE_DEPTH } from "../../packages/workflows/src/shared/error-cause-chain.js";
import { type SerializedError, serializeError } from "../../packages/workflows/src/shared/error-codec.js";
import type { StageSnapshot, ToolNodeSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import * as toolPayloadBounds from "../../packages/workflows/src/shared/tool-payload-bounds.js";
import { typedFailureDetail } from "../../packages/workflows/src/shared/typed-failure-detail.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import type { GraphViewOpts } from "../../packages/workflows/src/tui/graph-view-types.js";
import { renderNodeCard } from "../../packages/workflows/src/tui/node-card.js";
import { panelItemsFromSnapshot } from "../../packages/workflows/src/tui/panel-runs.js";
import { renderRunDetail } from "../../packages/workflows/src/tui/run-detail.js";
import {
	renderStageFailureDetailLines,
	stageFailureLogLines,
	stageFailureReason,
} from "../../packages/workflows/src/tui/stage-failure-detail.js";
import { renderStatusList } from "../../packages/workflows/src/tui/status-list.js";
import { wrapPlainText } from "../../packages/workflows/src/tui/text-helpers.js";
import { renderToolDetail } from "../../packages/workflows/src/tui/tool-detail.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
import { defaultTheme, makeSnap, makeStage, makeStore } from "./overlay-graph-helpers.js";

const { boundedToolPayloadText, TOOL_PAYLOAD_TRUNCATION_MARKER } = toolPayloadBounds;

function graphFor(stage: StageSnapshot, options: Partial<GraphViewOpts> = {}): GraphView {
	return new GraphView({
		mode: "overlay",
		runId: "run-1",
		store: makeStore(makeSnap([stage])),
		graphTheme: defaultTheme,
		piKeybindings: makeFakeKeybindings(),
		piTui: { terminal: { rows: 40 } },
		...options,
	});
}

function assertSafeRows(rows: readonly string[]): void {
	const text = rows.join("\n");
	assert.equal(text.includes("\x1b[2J"), false, "data never clears the terminal");
	assert.equal(text.includes("\x1b]52;"), false, "data never emits clipboard controls");
	assert.doesNotMatch(text, /[\u0080-\u009f]/);
	assert.ok(
		rows.every((row) => !row.includes("\n") && !row.includes("\r")),
		"each rendered row is one physical line",
	);
}

test.each(["result", "rejection"])(
	"graph action %s notices stay on one safe row before width truncation (#5234)",
	async (kind) => {
		const message = "Notice\x1b[2JNAME\nsecond\x1b]52;c;Yg==\x07\u009b2J";
		const graph = graphFor(
			{ ...makeStage("worker"), status: "running" },
			{
				stageActions: {
					stop: async () => {
						if (kind === "rejection") throw new Error(message);
						return { ok: true, message };
					},
				},
			},
		);
		try {
			graph.handleInput("x");
			graph.handleInput("x");
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			for (const width of [80, 160]) assertSafeRows(graph.render(width));
			assert.ok(graph.render(160).join("\n").includes("Notice\\x1b[2JNAME second"));
		} finally {
			graph.dispose();
		}
	},
);

for (const expanded of [false, true]) {
	for (const kind of ["object", "string", "summary"] as const) {
		test(`tool ${kind} controls are inert in ${expanded ? "expanded" : "collapsed"} display while stored bytes stay unchanged (#5234)`, () => {
			const node: ToolNodeSnapshot = {
				kind: "tool",
				id: "tool:safe",
				name: "safe",
				argsHash: "safe",
				ordinal: 1,
				parentIds: [],
				status: "completed",
				attachable: false,
				args: { "\u009b2Jkey": "arg\u009d52;c;Yg==\u009c" },
				...(kind === "object"
					? { result: { nested: "result\u009b2J\u007f" } }
					: kind === "string"
						? { result: "result\u009b2J\u007f" }
						: { resultSummary: "summary\u009b2J\u007f" }),
			};
			const before = JSON.stringify(node);
			const rows = renderToolDetail(node, { expanded, width: 200 }).split("\n");
			assertSafeRows(rows);
			assert.ok(rows.join("\n").includes("\\u009b2Jkey"));
			assert.ok(rows.join("\n").includes("\\u007f"));
			assert.equal(JSON.stringify(node), before);
		});
	}
}

test("display JSON escapes every DEL and C1 control and remains parseable before truncation (#5234)", () => {
	const controls = Array.from({ length: 33 }, (_, index) => String.fromCodePoint(0x7f + index)).join("");
	const value = { [controls]: controls };
	const text = boundedToolPayloadText(value);
	assert.doesNotMatch(text, /[\u007f-\u009f]/);
	assert.deepEqual(JSON.parse(text), value);
	const clipped = boundedToolPayloadText({ controls: controls.repeat(100) }, 128);
	assert.ok(clipped.length <= 128);
	assert.ok(clipped.includes(TOOL_PAYLOAD_TRUNCATION_MARKER));
	assert.doesNotMatch(clipped, /[\u007f-\u009f]/);
});

test("display serialization bounds long property keys before quoting them (#5234)", () => {
	const value = { ["key".repeat(1_000)]: "value" };
	const quoted = vi.spyOn(JSON, "stringify");
	try {
		const text = boundedToolPayloadText(value, 64);
		assert.ok(text.length <= 64);
		assert.ok(quoted.mock.calls.every(([input]) => typeof input !== "string" || input.length <= 64));
	} finally {
		quoted.mockRestore();
	}
});

test.each(["card", "detail", "panel"])(
	"%s graph labels keep C1 controls inert without changing stored names (#5234)",
	(surface) => {
		const stage: StageSnapshot = { ...makeStage("stage"), status: "running", name: "model\u009b2JNAME" };
		const node: ToolNodeSnapshot = {
			kind: "tool",
			id: "tool:label",
			name: "tool\u009b2JNAME",
			error: "failure\u009d52;c;Yg==\u009c",
			argsHash: "label",
			ordinal: 1,
			parentIds: [],
			status: "failed",
			attachable: false,
		};
		const snap = makeSnap([stage]);
		snap.runs[0]!.toolNodes.push(node);
		const before = JSON.stringify(snap);
		if (surface === "card") assertSafeRows(renderNodeCard(stage, { theme: defaultTheme, width: 40 }));
		else if (surface === "detail") {
			const detail = inspectRun("run-1", { store: makeStore(snap), now: 2 });
			assert.ok(detail.ok);
			for (const theme of [undefined, defaultTheme])
				assertSafeRows(renderRunDetail(detail.detail, { theme, width: 200, now: 2 }).split("\n"));
		} else {
			initTheme("dark");
			assertSafeRows(
				renderAgentPanelRows(
					panelItemsFromSnapshot([{ ...snap.runs[0]!, toolNodes: [{ ...node, status: "running" }] }]),
					200,
					themedAgentPanelStyle(),
				),
			);
		}
		assert.equal(JSON.stringify(snap), before);
	},
);

test.each(["error", "source"] as const)("tool %s display bounds input before sanitizing it (#5234)", (field) => {
	const node: ToolNodeSnapshot = {
		kind: "tool",
		id: "tool:bounded",
		name: "safe",
		argsHash: "bounded",
		ordinal: 1,
		parentIds: [],
		status: "completed",
		attachable: false,
	};
	node[field] = "x".repeat(toolPayloadBounds.TOOL_PAYLOAD_VALUE_LIMIT + 128);
	const sanitized = vi.spyOn(toolPayloadBounds, "sanitizeToolDisplayText");
	try {
		renderToolDetail(node, { expanded: true, width: 200 });
		assert.ok(sanitized.mock.calls.length > 0);
		assert.ok(sanitized.mock.calls.every(([input]) => input.length <= toolPayloadBounds.TOOL_PAYLOAD_VALUE_LIMIT));
	} finally {
		sanitized.mockRestore();
	}
});

test("failure summary and logs render control-bearing fields as printable data without changing stored values (#5234)", () => {
	const stage: StageSnapshot = {
		...makeStage("verify"),
		status: "failed",
		name: "verify\x1b[2JNAME\nsecond",
		error: "gate \x1b]52;c;Yg==\x07 denied",
		failureMessage: "first\u009b2J\nsecond",
		failureDetail: {
			name: "Provider\x1b[2JNAME\nINJECT",
			code: "CODE\u009b2J\nMORE",
			message: "message\x1b]52;c;Yg==\x07",
			hint: "hint\x1b[2J\nnext",
			fields: {},
			cause: { name: "Cause", message: "cause\u009b2J", fields: {} },
			cleanupCause: { name: "Cleanup", message: "cleanup\u009d52;c;Yg==\u009c", fields: {} },
			errors: [{ name: "Member", message: "member\x1b[2J", fields: {} }],
		},
	};
	const before = JSON.stringify(stage);
	const graph = graphFor(stage);
	try {
		graph.handleInput("\r");
		const summary = graph.render(160);
		assertSafeRows(summary);
		assert.ok(summary.join("\n").includes("verify\\x1b[2JNAME second"));
		assert.ok(summary.join("\n").includes("gate \\x1b]52;c;Yg==\\x07 denied"));
		graph.handleInput("l");
		const logs = graph.render(160);
		assertSafeRows(logs);
		const text = logs.join("\n");
		for (const expected of [
			"Provider\\x1b[2JNAME INJECT",
			"CODE\\x9b2J MORE",
			"message\\x1b]52;c;Yg==\\x07",
			"hint\\x1b[2J",
			"cause\\x9b2J",
			"cleanup\\x9d52;c;Yg==\\x9c",
			"member\\x1b[2J",
		])
			assert.ok(text.includes(expected), expected);
		assert.equal(JSON.stringify(stage), before);
	} finally {
		graph.dispose();
	}
});

test("a 2 MB stage error is bounded before splitting and caps the summary reason at 3 rows (#5234)", () => {
	const error = "E".repeat(2_000_000);
	const stage: StageSnapshot = {
		...makeStage("verify"),
		status: "failed",
		error,
		failureMessage: error,
		startedAt: 1,
		endedAt: 2,
	};
	const bounded = vi.spyOn(toolPayloadBounds, "boundedToolText");
	const titleSanitized = vi.spyOn(toolPayloadBounds, "sanitizeToolTitleText");
	const displaySanitized = vi.spyOn(toolPayloadBounds, "sanitizeToolDisplayText");
	try {
		const summary = renderStageFailureDetailLines(stage, { theme: defaultTheme, width: 120, logs: false });
		const reasonRows = summary.slice(2);
		assert.equal(reasonRows.length, 3);
		assert.ok(reasonRows[2]?.includes("…"), "capped reason ends with an ellipsis");
		assert.ok(bounded.mock.calls.length > 0);
		assert.ok(
			titleSanitized.mock.calls.every(([input]) => input.length <= 120 * 4),
			"summary sanitizes only the sliced reason head and title",
		);

		const logLines = stageFailureLogLines(stage);
		assert.equal(logLines.length, 1);
		assert.ok(logLines[0]!.length <= toolPayloadBounds.TOOL_PAYLOAD_VALUE_LIMIT);

		const logs = renderStageFailureDetailLines(stage, { theme: defaultTheme, width: 120, logs: true });
		assert.ok(logs.length <= 160, `expected bounded log rows, got ${logs.length}`);
		assert.ok(
			displaySanitized.mock.calls.every(([input]) => input.length <= toolPayloadBounds.TOOL_PAYLOAD_VALUE_LIMIT),
		);
		assert.ok(stageFailureReason(stage).length <= toolPayloadBounds.TOOL_PAYLOAD_VALUE_LIMIT);

		const deepErrors = Array.from({ length: 200 }, (_, index) => ({
			name: `MemberError${index}`,
			message: "M".repeat(5_000),
			hint: "H".repeat(5_000),
			fields: {},
		}));
		const withTree: StageSnapshot = {
			...stage,
			error: Array.from({ length: 100_000 }, (_, index) => `at frame ${index} (file.ts:${index}:1)`).join("\n"),
			failureMessage: undefined,
			failureDetail: {
				name: "AggregateFailure",
				message: "A".repeat(20_000),
				fields: {},
				errors: deepErrors,
			},
		};
		const treeLogs = renderStageFailureDetailLines(withTree, { theme: defaultTheme, width: 120, logs: true });
		assert.ok(treeLogs.length <= 600, `expected bounded tree log rows, got ${treeLogs.length}`);
	} finally {
		bounded.mockRestore();
		titleSanitized.mockRestore();
		displaySanitized.mockRestore();
	}
});

test("failure detail visits a bounded number of repeated error entries (#5234)", () => {
	let entriesRead = 0;
	const member = { name: "Error", message: "duplicate", fields: {} };
	const errors = new Proxy(
		Array.from({ length: 10_000 }, () => member),
		{
			get(target, property, receiver) {
				if (typeof property === "string" && /^\d+$/.test(property)) entriesRead++;
				return Reflect.get(target, property, receiver);
			},
		},
	);
	const lines = stageFailureLogLines({
		failureDetail: { name: "AggregateError", message: "failure", fields: {}, errors },
	});
	assert.ok(lines.some((line) => line.includes("duplicate")));
	assert.ok(entriesRead <= 32, `visited ${entriesRead} repeated entries`);
});

test("failure logs render the deepest recorded cause and omit bare child headings (#5234)", () => {
	let rootCause: Error = new Error(`level ${MAX_CAUSE_DEPTH - 1} root cause`);
	for (let level = MAX_CAUSE_DEPTH - 2; level >= 0; level--) {
		rootCause = new Error(`level ${level}`, { cause: rootCause });
	}
	const chainStage: StageSnapshot = {
		...makeStage("verify"),
		status: "failed",
		error: "level 0",
		failureMessage: "level 0",
		failureDetail: serializeError(rootCause),
	};
	const chainLines = stageFailureLogLines(chainStage);
	assert.ok(
		chainLines.some((line) => line.includes(`level ${MAX_CAUSE_DEPTH - 1} root cause`)),
		"deepest serialized cause is rendered",
	);
	const renderedChain = renderStageFailureDetailLines(chainStage, {
		theme: defaultTheme,
		width: 120,
		logs: true,
	}).join("\n");
	assert.ok(renderedChain.includes(`level ${MAX_CAUSE_DEPTH - 1} root cause`));

	const cyclic: {
		name: string;
		message: string;
		fields: Record<string, never>;
		cause?: SerializedError;
		cleanupCause?: SerializedError;
	} = {
		name: "Error",
		message: "loop",
		fields: {},
	};
	cyclic.cause = cyclic;
	cyclic.cleanupCause = cyclic;

	let overDepth: SerializedError = { name: "Error", message: "beyond max depth", fields: {} };
	for (let level = MAX_CAUSE_DEPTH; level >= 0; level--) {
		overDepth = {
			name: "Error",
			message: `depth ${level}`,
			fields: {},
			cause: overDepth,
			cleanupCause: { name: "CleanupError", message: `cleanup ${level}`, fields: {} },
		};
	}

	for (const detail of [chainStage.failureDetail!, cyclic as SerializedError, overDepth]) {
		const logLines = stageFailureLogLines({ error: "failed", failureDetail: detail });
		for (let index = 0; index < logLines.length; index++) {
			const line = logLines[index]!;
			if (/^\s*(caused by:|during rollback:|during cleanup:)$/.test(line)) {
				const next = logLines[index + 1];
				assert.ok(next !== undefined && next.trim().length > 0, `dangling heading at line ${index}: ${line}`);
				assert.equal(/^\s*(caused by:|during rollback:|during cleanup:)$/.test(next), false);
			}
		}
	}
});

test("failure logs omit bare child headings when the character budget runs out right after a heading (#5234)", () => {
	for (const [memberLength, rootLength] of [
		[469, 11],
		[470, 3],
	] as const) {
		const detail: SerializedError = {
			name: "AggregateError",
			message: "r".repeat(rootLength),
			fields: {},
			errors: Array.from({ length: 10 }, (_, index) => ({
				name: "Error",
				message: `member-${index}-`.padEnd(memberLength, "m"),
				fields: {},
				cause: { name: "CauseError", message: `cause-${index}-`.padEnd(memberLength, "c"), fields: {} },
				cleanupCause: { name: "CleanupError", message: `cleanup-${index}`, fields: {} },
			})),
		};
		const lines = stageFailureLogLines({
			error: "Error: build failed",
			failureMessage: "Error: build failed",
			failureDetail: detail,
		});
		for (let index = 0; index < lines.length; index++) {
			const match = /^(\s*)(caused by:|during rollback:|during cleanup:)$/.exec(lines[index]!);
			if (match === null) continue;
			const next = lines[index + 1];
			const childShown =
				next !== undefined && next.trim().length > 0 && next.length - next.trimStart().length > match[1]!.length;
			const truncatedChild = next !== undefined && next.trim() === TOOL_PAYLOAD_TRUNCATION_MARKER;
			assert.ok(childShown || truncatedChild, `dangling heading at line ${index}: ${lines[index]}`);
		}
	}
});

test("failure logs preserve the stage message share when the error tree is large and cap detail-less messages at 4 KB (#5234)", () => {
	const failureDetail: SerializedError = {
		name: "AggregateError",
		code: "E_AGGREGATE",
		message: "many steps failed",
		fields: {},
		errors: Array.from({ length: 31 }, (_, index) => ({
			name: "Error",
			code: `E_STEP_${index}`,
			message: `step ${index} failed: `.padEnd(512, "x"),
			fields: {},
		})),
	};
	const message = "Error: build failed in packages/workflows";
	const lines = stageFailureLogLines({ error: message, failureMessage: message, failureDetail });
	assert.equal(lines[0], message);
	assert.ok(lines.some((line) => line.includes("E_AGGREGATE")));

	const hugeMessage = "E".repeat(2_000_000);
	const detailLess = stageFailureLogLines({ error: hugeMessage, failureMessage: hugeMessage }).join("\n");
	assert.ok(detailLess.endsWith(TOOL_PAYLOAD_TRUNCATION_MARKER));
	assert.ok(detailLess.length <= 4_096);
});

test("failure logs keep the root error code and hint when both the stack and structured detail exceed 128 rows (#5234)", () => {
	const stack = `Error: build failed\n${Array.from({ length: 400 }, (_, index) => `    at frame${index} (f.ts:${index}:1)`).join("\n")}`;
	const detail: SerializedError = {
		name: "AggregateError",
		code: "E_ROOT",
		message: `root aggregate ${"r".repeat(120)}`,
		hint: `ROOT-HINT ${"h".repeat(120)}`,
		fields: {},
		errors: Array.from({ length: 31 }, (_, index) => ({
			name: "TypeError",
			code: `E_M${index}`,
			message: `member ${index} ${"m".repeat(120)}`,
			hint: `member hint ${index} ${"k".repeat(120)}`,
			fields: {},
		})),
	};
	const stage: StageSnapshot = {
		...makeStage("verify"),
		status: "failed",
		error: stack,
		failureMessage: stack,
		failureDetail: detail,
		startedAt: 1,
		endedAt: 2,
	};
	for (const width of [40, 80, 120]) {
		const rows = renderStageFailureDetailLines(stage, { theme: defaultTheme, width, logs: true }).map(
			stripTerminalSequences,
		);
		assert.ok(rows.length <= 3 + 256, `expected <= 259 rows at width ${width}, got ${rows.length}`);
		const text = rows.join("\n");
		assert.ok(text.includes("build failed"), `missing message head at width ${width}`);
		assert.ok(text.includes("E_ROOT"), `missing E_ROOT at width ${width}`);
		assert.ok(text.includes("ROOT-HINT"), `missing ROOT-HINT at width ${width}`);
	}
});

test("failure log view preserves leading indentation for stack frames and nested causes (#5234)", () => {
	const message = "Error: build failed\n    at main (a.ts:1:1)\n        at inner (b.ts:2:2)";
	const stage: StageSnapshot = {
		...makeStage("verify"),
		status: "failed",
		error: message,
		failureMessage: message,
		failureDetail: {
			name: "AggregateError",
			code: "E_ROOT",
			message: "two steps failed",
			fields: {},
			cause: { name: "Error", message: "cause of root", fields: {} },
			errors: [
				{
					name: "TypeError",
					code: "E_A",
					message: "step a",
					fields: {},
					cause: { name: "Error", message: "cause of a", fields: {} },
				},
			],
		},
	};
	const rows = renderStageFailureDetailLines(stage, { theme: defaultTheme, width: 120, logs: true }).map(
		stripTerminalSequences,
	);
	const leadingSpaces = (needle: string): number => {
		const row = rows.find((candidate) => candidate.includes(needle));
		assert.ok(row !== undefined, `missing row containing ${needle}`);
		return row.length - row.trimStart().length;
	};
	assert.equal(leadingSpaces("at main") - leadingSpaces("Error: build failed"), 4);
	assert.equal(leadingSpaces("at inner") - leadingSpaces("at main"), 4);
	assert.equal(leadingSpaces("Error: cause of a") - leadingSpaces("TypeError (E_A): step a"), 2);
});

test("failure logs render a storage error's rollbackCause and extra envelope fields (#5234)", () => {
	const rollbackFailure = new StoragePayloadTooLargeError(1_024, 2_048, {
		kind: "value",
		descriptor: { adapter: "sqlite", location: "journal.sqlite" },
	});
	const rollbackError = new StorageRollbackError(
		new StorageUnavailableError({ adapter: "sqlite", location: "journal.sqlite" }, new Error("commit failed")),
		rollbackFailure,
	);
	const compactionError = new BackgroundCompactionPersistError({ upToEntryId: "u3" }, { cause: rollbackError });
	const detail = typedFailureDetail(compactionError);
	assert.ok(detail !== undefined);
	assert.deepEqual(detail.extra, { phase: "persist" });
	const stage: StageSnapshot = {
		...makeStage("verify"),
		status: "failed",
		error: "stage failed",
		failureMessage: "stage failed",
		failureDetail: detail,
	};
	const lines = stageFailureLogLines(stage);
	assert.ok(lines.some((line) => line.includes('"phase":"persist"')));
	const rollbackHeadingIndex = lines.findIndex((line) => line.trim() === "during rollback:");
	assert.ok(rollbackHeadingIndex >= 0, "expected during rollback: heading");
	assert.ok(lines[rollbackHeadingIndex + 1]?.includes("StoragePayloadTooLargeError (payload-too-large)"));
	const rendered = renderStageFailureDetailLines(stage, { theme: defaultTheme, width: 120, logs: true })
		.map(stripTerminalSequences)
		.join("\n");
	assert.ok(rendered.includes('"phase":"persist"'));
	assert.ok(rendered.includes("during rollback:"));
	assert.ok(rendered.includes("StoragePayloadTooLargeError (payload-too-large)"));
});

test("mark-led failure text stays within terminal width across summary, log and TUI overlay rendering (#5234)", () => {
	for (const width of [40, 80, 120]) {
		const room = width - 2;
		const fill = (budget: number) =>
			`\u0e48\u093F ${"中".repeat(Math.floor((budget - 2) / 2))}${"a".repeat(
				Math.max(0, budget - 1 - 2 * Math.floor((budget - 2) / 2)),
			)}`;
		const logStage: StageSnapshot = {
			...makeStage("verify"),
			status: "failed",
			startedAt: 1,
			endedAt: 2,
			error: `first line\n${fill(room)}\n中${"\u0903".repeat(room - 1)}`,
			failureMessage: `first line\n${fill(room)}\n中${"\u0903".repeat(room - 1)}`,
		};
		const reasonRoom = Math.max(1, room - 9);
		const summaryStage: StageSnapshot = {
			...makeStage("verify"),
			status: "failed",
			startedAt: 1,
			endedAt: 2,
			error: fill(reasonRoom),
			failureMessage: fill(reasonRoom),
		};
		for (const row of renderStageFailureDetailLines(summaryStage, { theme: defaultTheme, width, logs: false })) {
			assert.ok(visibleWidth(row) <= width, `summary row width ${visibleWidth(row)} > ${width}`);
		}
		for (const row of renderStageFailureDetailLines(logStage, { theme: defaultTheme, width, logs: true })) {
			assert.ok(visibleWidth(row) <= width, `log row width ${visibleWidth(row)} > ${width}`);
		}
	}

	const makeTerminal = (columns: number, rows: number): Terminal => ({
		start() {},
		stop() {},
		async drainInput() {},
		setProgress() {},
		setProgramStatus() {},
		write() {},
		get columns() {
			return columns;
		},
		get rows() {
			return rows;
		},
		get kittyProtocolActive() {
			return false;
		},
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
	});
	const emptyChild: Component = {
		render: () => [],
		invalidate() {},
	};

	for (const message of [
		`\u0e48${"\u093F".repeat(60)}`,
		"\u0301\u093F".repeat(30),
		`ok\n\u0e48${"\u093F".repeat(60)}`,
	]) {
		for (const keys of [["\r"], ["\r", "l"]]) {
			const stage: StageSnapshot = {
				...makeStage("verify"),
				status: "failed",
				startedAt: 1,
				endedAt: 2,
				error: message,
				failureMessage: message,
			};
			const view = graphFor(stage);
			const tui = new TuiMainScreen(makeTerminal(80, 40));
			tui.addChild(emptyChild);
			const overlay: Component = {
				render: (w: number) => view.render(w),
				invalidate() {},
			};
			try {
				tui.start();
				tui.showOverlay(overlay, { width: "100%", anchor: "top-left" } as never);
				(tui as unknown as { doRender(): void }).doRender();
				for (const key of keys) view.handleInput(key);
				assert.doesNotThrow(() => {
					(tui as unknown as { doRender(): void }).doRender();
				});
			} finally {
				try {
					tui.stop();
				} catch {}
				view.dispose();
			}
		}
	}
});

test("stage failure reason and logs skip leading whitespace before bounding (#5234)", () => {
	for (const prefix of ["\n".repeat(20_000), " ".repeat(20_000), "\n".repeat(16_370), "\n".repeat(16_371)]) {
		const error = `${prefix}Error: disk full\nsecond line`;
		const stage: StageSnapshot = {
			...makeStage("verify"),
			status: "failed",
			error,
			failureMessage: error,
		};
		assert.equal(stageFailureReason(stage), "Error: disk full");
		const summary = renderStageFailureDetailLines(stage, { theme: defaultTheme, width: 120, logs: false }).join("\n");
		assert.ok(summary.includes("Error: disk full"));
		assert.equal(summary.includes(TOOL_PAYLOAD_TRUNCATION_MARKER), false);
		const logs = renderStageFailureDetailLines(stage, { theme: defaultTheme, width: 120, logs: true }).join("\n");
		assert.ok(logs.includes("Error: disk full"));
	}
	assert.equal(
		stageFailureReason({ error: " ".repeat(20_000), failureMessage: "\n".repeat(20_000) }),
		"No reason was recorded.",
	);
});

test("failure logs preserve error code, hint and cause when the stage stack or root error message is huge (#5234)", () => {
	const stack = `Error: build failed\n${Array.from({ length: 2_000 }, (_, index) => `    at frame${index} (file.ts:${index}:1)`).join("\n")}`;
	const hugeStackStage: StageSnapshot = {
		...makeStage("verify"),
		status: "failed",
		error: stack,
		failureMessage: stack,
		failureDetail: {
			name: "AggregateError",
			code: "E_AGGREGATE",
			message: "two steps failed",
			hint: "rerun with --verbose",
			fields: {},
			cause: { name: "TypeError", code: "E_CAUSE", message: "root cause here", fields: {} },
		},
	};
	const hugeRootErrorStage: StageSnapshot = {
		...hugeStackStage,
		failureDetail: {
			name: "AggregateError",
			code: "E_AGGREGATE",
			message: "M".repeat(40_000),
			hint: "rerun with --verbose",
			fields: {},
			cause: { name: "TypeError", code: "E_CAUSE", message: "root cause here", fields: {} },
		},
	};
	for (const candidate of [
		hugeStackStage,
		hugeRootErrorStage,
		{
			...hugeRootErrorStage,
			failureDetail: { ...hugeRootErrorStage.failureDetail!, message: "M\n".repeat(20_000) },
		},
		{ ...hugeRootErrorStage, error: undefined, failureMessage: undefined },
	]) {
		const rawLines = stageFailureLogLines(candidate).join("\n");
		const rendered = renderStageFailureDetailLines(candidate, { theme: defaultTheme, width: 120, logs: true }).join(
			"\n",
		);
		for (const expected of ["E_AGGREGATE", "rerun with --verbose", "E_CAUSE", "root cause here"]) {
			assert.ok(rawLines.includes(expected), `stageFailureLogLines missing ${expected}`);
			assert.ok(rendered.includes(expected), `renderStageFailureDetailLines missing ${expected}`);
		}
	}
});

test("failure logs cap newline-dense rows across widths and keep truncation explicit (#5234)", () => {
	for (const dense of ["a\n".repeat(500_000), "\u0001\n".repeat(20_000)]) {
		const stage: StageSnapshot = {
			...makeStage("verify"),
			status: "failed",
			error: dense,
			failureMessage: dense,
		};
		assert.ok(stageFailureLogLines(stage).length <= 256);
		for (const width of [3, 42, 120]) {
			const rows = renderStageFailureDetailLines(stage, { theme: defaultTheme, width, logs: true });
			assert.ok(rows.length <= 260, `expected capped log rows at width ${width}, got ${rows.length}`);
			assert.ok(rows.join("\n").includes("…"), `expected truncation marker at width ${width}`);
		}
	}
	const narrowDetailStage: StageSnapshot = {
		...makeStage("verify"),
		status: "failed",
		error: "\u0001\n".repeat(20_000),
		failureMessage: "\u0001\n".repeat(20_000),
		failureDetail: {
			name: "AggregateError",
			code: "E_AGGREGATE",
			message: "two steps failed",
			hint: "rerun with --verbose",
			fields: {},
			cause: { name: "TypeError", code: "E_CAUSE", message: "root cause here", fields: {} },
		},
	};
	const narrowRows = renderStageFailureDetailLines(narrowDetailStage, {
		theme: defaultTheme,
		width: 40,
		logs: true,
	}).join("\n");
	assert.ok(narrowRows.includes(TOOL_PAYLOAD_TRUNCATION_MARKER));
	assert.ok(narrowRows.includes("E_AGGREGATE"));
	assert.ok(narrowRows.includes("root cause here"));
});

test("plain wrapping preserves combining and emoji graphemes after text (#5234)", () => {
	const combiningWord = `e${"\u0301".repeat(1_000)}`;
	const zwjCluster = "👨\u200d👩\u200d👧\u200d👦";
	assert.deepEqual(wrapPlainText(`head ${combiningWord} ${zwjCluster}`, 20), [`head ${combiningWord} ${zwjCluster}`]);
});

test.each([
	["OSC 52", "osc\u001b]52;c;Yg==\u0007\rname"],
	["C1 CSI", "c1\u009b2J\nname"],
])(
	"%s sequences in run names, pending stages, run metadata, input keys and tool events stay escaped (#5234)",
	(_label, payload) => {
		const activeStage: StageSnapshot = {
			...makeStage("active"),
			name: `active-${payload}`,
			status: "running",
			startedAt: 1,
			toolEvents: [{ name: `tool-${payload}`, startedAt: 1 }],
		};
		const pendingStage: StageSnapshot = {
			...makeStage("pending-stage", ["active"]),
			name: `pending-${payload}`,
			status: "pending",
			pendingStageDeliveryAvailable: true,
		};
		const failedStage: StageSnapshot = {
			...makeStage("failed-stage", ["active"]),
			name: `failed-${payload}`,
			status: "failed",
			error: `stage-err-${payload}`,
		};
		const baseSnap = makeSnap([activeStage, pendingStage, failedStage]);
		const run = {
			...baseSnap.runs[0]!,
			name: `run-${payload}`,
			inputs: { [`input-${payload}`]: "value" },
			error: `run-err-${payload}\nsecond-line`,
			exitReason: `exit-${payload}`,
			exited: true,
		};
		const snap = { ...baseSnap, runs: [run] };

		const store = makeStore(snap);
		const detail = inspectRun("run-1", { store, now: 2_000 });
		assert.ok(detail.ok);
		const richDetail = {
			...detail.detail,
			exitReason: `exit-${payload}`,
			error: `run-err-${payload}\nsecond-line`,
			resumeGuidance: `guidance-${payload}`,
		};

		for (const theme of [undefined, defaultTheme]) {
			const detailRows = renderRunDetail(richDetail, { theme, width: 160, now: 2_000 }).split("\n");
			assertSafeRows(detailRows);
			const detailText = detailRows.join("\n");
			assert.ok(detailText.includes("run-"), "run name is rendered");
			assert.ok(detailText.includes("exit-"), "exitReason is rendered");
			assert.ok(detailText.includes("run-err-"), "run error is rendered");
			assert.ok(detailText.includes("guidance-"), "resumeGuidance is rendered");
			assert.ok(detailText.includes("input-"), "input key is rendered");
			assert.ok(detailText.includes("tool-"), "last tool event name is rendered");
		}

		for (const theme of ["dark", "light"] as const) {
			initTheme(theme);
			const panelRows = renderAgentPanelRows(panelItemsFromSnapshot(snap.runs, 2_000), 200, themedAgentPanelStyle());
			assertSafeRows(panelRows);
			assert.ok(panelRows.join("\n").includes("active-"), "panel current stage name is rendered");
		}

		for (const status of ["running", "failed", "paused", "completed"] as const) {
			const statusRun = { ...run, status };
			for (const theme of [undefined, defaultTheme]) {
				const listRows = renderStatusList([statusRun], { theme, width: 160, now: 2_000 }).split("\n");
				assertSafeRows(listRows);
			}
		}
	},
);
