import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { bindOwnerTaskStore } from "@bastani/atomic";
import { stripTerminalSequences } from "@bastani/atomic-tui";
import { test, vi } from "vitest";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import { FooterDataProvider } from "../../packages/coding-agent/src/core/footer-data-provider.js";
import { FooterComponent } from "../../packages/coding-agent/src/modes/interactive/components/footer.js";
import {
	AGENT_PANEL_REFRESH_WINDOW_MS,
	bindAgentPanel,
} from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import {
	createProductionFullscreenContext,
	getLayoutFrame,
} from "../../packages/coding-agent/test/helpers/interactive-fullscreen-layout.js";
import { fakeFooterAgentSession } from "../helpers/footer-session.js";
import { taskFixture } from "../helpers/task-projection.js";

test("the engine lists its active tasks below MCP and drops them once they finish (#5224, #5723)", async () => {
	const tasks = taskFixture();
	const emptyTasks = taskFixture();
	const session = fakeFooterAgentSession();
	bindOwnerTaskStore(session, tasks.store);
	const footerData = new FooterDataProvider(tmpdir());
	footerData.setExtensionStatus("mcp", "MCP  1 server · 3 tools");
	const main = createProductionFullscreenContext({ rows: 40, columns: 100 });
	let panelAgents = 0;
	let removeTasks = () => {};
	if (main) {
		main.context.footerContainer.clear();
		main.context.footerContainer.addChild(new FooterComponent(fakeFooterAgentSession(), footerData));
		removeTasks = bindAgentPanel(
			session,
			{
				setWidget: main.context.setExtensionWidget.bind(main.context),
				requestRender: () => main.tui.requestRender(),
			} as ExtensionUIContext,
			(counts) => {
				panelAgents = counts.total;
			},
		);
	}
	const render = () => {
		assert.ok(main);
		main.tui.renderNow();
		return stripTerminalSequences(getLayoutFrame(main.tui).lines.join("\n"));
	};
	const taskRows = (screen: string) => screen.split("\n").filter((row) => /^ {3}[◯●✗] worker /.test(row));
	const assertOrder = async (expected: readonly RegExp[]) => {
		// A store drain can finish one refresh window before the engine panel publishes its new rows.
		if (main)
			await vi.waitFor(() => assert.equal(panelAgents, expected.length), {
				interval: AGENT_PANEL_REFRESH_WINDOW_MS,
				timeout: 3 * AGENT_PANEL_REFRESH_WINDOW_MS,
			});
		const screen = render();
		const rows = screen.split("\n");
		const mcp = rows.findIndex((row) => row.includes("MCP "));
		const shown = taskRows(screen);
		assert.ok(mcp >= 0, screen);
		assert.equal(shown.length, expected.length, screen);
		for (const [index, row] of shown.entries()) assert.match(row, expected[index]!);
		if (shown.length > 0) assert.ok(rows.indexOf(shown[0]!) > mcp, `Task rows must follow MCP:\n${screen}`);
	};
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.match(render(), /MCP /);
		assert.deepEqual(taskRows(render()), []);
		await tasks.start("will fail");
		await tasks.start("keeps running");
		await assertOrder([/keeps running/, /will fail/]);
		tasks.runners[0].result.resolve({ kind: "failed", code: "fixture", message: "Retained failure" });
		await vi.waitFor(() => {
			tasks.store.drain();
			assert.equal(tasks.store.tasks[0]?.execution.kind, "settled");
		});
		// A finished subagent leaves the main panel and a stage chat's task list at once.
		await assertOrder([/keeps running/]);
		await tasks.settle(1);
		await assertOrder([]);
		assert.equal(tasks.store.backgroundTasks.length, 2, "terminal history remains inspectable");
		bindOwnerTaskStore(session, emptyTasks.store);
		await assertOrder([]);
	} finally {
		removeTasks();
		if (main) {
			main.resolveTheme();
			await main.initPromise;
			main.tui.stop();
			main.restoreOffline();
		}
		footerData.dispose();
		await tasks.dispose();
		await emptyTasks.dispose();
	}
});
