import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { inspectRun } from "../../packages/workflows/src/runs/background/run-inspect.js";
import type { StageSnapshot, ToolNodeSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import * as toolPayloadBounds from "../../packages/workflows/src/shared/tool-payload-bounds.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import type { GraphViewOpts } from "../../packages/workflows/src/tui/graph-view-types.js";
import { renderNodeCard } from "../../packages/workflows/src/tui/node-card.js";
import { renderRunDetail } from "../../packages/workflows/src/tui/run-detail.js";
import { renderToolDetail } from "../../packages/workflows/src/tui/tool-detail.js";
import { renderWidgetLines } from "../../packages/workflows/src/tui/widget.js";
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

test.each(["card", "detail", "widget"])(
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
			assertSafeRows(
				renderWidgetLines(
					{ ...snap, runs: [{ ...snap.runs[0]!, toolNodes: [{ ...node, status: "running" }] }] },
					200,
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
