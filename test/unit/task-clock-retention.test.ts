import assert from "node:assert/strict";
import { test } from "vitest";
import { spawnSyncCollect } from "../helpers/runtime.js";

test("shared task clocks keep live owners and pooled sources across GC but release after eviction (#5224)", () => {
	const clocksUrl = new URL("../../packages/coding-agent/src/core/tasks/live-elapsed.ts", import.meta.url).href;
	const inspectorUrl = new URL(
		"../../packages/coding-agent/src/modes/interactive/components/task-inspector.ts",
		import.meta.url,
	).href;
	const themeUrl = new URL("../../packages/coding-agent/src/modes/interactive/theme/theme.ts", import.meta.url).href;
	const recordUrl = new URL("../helpers/task-record.ts", import.meta.url).href;
	const script = `
		import assert from "node:assert/strict";
		import { stripVTControlCharacters } from "node:util";
		import { createJiti } from "jiti";
		const jiti = createJiti(import.meta.url, { tryNative: false });
		const clocks = await jiti.import(${JSON.stringify(clocksUrl)});
		const { TaskInspector } = await jiti.import(${JSON.stringify(inspectorUrl)});
		const { initTheme } = await jiti.import(${JSON.stringify(themeUrl)});
		const { taskRecord } = await jiti.import(${JSON.stringify(recordUrl)});
		initTheme("dark");
		async function collect() {
			for (let index = 0; index < 8; index++) {
				await new Promise(setImmediate);
				global.gc();
			}
			await new Promise(setImmediate);
		}
		clocks.liveElapsedMs("released", 0, true, 0);
		await collect();
		assert.equal(clocks.liveElapsedMs("released", undefined, false, 1000), undefined);
		const owner = new clocks.TaskElapsedClocks();
		owner.elapsedMs("retained", 0, true, 0);
		await collect();
		assert.equal(owner.elapsedMs("retained", 0, true, 1000), 1000);
		owner.clear();
		await collect();
		assert.equal(owner.elapsedMs("retained", undefined, false, 2000), undefined);

		let now = 100_000;
		Date.now = () => now;
		const listeners = new Set();
		let currentTasks = [
			{ ...taskRecord("pooled-agent"), title: "Pooled agent", metrics: { elapsedMs: 1000 } },
			{ ...taskRecord("pooled-shell", "command"), title: "Pooled shell", metrics: undefined },
		];
		const pooledSource = {
			get tasks() { return currentTasks; },
			get backgroundTasks() { return currentTasks; },
			settlementOrder: new Map(),
			recentActivity: () => [],
			activityOmitted: () => false,
			subscribe(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			cancelTask: async () => ({ ok: false, error: { message: "no" } }),
			stdinAvailable: () => false,
			writeTaskInput: async () => ({ ok: false, error: { message: "no" } }),
			readTaskOutput: async () => ({ ok: false, error: { message: "no" } }),
			taskDetailText: () => ({}),
			readTaskTranscript: () => ({ ok: false, error: { message: "no" } }),
			followTaskTranscript: () => undefined,
			extensionStatuses: () => new Map(),
			watchExtensionStatuses: () => () => {},
		};
		let inspector = new TaskInspector(pooledSource, () => {}, () => {});
		stripVTControlCharacters(inspector.renderViewport(100, 24).join("\\n"));
		now += 60_000;
		const beforeClose = stripVTControlCharacters(inspector.renderViewport(100, 24).join("\\n"));
		assert.match(beforeClose, /Pooled agent.* 1m/);
		assert.match(beforeClose, /Pooled shell.* 1m/);
		inspector.dispose();
		inspector = undefined;
		await collect();
		let reopened = new TaskInspector(pooledSource, () => {}, () => {});
		const afterGc = stripVTControlCharacters(reopened.renderViewport(100, 24).join("\\n"));
		assert.match(afterGc, /Pooled agent.* 1m/);
		assert.match(afterGc, /Pooled shell.* 1m/);
		reopened.dispose();
		reopened = undefined;
		currentTasks = [];
		for (const listener of [...listeners]) listener();
		await collect();
		assert.equal(clocks.taskClocksFor(pooledSource).elapsedMs("pooled-agent", undefined, false, now), undefined);
		assert.equal(clocks.taskClocksFor(pooledSource).elapsedMs("pooled-shell", undefined, false, now), undefined);
	`;
	const result = spawnSyncCollect([process.execPath, "--expose-gc", "--input-type=module", "-e", script]);
	assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
});
