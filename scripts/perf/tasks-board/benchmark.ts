import assert from "node:assert/strict";
import { getKeybindings, setKeybindings, TuiMainScreen } from "@bastani/atomic-tui";
import { KeybindingsManager } from "../../../packages/coding-agent/src/core/keybindings.js";
import type { AgentPanelItem } from "../../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { ownerTaskViewSource } from "../../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { TaskInspector } from "../../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme } from "../../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { VirtualTerminal } from "../../../packages/tui/test/virtual-terminal.js";
import { taskFixture } from "../../../test/helpers/task-projection.js";
import { taskRecord } from "../../../test/helpers/task-record.js";

class PaintTerminal extends VirtualTerminal {
	private painted?: () => void;
	waitForPaint(): Promise<void> {
		return new Promise((resolve) => {
			this.painted = resolve;
		});
	}
	override write(data: string): void {
		super.write(data);
		if (data.includes("\x1b[?2026l")) {
			this.painted?.();
			this.painted = undefined;
		}
	}
}

function percentiles(samples: number[]) {
	const sorted = [...samples].sort((a, b) => a - b);
	const at = (fraction: number) => Number(sorted[Math.ceil(sorted.length * fraction) - 1]!.toFixed(3));
	return { p50: at(0.5), p95: at(0.95), max: at(1) };
}

const counts = (process.argv[2] ?? "100,1000,10000").split(",").map(Number);
const samples = Number(process.argv[3] ?? 40);
assert.ok(counts.every((count) => Number.isInteger(count) && count > 0));
assert.ok(Number.isInteger(samples) && samples > 0);
const previous = getKeybindings();
initTheme("dark");
setKeybindings(new KeybindingsManager());
try {
	for (const count of counts) {
		const fixture = taskFixture();
		const tasks = Array.from({ length: count }, (_, index) =>
			taskRecord(`task-${index}`, index % 2 ? "command" : "agent"),
		);
		const runs: AgentPanelItem[] = Array.from({ length: Math.ceil(count / 10) }, (_, index) => ({
			id: `run:${index}`,
			kind: "workflow",
			state: "running",
			name: `workflow-${index}`,
			task: `Task build ${index}`,
			elapsedMs: 2000,
		}));
		const terminal = new PaintTerminal(100, 24);
		const tui = new TuiMainScreen(terminal);
		const inspector = new TaskInspector(
			{ ...ownerTaskViewSource(fixture.store), tasks, backgroundTasks: tasks },
			() => tui.requestRender(),
			() => {},
		);
		inspector.setBoardSource({ items: () => runs, subscribe: () => () => {} });
		tui.addChild(inspector);
		tui.setFocus(inspector);
		const initial = terminal.waitForPaint();
		tui.start();
		await initial;
		await terminal.flush();
		try {
			for (const mode of ["navigation", "filter"] as const) {
				if (mode === "filter") {
					const paint = terminal.waitForPaint();
					terminal.sendInput("/");
					await paint;
					await terminal.flush();
				}
				const latency: number[] = [];
				for (let index = 0; index < samples + 5; index++) {
					const key = mode === "navigation" ? (index % 2 ? "\x1b[A" : "\x1b[B") : index % 2 ? "\x7f" : "t";
					const paint = terminal.waitForPaint();
					const start = performance.now();
					terminal.sendInput(key);
					await paint;
					await terminal.flush();
					if (index >= 5) latency.push(performance.now() - start);
				}
				console.log(
					JSON.stringify({ tasks: count, runs: runs.length, mode, samples, keyToPaintMs: percentiles(latency) }),
				);
			}
		} finally {
			tui.stop();
			inspector.dispose();
			await fixture.dispose();
		}
	}
} finally {
	setKeybindings(previous);
}
