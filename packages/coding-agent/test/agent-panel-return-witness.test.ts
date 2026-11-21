import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { type AgentPanelItem, AgentPanelSourceHub } from "../src/core/tasks/agent-panel-source.ts";
import { agentViewBridge } from "../src/modes/interactive/agent-view/agent-view-bridge.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import type { InteractiveEngineMessage } from "../src/modes/interactive-engine/protocol.ts";
import { bindAgentPanel, setAgentPanelVisible } from "../src/modes/rpc/agent-panel-bridge.ts";
import { installEngineAgentViewBridge } from "../src/modes/rpc/agent-view-rpc-panel.ts";

/**
 * The engine's request to show a subagent tells the host whether the agent panel opens again as the view that asked
 * (`/tasks`) closes: only then does the host wait for the panel's first frame.
 */

const worker: AgentPanelItem = {
	id: "run:worker",
	kind: "agent",
	state: "running",
	name: "worker",
	task: "investigate",
};

function engineSession(rows: AgentPanelItem[]) {
	initTheme("dark");
	const hub = new AgentPanelSourceHub();
	hub.register({ items: () => rows, subscribe: () => () => {} });
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } } as unknown as AgentSession;
	const sent: InteractiveEngineMessage[] = [];
	const detach = installEngineAgentViewBridge({ session, send: (message) => sent.push(message) } as never);
	const unbind = bindAgentPanel(session, { setWidget() {}, requestRender() {} } as never);
	const request = (options?: { keepScreen?: boolean }) => {
		sent.length = 0;
		agentViewBridge(session)?.requestView("task-1" as never, options);
		const [message] = sent;
		return message?.type === "engine_view_agent" ? message : undefined;
	};
	return {
		session,
		request,
		dispose: () => {
			unbind();
			detach();
		},
	};
}

test("a request from the one view that hid a panel with rows says the panel comes back (#6123)", () => {
	const engine = engineSession([worker]);
	try {
		setAgentPanelVisible(engine.session, false);
		assert.deepEqual(engine.request({ keepScreen: true }), {
			type: "engine_view_agent",
			taskId: "task-1",
			keepScreen: true,
			panel: true,
		});
		setAgentPanelVisible(engine.session, true);
	} finally {
		engine.dispose();
	}
});

test("a request says nothing of the panel when another view still hides it, it has no rows, or the screen is not kept (#6123)", () => {
	const engine = engineSession([worker]);
	try {
		setAgentPanelVisible(engine.session, false);
		assert.equal(engine.request()?.panel, undefined, "a request that keeps no screen waits for nothing");
		setAgentPanelVisible(engine.session, false);
		assert.equal(engine.request({ keepScreen: true })?.panel, undefined, "another view keeps it hidden");
		setAgentPanelVisible(engine.session, true);
		setAgentPanelVisible(engine.session, true);
		assert.equal(engine.request({ keepScreen: true })?.panel, undefined, "nothing hides it: it is already shown");
	} finally {
		engine.dispose();
	}
	const empty = engineSession([]);
	try {
		setAgentPanelVisible(empty.session, false);
		assert.deepEqual(empty.request({ keepScreen: true }), {
			type: "engine_view_agent",
			taskId: "task-1",
			keepScreen: true,
		});
		setAgentPanelVisible(empty.session, true);
	} finally {
		empty.dispose();
	}
});
