/**
 * Workflow store changes keep an attached stage chat's rendered transcript.
 *
 * Every running stage changes the workflow store as it works. The overlay used to invalidate its whole view on each
 * change, and for an attached stage chat that dropped every rendered transcript entry, so a stage chat over a long
 * transcript rendered all of it again for every change any stage made. The overlay is driven here through its real
 * store subscription and frame pacing, and the attached chat's entries are counted as they render.
 */

import assert from "node:assert/strict";
import type { AgentSession } from "@bastani/atomic";
import { afterEach, test, vi } from "vitest";
import { AssistantMessageComponent } from "../../packages/coding-agent/src/modes/interactive/components/assistant-message.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import type { PiCustomComponent, PiOverlayHandle } from "../../packages/workflows/src/extension/wiring.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { buildGraphOverlayAdapter } from "../../packages/workflows/src/tui/overlay-adapter.js";
import { sleep } from "../helpers/runtime.js";

/** Long enough that rendering it per store change would dominate a frame. */
const TRANSCRIPT_MESSAGES = 2_000;
/** Store changes from the other stages while the chat is attached. */
const STORE_CHANGES = 20;
/** The overlay paces store-driven frames at 16 ms; this outlasts one pacing interval under load. */
const FRAME_SETTLE_MS = 40;

const assistant = (index: number) => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text: `message ${index}` }],
	api: "openai-completions",
	provider: "test",
	model: "test",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop" as const,
	timestamp: index,
});

afterEach(() => {
	vi.restoreAllMocks();
});

test("store changes from other stages render none of an attached stage chat's transcript again", async () => {
	initTheme("dark");
	const store = createStore();
	store.recordRunStart({
		id: "run",
		name: "workflow",
		inputs: {},
		status: "running",
		startedAt: 1,
		toolNodes: [],
		stages: [
			{ id: "attached", name: "Attached", status: "running", parentIds: [], toolEvents: [] },
			{ id: "busy", name: "Busy", status: "running", parentIds: [], toolEvents: [] },
		],
	});
	const registry = createStageControlRegistry();
	registry.register({
		runId: "run",
		stageId: "attached",
		stageName: "Attached",
		status: "running",
		sessionId: undefined,
		sessionFile: undefined,
		isStreaming: false,
		messages: Array.from({ length: TRANSCRIPT_MESSAGES }, (_, index) =>
			assistant(index),
		) as unknown as AgentSession["messages"],
		ensureAttached: async () => {},
		prompt: async () => {},
		steer: async () => {},
		followUp: async () => {},
		pause: async () => {},
		resume: async () => {},
		subscribe: () => () => {},
	});
	const handle: PiOverlayHandle = {
		hide: () => {},
		setHidden: () => {},
		isHidden: () => false,
		focus: () => {},
		unfocus: () => {},
		isFocused: () => true,
	};
	let component: PiCustomComponent | undefined;
	let frames = 0;
	const adapter = buildGraphOverlayAdapter(
		{
			ui: {
				custom: (factory, options) => {
					options.onHandle?.(handle);
					// The overlay's factory builds its component synchronously.
					component = factory(
						{
							requestRender: () => {
								frames += 1;
								component?.render(120);
							},
							terminal: { rows: 40, columns: 120 },
						},
						{},
						{},
						() => {},
					) as PiCustomComponent;
					return undefined;
				},
			},
		},
		store,
		{ stageControlRegistry: registry, terminalOutput: { platform: "linux", isTTY: false, write: () => {} } },
	);
	try {
		adapter.open("run", undefined, "attached");
		assert.ok(component, "the overlay did not mount");
		const renders = vi.spyOn(AssistantMessageComponent.prototype, "render");
		component.render(120);
		assert.equal(renders.mock.calls.length, TRANSCRIPT_MESSAGES, "the first frame renders the whole transcript");

		renders.mockClear();
		frames = 0;
		for (let change = 0; change < STORE_CHANGES; change++) {
			store.recordStageNotice("run", "busy", {
				id: `notice-${change}`,
				ts: change,
				kind: "cleanup",
				to: "quarantined",
				meta: "busy",
			});
			await sleep(FRAME_SETTLE_MS / 4);
		}
		await sleep(FRAME_SETTLE_MS);
		assert.ok(frames > 0, "store changes still paint the overlay");
		assert.equal(renders.mock.calls.length, 0, "no transcript entry renders again for another stage's change");
	} finally {
		adapter.close();
	}
});
