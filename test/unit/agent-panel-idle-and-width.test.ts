import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@bastani/atomic-tui";
import { afterEach, test, vi } from "vitest";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
	openAgentPanelItem,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import {
	type AgentPanelRow,
	type AgentPanelStyle,
	renderAgentPanelRows,
} from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import {
	type AgentPanelCounts,
	agentPanelCounts,
	bindAgentPanel,
	setAgentPanelVisible,
} from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";

const plain: AgentPanelStyle = {
	dim: (text) => text,
	text: (text) => text,
	muted: (text) => text,
	border: (text) => text,
	bold: (text) => text,
	accent: (text) => text,
	success: (text) => text,
	error: (text) => text,
	warning: (text) => text,
};

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test("between 40 and 56 columns a row keeps its state word whole instead of clipping the right column (#5239)", () => {
	const row: AgentPanelRow = {
		id: "task:debugger",
		kind: "agent",
		state: "input",
		name: "debugger",
		task: "Which approach should the fix take for the spawn lock?",
		elapsedMs: 5_460_000,
	};
	for (let width = 40; width <= 56; width++) {
		const [line] = renderAgentPanelRows([row], width, plain).map((text) => stripVTControlCharacters(text));
		assert.ok(line !== undefined);
		assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
		assert.match(line, /needs input( · 1h 31m)?$/, `${width}: the right column ends whole: ${JSON.stringify(line)}`);
	}
});

test("bindAgentPanel reports cap-independent total and needsInput counts, deduplicates unchanged ticks, contains callback throws, preserves counts while hidden, and resets on empty or dispose (#5239)", () => {
	initTheme("dark");
	const hub = new AgentPanelSourceHub();
	let items: AgentPanelItem[] = Array.from({ length: 10 }, (_, index) => ({
		id: `ext:item-${index}`,
		kind: "agent" as const,
		state: index < 3 ? ("input" as const) : ("running" as const),
		name: `worker-${index}`,
		task: `task-${index}`,
		...(index < 3 ? { question: `Question ${index}?` } : {}),
		elapsedMs: 5_000,
	}));
	let notifySource = () => {};
	hub.register({
		items: () => items,
		subscribe: (listener) => {
			notifySource = listener;
			return () => {};
		},
		open: () => true,
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	const recorded: AgentPanelCounts[] = [];
	let shouldThrow = true;
	const dispose = bindAgentPanel(
		session,
		{
			setWidget() {},
			requestRender() {},
		} as never,
		(counts) => {
			recorded.push(counts);
			if (shouldThrow) {
				shouldThrow = false;
				throw new Error("host callback boom");
			}
		},
	);
	try {
		assert.deepEqual(recorded, [{ total: 10, agents: 10, needsInput: 3, shells: 0, subagents: 0 }]);
		assert.deepEqual(agentPanelCounts(session), { total: 10, agents: 10, needsInput: 3, shells: 0, subagents: 0 });

		openAgentPanelItem(session, "ext:item-0");
		assert.deepEqual(agentPanelCounts(session), { total: 10, agents: 10, needsInput: 3, shells: 0, subagents: 0 });

		notifySource();
		assert.equal(recorded.length, 1, "unchanged counts are not re-emitted");

		setAgentPanelVisible(session, false);
		assert.equal(recorded.length, 1, "hiding the panel keeps the published counts");
		setAgentPanelVisible(session, true);
		assert.equal(recorded.length, 1, "showing the panel with unchanged counts does not re-emit");

		items = [];
		notifySource();
	} finally {
		dispose();
	}
	assert.deepEqual(recorded.at(-1), { total: 0, agents: 0, needsInput: 0, shells: 0, subagents: 0 });
});
