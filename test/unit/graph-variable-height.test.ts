import assert from "node:assert/strict";
import { test } from "vitest";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { computeLayout, NODE_H } from "../../packages/workflows/src/tui/layout.js";
import { defaultTheme, makeSnap, makeStage, makeStore, visibleText } from "./overlay-graph-helpers.js";

test("variable-height layout spaces vertical tiers by the tallest sibling and stacks horizontal siblings", () => {
	const stages = [makeStage("short"), makeStage("tall"), makeStage("next", ["short", "tall"])];
	const nodeHeight = (stage: (typeof stages)[number]) => (stage.id === "tall" ? 7 : NODE_H);
	const vertical = computeLayout(stages, { orientation: "vertical", nodeHeight });
	assert.deepEqual(
		vertical.map(({ y, height }) => [y, height]),
		[
			[0, 5],
			[0, 7],
			[10, 5],
		],
	);
	const horizontal = computeLayout([stages[1]!, stages[0]!, stages[2]!], { nodeHeight });
	assert.deepEqual(
		horizontal.map(({ y, height }) => [y, height]),
		[
			[0, 7],
			[10, 5],
			[0, 5],
		],
	);
});

test("graph reflows model-card queues without a snapshot change and updates downstream click targets", () => {
	const model = makeStage("model");
	model.model = "gpt-5-mini";
	model.attachable = true;
	const next = makeStage("next", ["model"]);
	next.attachable = true;
	let queued = 0;
	const attached: string[] = [];
	const view = new GraphView({
		mode: "overlay",
		runId: "run-1",
		store: makeStore(makeSnap([model, next])),
		graphTheme: defaultTheme,
		getStageQueuedMessageCount: (_runId, stageId) => (stageId === "model" ? queued : 0),
		onStageAttach: (_runId, stageId) => {
			attached.push(stageId);
		},
	});
	try {
		const initial = visibleText(view.render(96)).split("\n");
		const initialNext = initial.findIndex((line) => /╭.*next.*╮/.test(line));
		queued = 1_000_000;
		const grown = visibleText(view.render(96)).split("\n");
		const badge = grown.find((line) => line.includes("✉ 1000000"))!;
		assert.match(badge, /│\s*✉ 1000000 queued\s*│/);
		assert.doesNotMatch(badge, /pending/);
		assert.match(grown.join("\n"), /gpt-5-mini/);
		const grownNext = grown.findIndex((line) => /╭.*next.*╮/.test(line));
		assert.equal(grownNext, initialNext + 1);
		const modelTop = grown.findIndex((line) => /╭.*model.*╮/.test(line));
		const modelBottom = modelTop + 5;
		assert.match(grown[modelBottom]!, /╰─+╯/);
		assert.deepEqual(
			grown.slice(modelBottom + 1, grownNext).map((line) => line.trim()),
			["│", "│", "│"],
		);
		const modelColumn = grown[modelBottom]!.indexOf("╰") + 2;
		view.handleInput(`\x1b[<0;${modelColumn};${modelBottom + 1}M`);
		const column = grown[grownNext]!.indexOf("╭") + 2;
		view.handleInput(`\x1b[<0;${column};${grownNext + 1}M`);
		assert.deepEqual(attached, ["model", "next"]);
		queued = 0;
		view.invalidate();
		const shrunk = visibleText(view.render(96)).split("\n");
		assert.equal(
			shrunk.findIndex((line) => /╭.*next.*╮/.test(line)),
			initialNext,
		);
		assert.doesNotMatch(shrunk.join("\n"), /✉/);
	} finally {
		view.dispose();
	}
});

test("queued child cards grow to preserve their full UUID, status and separate badge", () => {
	const child = makeStage("child");
	const runId = "339e05a4-2289-408e-9076-d1a348f582ae";
	child.workflowChildRun = { alias: "child", workflow: "verify", runId };
	child.status = "running";
	const view = new GraphView({
		mode: "overlay",
		runId: "run-1",
		store: makeStore(makeSnap([child])),
		graphTheme: defaultTheme,
		getStageQueuedMessageCount: () => 1_000_000,
	});
	try {
		const lines = visibleText(view.render(96)).split("\n");
		const top = lines.findIndex((line) => /╭.*verify.*╮/.test(line));
		assert.ok(top >= 0);
		const card = lines.slice(top, top + 6);
		assert.match(card[5]!, /╰─+╯/);
		assert.match(card[4]!, /│\s*✉ 1000000 queued\s*│/);
		assert.match(card[3]!, /running/);
		const identity = card
			.slice(1, 3)
			.map((line) => line.replaceAll("│", "").trim())
			.join("");
		assert.equal(identity, `run ${runId}`);
	} finally {
		view.dispose();
	}
});
