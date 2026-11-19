import assert from "node:assert/strict";
import { test } from "vitest";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
	type AgentPanelState,
	agentPanelItemReadAt,
	agentPanelItems,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";

const row: AgentPanelItem = { id: "run:healthy", kind: "agent", state: "running", name: "job", task: "implement" };

function fixture(items: () => readonly AgentPanelItem[]) {
	const hub = new AgentPanelSourceHub();
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	hub.register({ items, subscribe: () => () => {} });
	return { hub, session };
}

test("a row with 129 valid string choices is hidden rather than truncated (#5239)", () => {
	const { hub, session } = fixture(() => [
		row,
		{ ...row, id: "run:oversized", choices: Array.from({ length: 129 }, (_, index) => `choice ${index}`) },
		{ ...row, id: "run:boundary", choices: Array.from({ length: 128 }, (_, index) => `choice ${index}`) },
	]);
	try {
		const warnings: string[] = [];
		for (let read = 0; read < 2; read++) {
			const rows = agentPanelItems(session, (error) => warnings.push(error.message));
			assert.deepEqual(
				rows.map((item) => item.id),
				[row.id, "run:boundary"],
			);
			assert.equal(rows[1]?.choices?.length, 128);
		}
		assert.equal(warnings.length, 1);
	} finally {
		hub.dispose();
	}
});

test("an endless source iterable is capped at 10000 rows, reported once and closed (#5239)", () => {
	let yielded = 0;
	let closed = 0;
	const { hub, session } = fixture((() => ({
		*[Symbol.iterator]() {
			try {
				while (true) {
					if (yielded >= 20_000) throw new Error("source iteration was not bounded");
					yield { ...row, id: `run:${yielded++}` };
				}
			} finally {
				closed++;
			}
		},
	})) as unknown as () => readonly AgentPanelItem[]);
	try {
		const warnings: string[] = [];
		for (let read = 0; read < 2; read++) {
			const rows = agentPanelItems(session, (error) => warnings.push(error.message));
			assert.equal(rows.length, 10_000);
			assert.equal(rows[0]?.id, "run:0");
			assert.equal(rows.at(-1)?.id, "run:9999");
		}
		assert.equal(yielded, 10_001);
		assert.equal(closed, 1);
		assert.deepEqual(warnings, ["Agent panel source exceeds 10000 items."]);
	} finally {
		hub.dispose();
	}
});

test("source sampling only retains timestamps for rows with an advancing elapsed clock (#5239)", () => {
	const states: readonly AgentPanelState[] = [
		"running",
		"input",
		"stopping",
		"queued",
		"paused",
		"done",
		"failed",
		"stopped",
	];
	const { hub, session } = fixture(() =>
		states.flatMap((state) => [
			{ ...row, id: `run:${state}:timed`, state, elapsedMs: 1000 },
			{ ...row, id: `run:${state}:untimed`, state },
		]),
	);
	try {
		for (const item of agentPanelItems(session)) {
			const advancing = item.elapsedMs !== undefined && ["running", "input", "stopping"].includes(item.state);
			assert.equal(typeof agentPanelItemReadAt(item), advancing ? "number" : "undefined", item.id);
		}
	} finally {
		hub.dispose();
	}
});
