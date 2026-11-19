import assert from "node:assert/strict";
import { test } from "vitest";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
	agentPanelExtensionItems,
	openAgentPanelItem,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";

const item: AgentPanelItem = { id: "run:release", kind: "agent", state: "running", name: "release", task: "Build" };

test("an emitted source removal cannot route an open through an old cached item (#5224)", () => {
	const hub = new AgentPanelSourceHub();
	let rows: AgentPanelItem[] = [item];
	let changed = () => {};
	const opened: string[] = [];
	hub.register({
		items: () => rows,
		subscribe(listener) {
			changed = listener;
			return () => {};
		},
		open(id) {
			opened.push(id);
			return true;
		},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	try {
		assert.equal(agentPanelExtensionItems(session).length, 1);
		rows = [];
		changed();
		assert.equal(openAgentPanelItem(session, item.id), false);
		assert.deepEqual(opened, []);
	} finally {
		hub.dispose();
	}
});

test("source registration calls the subscription without inspecting unrelated function metadata (#5224)", () => {
	const hub = new AgentPanelSourceHub();
	const subscribe = new Proxy((_listener: () => void) => () => {}, {
		get(target, property, receiver) {
			if (property === "length") throw new Error("Function metadata is not the subscription contract");
			return Reflect.get(target, property, receiver);
		},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	try {
		hub.register({ items: () => [item], subscribe });
		assert.deepEqual(
			agentPanelExtensionItems(session).map((row) => row.id),
			[item.id],
		);
	} finally {
		hub.dispose();
	}
});
