import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { type AgentPanelItem, AgentPanelSourceHub } from "../src/core/tasks/agent-panel-source.ts";
import { agentViewBridge } from "../src/modes/interactive/agent-view/agent-view-bridge.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { EngineCustomUiService } from "../src/modes/interactive-engine/engine-custom-ui.js";
import type { InteractiveEngineMessage } from "../src/modes/interactive-engine/protocol.ts";
import { bindAgentPanel, hideAgentPanelFor, setAgentPanelVisible } from "../src/modes/rpc/agent-panel-bridge.js";
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

test("only the close of the view that hid the agent panel, as the panel opens again, says the panel comes back", async () => {
	initTheme("dark");
	const hub = new AgentPanelSourceHub();
	let rows: AgentPanelItem[] = [worker];
	let changed = () => {};
	hub.register({
		items: () => rows,
		subscribe: (listener) => {
			changed = listener;
			return () => {};
		},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } } as unknown as AgentSession;
	const lines: string[] = [];
	const engine = new EngineCustomUiService((line) => lines.push(line), new KeybindingsManager());
	const unbind = bindAgentPanel(session, {
		setWidget: (key: string, factory: unknown) => engine.setWidget(key, factory as never),
		requestRender() {},
	} as never);
	/** Open a view, close it with `close`, and answer the done the engine announced. */
	const closeView = async (close: (done: () => void) => void) => {
		let done!: () => void;
		const shown = engine.custom<void>((_tui, _theme, _keys, finish) => {
			done = () => finish();
			return { render: () => ["Tasks"], invalidate() {} };
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		lines.length = 0;
		close(done);
		await shown;
		return lines.map((line) => JSON.parse(line)).find((message) => message.type === "engine_custom_done");
	};
	try {
		const tasks = hideAgentPanelFor(session);
		tasks.hide();
		await Promise.resolve();
		assert.equal((await closeView((done) => tasks.show(done)))?.panel, true);
		// Any other view's close says nothing, also in the same turn.
		assert.equal((await closeView((done) => done()))?.panel, undefined);
		// With no rows left the panel does not open again: no wait.
		const empty = hideAgentPanelFor(session);
		empty.hide();
		await Promise.resolve();
		rows = [];
		changed();
		assert.equal((await closeView((done) => empty.show(done)))?.panel, undefined);
	} finally {
		unbind();
	}
});
