import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import type { PiCustomOverlayFactoryTui, PiOverlayHandle } from "../../packages/workflows/src/extension/wiring.js";
import type { Store } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { GraphOverlayPort, OverlayPiSurface } from "../../packages/workflows/src/tui/overlay-adapter.js";
import { bunExecutable } from "../helpers/runtime.js";

const ISOLATED_PROCESS_ENV = "ATOMIC_OVERLAY_HIDDEN_RENDER_ISOLATED";

async function registerIsolatedTests(): Promise<void> {
	// Only ever reached inside the `bun test` child spawned below, where
	// `bun:test`'s module registry is the real one. vitest has no equivalent.
	const { jest, mock, spyOn } = await import("bun:test");
	const { replaceControlCharacters, stripTerminalSequences } = await import("@bastani/atomic-tui/dist/utils.js");
	// Use real colour conversion for the shared input label and the graph’s status palette.
	const { colorToHex, colorToRgb, foregroundAnsi, parseColor } = await import("@bastani/atomic-tui/dist/colors.js");
	// Hint lines mark their keys for clicks with pi-tui's own hint markers.
	const clickableHints = await import("@bastani/atomic-tui/dist/clickable-hints.js");
	const { keyInputData } = await import("@bastani/atomic-tui/dist/keys.js");
	class TestComponent {}
	const [{ ScrollView }, { VStack }, { Input }] = await Promise.all([
		import("@bastani/atomic-tui/dist/components/scroll-view.js"),
		import("@bastani/atomic-tui/dist/components/v-stack.js"),
		import("@bastani/atomic-tui/dist/components/input.js"),
	]);
	mock.module("@bastani/atomic-tui", () => ({
		...clickableHints,
		keyInputData,
		colorToHex,
		colorToRgb,
		foregroundAnsi,
		parseColor,
		Box: TestComponent,
		Editor: TestComponent,
		// The stage-chat find box edits its query with pi-tui's own input.
		Input,
		getKeybindings: () => ({ matches: () => false }),
		ScrollView,
		VStack,
		SelectList: TestComponent,
		Text: TestComponent,
		Key: {
			backspace: "\x7f",
			down: "\x1b[B",
			enter: "\r",
			escape: "\x1b",
			left: "\x1b[D",
			right: "\x1b[C",
			up: "\x1b[A",
			ctrl: (key: string) => key,
		},
		decodeKittyPrintable: () => undefined,
		matchesKey: (data: string, key: string) => data === key,
		replaceControlCharacters,
		stripTerminalSequences,
		truncateToWidth: (text: string, width: number) => text.slice(0, width),
		visibleWidth: (text: string) => text.length,
		wrapTextWithAnsi: (text: string) => [text],
	}));

	// Node cards label stage models with the shared raw-ID label (#4269).
	const { formatModelLabel, MODEL_LABEL_SEPARATOR } = await import(
		"../../packages/coding-agent/src/core/model-label.js"
	);
	// The stage's input label is the shared chat-input label (#4640).
	const {
		applyAttachedComposer,
		applyInputLabelToEditorTopRule,
		buildInputLabel,
		INPUT_LABEL_MIN_COLUMNS,
		inputLabelMarker,
		ruleOpenColor,
	} = await import("../../packages/coding-agent/src/modes/interactive/components/input-label.js");
	// Pending-input labels cut long prompts with the shared surrogate-safe slice (#5097).
	const { sliceHead } = await import("../../packages/coding-agent/src/core/tools/truncate.js");

	const retryStatus = await import("../../packages/coding-agent/src/core/session-retry-status.js");
	const { AgentTokenMeter } = await import(
		"../../packages/coding-agent/src/modes/interactive/components/working-run-meter.js"
	);
	const navKeys = await import("../../packages/coding-agent/src/modes/interactive/components/nav-keys.js");
	// Stage chats hand a click on a block to the shared block-click helpers.
	const { repaintAfterSingleClick, rowsFrom } = await import(
		"../../packages/coding-agent/src/modes/interactive/components/transcript-block-clicks.js"
	);
	const { terminalDisplayText } = await import("../../packages/coding-agent/src/utils/terminal-text.ts");
	// Workflow colors come from the host's color environment; these checks paint them in true color.
	const hexColorAnsi = (hex: string, layer: "fg" | "bg") => {
		const [r, g, b] = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
		return `\x1b[${layer === "fg" ? 38 : 48};2;${r};${g};${b}m`;
	};
	mock.module("@bastani/atomic", () => ({
		...navKeys,
		...retryStatus,
		AgentTokenMeter,
		repaintAfterSingleClick,
		rowsFrom,
		sliceHead,
		terminalDisplayText,
		hexColorAnsi,
		TASK_CHAT_OVERLAY_KEYS: [],
		taskChatKeys: () => assert.fail("graph checks must not render stage-chat hints"),
		ChatSessionHost: TestComponent,
		NoticeLine: class {
			constructor() {
				assert.fail("graph overlay checks must not render stage-chat notices");
			}
		},
		formatModelLabel,
		MODEL_LABEL_SEPARATOR,
		applyAttachedComposer,
		applyInputLabelToEditorTopRule,
		buildInputLabel,
		INPUT_LABEL_MIN_COLUMNS,
		inputLabelMarker,
		ruleOpenColor,
		classifyChatCommand: () => assert.fail("graph overlay checks must not classify stage-chat commands"),
		createSessionSkillAutocompleteProvider: () =>
			assert.fail("graph overlay checks must not create skill completion"),
		TranscriptFollowIndicator: TestComponent,
		TRANSCRIPT_JUMP_TO_END_URL: "atomic-ui://transcript/jump-to-end",
		keyHint: (key: string) => key,
		sessionScopedExtensionState: (_scope: object, _key: string, create: () => object) => create(),
		keyText: (key: string) => key,
		rawKeyHint: (key: string) => key,
	}));

	const [{ buildGraphOverlayAdapter }, { createStore }] = await Promise.all([
		import("../../packages/workflows/src/tui/overlay-adapter.js"),
		import("../../packages/workflows/src/shared/store.js"),
	]);

	interface Harness {
		adapter: GraphOverlayPort;
		store: Store;
		handle: PiOverlayHandle;
		renderRequests: { count: number };
	}

	const STORE_RENDER_FRAME_MS = 16;

	function makeRun(id: string): RunSnapshot {
		return {
			id,
			name: `wf-${id}`,
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: Date.now(),
		};
	}

	function buildHarness(): Harness {
		const renderRequests: Harness["renderRequests"] = { count: 0 };
		let hidden = false;
		let focused = true;
		const handle: PiOverlayHandle = {
			hide: () => {
				hidden = true;
			},
			setHidden: (value) => {
				hidden = value;
			},
			isHidden: () => hidden,
			focus: () => {
				focused = true;
			},
			unfocus: () => {
				focused = false;
			},
			isFocused: () => focused,
		};
		const pi: OverlayPiSurface = {
			ui: {
				custom: (factory, options) => {
					assert.equal(options.purpose, "navigation", "graph inspection must not open an approval span");
					options.onHandle?.(handle);
					const tui: PiCustomOverlayFactoryTui = {
						requestRender: () => {
							renderRequests.count++;
						},
						terminal: { rows: 24, columns: 80 },
					};
					const component = factory(tui, {}, {}, () => undefined);
					if (component instanceof Promise) {
						throw new Error("overlay adapter factory should mount synchronously");
					}
					return undefined;
				},
			},
		};
		const store = createStore();
		const adapter = buildGraphOverlayAdapter(pi, store, {
			terminalOutput: {
				platform: "darwin",
				isTTY: true,
				write: () => undefined,
			},
		});
		return { adapter, store, handle, renderRequests };
	}

	describe("workflow overlay hidden render gating (#1856)", () => {
		test("visible overlay coalesces a status burst into one snapshot-free frame (#5234, #5252, #5343)", async () => {
			jest.useFakeTimers();
			try {
				const { adapter, store, renderRequests } = buildHarness();
				adapter.open(null);
				const snapshotSpies = [
					spyOn(store, "graphSnapshot"),
					spyOn(store, "snapshot"),
					spyOn(store, "inspectionSnapshot"),
				];
				const snapshotReads = () =>
					snapshotSpies.reduce((reads, snapshotSpy) => reads + snapshotSpy.mock.calls.length, 0);
				try {
					const before = renderRequests.count;
					for (let update = 0; update < 50; update++) store.recordRunStart(makeRun(`r${update}`));
					assert.equal(snapshotReads(), 0, "focused burst performs zero snapshot reads");
					assert.equal(renderRequests.count, before, "status events schedule a frame without painting inline");
					for (let elapsed = 0; elapsed < 2 * STORE_RENDER_FRAME_MS; elapsed++) {
						jest.advanceTimersByTime(1);
						for (let turn = 0; turn < 10; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
					}
					assert.equal(renderRequests.count, before + 1, "one frame paints the entire burst");
					assert.equal(snapshotReads(), 0, "the frame and its deferred work perform zero snapshot reads");
				} finally {
					for (const snapshotSpy of snapshotSpies) snapshotSpy.mockRestore();
					adapter.close();
				}
			} finally {
				jest.useRealTimers();
			}
		});

		test("hidden overlay store updates never call host requestRender", () => {
			const { adapter, store, handle, renderRequests } = buildHarness();
			adapter.open(null);
			adapter.toggle(null); // hide without unmounting
			assert.equal(handle.isHidden(), true);

			const before = renderRequests.count;
			for (let i = 0; i < 20; i++) {
				store.recordRunStart(makeRun(`r${i}`));
				store.recordRunEnd(`r${i}`, "completed");
			}

			assert.equal(renderRequests.count, before, "hidden-overlay store updates must not broadcast host renders");
		});

		test("reopening a hidden overlay repaints once from the current snapshot", () => {
			const { adapter, store, handle, renderRequests } = buildHarness();
			adapter.open(null);
			adapter.toggle(null); // hide
			store.recordRunStart(makeRun("r1"));

			const before = renderRequests.count;
			adapter.toggle(null); // show again

			assert.equal(handle.isHidden(), false);
			assert.ok(
				renderRequests.count > before,
				"the hidden→visible flip must explicitly repaint the invalidated view",
			);
		});

		test("open() on a hidden mounted overlay also repaints explicitly", () => {
			const { adapter, store, handle, renderRequests } = buildHarness();
			adapter.open(null);
			adapter.toggle(null); // hide
			store.recordRunStart(makeRun("r1"));

			const before = renderRequests.count;
			adapter.open(null);

			assert.equal(handle.isHidden(), false);
			assert.ok(renderRequests.count > before, "open() reopening a hidden overlay must explicitly repaint");
		});
	});
}

if (process.env[ISOLATED_PROCESS_ENV] === "1") {
	await registerIsolatedTests();
} else {
	test("runs hidden-overlay render gating checks without leaking module mocks", () => {
		const testPath = fileURLToPath(import.meta.url);
		const result = spawnSync(bunExecutable(), ["test", testPath], {
			cwd: process.cwd(),
			env: { ...process.env, [ISOLATED_PROCESS_ENV]: "1" },
			encoding: "utf8",
			timeout: 10_000,
		});

		assert.equal(result.status, 0, result.stderr || result.stdout);
	});
}
