import assert from "node:assert/strict";
import { test } from "vitest";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import type { PiOverlayHandle } from "../../packages/workflows/src/extension/wiring.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { buildGraphOverlayAdapter } from "../../packages/workflows/src/tui/overlay-adapter.js";

test("opening a hidden overlay directly to a registered stage attaches its chat immediately", () => {
	initTheme("dark");
	const store = createStore();
	store.recordRunStart({
		id: "run",
		name: "workflow",
		inputs: {},
		status: "running",
		startedAt: 1,
		toolNodes: [],
		stages: [{ id: "stage", name: "Stage", status: "running", parentIds: [], toolEvents: [] }],
	});
	const registry = createStageControlRegistry();
	registry.register({
		runId: "run",
		stageId: "stage",
		stageName: "Stage",
		status: "running",
		sessionId: undefined,
		sessionFile: undefined,
		isStreaming: false,
		messages: [],
		ensureAttached: async () => {},
		prompt: async () => {},
		steer: async () => {},
		followUp: async () => {},
		pause: async () => {},
		resume: async () => {},
		subscribe: () => () => {},
	});
	let hidden = false;
	const handle: PiOverlayHandle = {
		hide: () => {
			hidden = true;
		},
		setHidden: (value) => {
			hidden = value;
		},
		isHidden: () => hidden,
		focus: () => {},
		unfocus: () => {},
		isFocused: () => !hidden,
	};
	const adapter = buildGraphOverlayAdapter(
		{
			ui: {
				custom: (factory, options) => {
					options.onHandle?.(handle);
					factory({ requestRender: () => {}, terminal: { rows: 24, columns: 80 } }, {}, {}, () => {});
					return undefined;
				},
			},
		},
		store,
		{ stageControlRegistry: registry, terminalOutput: { platform: "linux", isTTY: false, write: () => {} } },
	);
	try {
		adapter.open("run");
		adapter.toggle("run");
		assert.equal(hidden, true);
		adapter.open("run", undefined, "stage");
		assert.equal(hidden, false);
		assert.equal(
			store.runs()[0].stages[0].attached,
			true,
			"the requested chat must open without selecting the stage again",
		);
	} finally {
		adapter.close();
	}
});
