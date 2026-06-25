/**
 * Overlay QA Tests - comprehensive overlay positioning and edge case tests
 *
 * Usage: atomic --extension ./examples/extensions/overlay-qa-tests.ts
 *
 * Commands:
 *   /overlay-animation  - Real-time animation demo (~30 FPS, proves DOOM-like rendering works)
 *   /overlay-anchors    - Cycle through all 9 anchor positions
 *   /overlay-margins    - Test margin and offset options
 *   /overlay-stack      - Test stacked overlays
 *   /overlay-overflow   - Test width overflow with streaming process output
 *   /overlay-edge       - Test overlay positioned at terminal edge
 *   /overlay-percent    - Test percentage-based positioning
 *   /overlay-maxheight  - Test maxHeight truncation
 *   /overlay-sidepanel  - Responsive sidepanel (hides when terminal < 100 cols)
 *   /overlay-toggle     - Toggle visibility demo (demonstrates OverlayHandle.setHidden)
 *   /overlay-passive    - Non-capturing overlay demo (passive info panel alongside active overlay)
 *   /overlay-focus      - Focus cycling, input routing, dismissal, and rendering order with overlays
 *   /overlay-streaming  - Multiple input panels with simulated streaming (Tab to cycle focus)
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@bastani/atomic";
import type { OverlayAnchor, OverlayHandle, OverlayOptions } from "@earendil-works/pi-tui";
import { sleep } from "./overlay-qa-shared.js";
import {
	AnchorTestComponent,
	EdgeTestComponent,
	MarginTestComponent,
	MaxHeightTestComponent,
	PercentTestComponent,
	SidepanelComponent,
	StackOverlayComponent,
} from "./overlay-qa-position-components.js";
import { AnimationDemoComponent, StreamingOverflowComponent } from "./overlay-qa-animation-components.js";
import { PassiveDemoController, ToggleDemoComponent } from "./overlay-qa-toggle-passive-components.js";
import { FocusDemoController } from "./overlay-qa-focus-components.js";
import { StreamingInputController } from "./overlay-qa-streaming-input-components.js";

// Global handle for toggle demo (in real code, use a more elegant pattern)
let globalToggleHandle: OverlayHandle | null = null;

export default function (pi: ExtensionAPI) {
	// Animation demo - proves overlays can handle real-time updates (like Atomic doom would need)
	pi.registerCommand("overlay-animation", {
		description: "Test real-time animation in overlay (~30 FPS)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await ctx.ui.custom<void>((tui, theme, _kb, done) => new AnimationDemoComponent(tui, theme, done), {
				overlay: true,
				overlayOptions: { anchor: "center", width: 50, maxHeight: 20 },
			});
		},
	});

	// Test all 9 anchor positions
	pi.registerCommand("overlay-anchors", {
		description: "Cycle through all anchor positions",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const anchors: OverlayAnchor[] = [
				"top-left",
				"top-center",
				"top-right",
				"left-center",
				"center",
				"right-center",
				"bottom-left",
				"bottom-center",
				"bottom-right",
			];

			let index = 0;
			while (true) {
				const result = await ctx.ui.custom<"next" | "confirm" | "cancel">(
					(_tui, theme, _kb, done) => new AnchorTestComponent(theme, anchors[index]!, done),
					{
						overlay: true,
						overlayOptions: { anchor: anchors[index], width: 40 },
					},
				);

				if (result === "next") {
					index = (index + 1) % anchors.length;
					continue;
				}
				if (result === "confirm") {
					ctx.ui.notify(`Selected: ${anchors[index]}`, "info");
				}
				break;
			}
		},
	});

	// Test margins and offsets
	pi.registerCommand("overlay-margins", {
		description: "Test margin and offset options",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const configs: { name: string; options: OverlayOptions }[] = [
				{ name: "No margin (top-left)", options: { anchor: "top-left", width: 35 } },
				{ name: "Margin: 3 all sides", options: { anchor: "top-left", width: 35, margin: 3 } },
				{
					name: "Margin: top=5, left=10",
					options: { anchor: "top-left", width: 35, margin: { top: 5, left: 10 } },
				},
				{ name: "Center + offset (10, -3)", options: { anchor: "center", width: 35, offsetX: 10, offsetY: -3 } },
				{ name: "Bottom-right, margin: 2", options: { anchor: "bottom-right", width: 35, margin: 2 } },
			];

			let index = 0;
			while (true) {
				const result = await ctx.ui.custom<"next" | "close">(
					(_tui, theme, _kb, done) => new MarginTestComponent(theme, configs[index]!, done),
					{
						overlay: true,
						overlayOptions: configs[index]!.options,
					},
				);

				if (result === "next") {
					index = (index + 1) % configs.length;
					continue;
				}
				break;
			}
		},
	});

	// Test stacked overlays
	pi.registerCommand("overlay-stack", {
		description: "Test stacked overlays",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			// Three large overlays that overlap in the center area
			// Each offset slightly so you can see the stacking

			ctx.ui.notify("Showing overlay 1 (back)...", "info");
			const p1 = ctx.ui.custom<string>(
				(_tui, theme, _kb, done) => new StackOverlayComponent(theme, 1, "back (red border)", done),
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: 50, offsetX: -8, offsetY: -4, maxHeight: 15 },
				},
			);

			await sleep(400);

			ctx.ui.notify("Showing overlay 2 (middle)...", "info");
			const p2 = ctx.ui.custom<string>(
				(_tui, theme, _kb, done) => new StackOverlayComponent(theme, 2, "middle (green border)", done),
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: 50, offsetX: 0, offsetY: 0, maxHeight: 15 },
				},
			);

			await sleep(400);

			ctx.ui.notify("Showing overlay 3 (front)...", "info");
			const p3 = ctx.ui.custom<string>(
				(_tui, theme, _kb, done) => new StackOverlayComponent(theme, 3, "front (blue border)", done),
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: 50, offsetX: 8, offsetY: 4, maxHeight: 15 },
				},
			);

			// Wait for all to close
			const results = await Promise.all([p1, p2, p3]);
			ctx.ui.notify(`Closed in order: ${results.join(", ")}`, "info");
		},
	});

	// Test width overflow scenarios (original crash case) - streams real process output
	pi.registerCommand("overlay-overflow", {
		description: "Test width overflow with streaming process output",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await ctx.ui.custom<void>((tui, theme, _kb, done) => new StreamingOverflowComponent(tui, theme, done), {
				overlay: true,
				overlayOptions: { anchor: "center", width: 90, maxHeight: 20 },
			});
		},
	});

	// Test overlay at terminal edge
	pi.registerCommand("overlay-edge", {
		description: "Test overlay positioned at terminal edge",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => new EdgeTestComponent(theme, done), {
				overlay: true,
				overlayOptions: { anchor: "right-center", width: 40, margin: { right: 0 } },
			});
		},
	});

	// Test percentage-based positioning
	pi.registerCommand("overlay-percent", {
		description: "Test percentage-based positioning",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const configs = [
				{ name: "rowPercent: 0 (top)", row: 0, col: 50 },
				{ name: "rowPercent: 50 (middle)", row: 50, col: 50 },
				{ name: "rowPercent: 100 (bottom)", row: 100, col: 50 },
				{ name: "colPercent: 0 (left)", row: 50, col: 0 },
				{ name: "colPercent: 100 (right)", row: 50, col: 100 },
			];

			let index = 0;
			while (true) {
				const config = configs[index]!;
				const result = await ctx.ui.custom<"next" | "close">(
					(_tui, theme, _kb, done) => new PercentTestComponent(theme, config, done),
					{
						overlay: true,
						overlayOptions: {
							width: 30,
							row: `${config.row}%`,
							col: `${config.col}%`,
						},
					},
				);

				if (result === "next") {
					index = (index + 1) % configs.length;
					continue;
				}
				break;
			}
		},
	});

	// Test maxHeight
	pi.registerCommand("overlay-maxheight", {
		description: "Test maxHeight truncation",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => new MaxHeightTestComponent(theme, done), {
				overlay: true,
				overlayOptions: { anchor: "center", width: 50, maxHeight: 10 },
			});
		},
	});

	// Test responsive sidepanel - only shows when terminal is wide enough
	pi.registerCommand("overlay-sidepanel", {
		description: "Test responsive sidepanel (hides when terminal < 100 cols)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await ctx.ui.custom<void>((tui, theme, _kb, done) => new SidepanelComponent(tui, theme, done), {
				overlay: true,
				overlayOptions: {
					anchor: "right-center",
					width: "25%",
					minWidth: 30,
					margin: { right: 1 },
					// Only show when terminal is wide enough
					visible: (termWidth) => termWidth >= 100,
				},
			});
		},
	});

	// Test toggle overlay - demonstrates OverlayHandle.setHidden() via onHandle callback
	pi.registerCommand("overlay-toggle", {
		description: "Test overlay toggle (press 't' to toggle visibility)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await ctx.ui.custom<void>((tui, theme, _kb, done) => new ToggleDemoComponent(tui, theme, done, () => globalToggleHandle), {
				overlay: true,
				overlayOptions: { anchor: "center", width: 50 },
				// onHandle callback provides access to the OverlayHandle for visibility control
				onHandle: (handle) => {
					// Store handle globally so component can access it
					// (In real code, you'd use a more elegant pattern like a store or event emitter)
					globalToggleHandle = handle;
				},
			});
			globalToggleHandle = null;
		},
	});

	// Non-capturing overlay demo - passive info panel that doesn't steal focus
	pi.registerCommand("overlay-passive", {
		description: "Test non-capturing overlay (passive info panel alongside active overlay)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			ctx.ui.setEditorText("");
			await ctx.ui.custom<void>((tui, theme, _kb, done) => new PassiveDemoController(tui, theme, done), {
				overlay: true,
				overlayOptions: { anchor: "center", width: 48 },
			});
		},
	});

	// Focus cycling demo - demonstrates focus(), input routing, per-panel dismissal, and rendering order
	pi.registerCommand("overlay-focus", {
		description: "Test focus cycling, input routing, dismissal, and rendering order with overlays",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			ctx.ui.setEditorText("");
			await ctx.ui.custom<void>((tui, theme, _kb, done) => new FocusDemoController(tui, theme, done), {
				overlay: true,
				overlayOptions: { anchor: "bottom-center", width: 55, margin: { bottom: 1 } },
			});
		},
	});

	// Test multiple input panels with simulated streaming
	pi.registerCommand("overlay-streaming", {
		description: "Multiple input panels with simulated streaming (Tab to cycle focus)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			ctx.ui.setEditorText("");
			await ctx.ui.custom<void>((tui, theme, _kb, done) => new StreamingInputController(tui, theme, done), {
				overlay: true,
				overlayOptions: { anchor: "bottom-center", width: 60, margin: { bottom: 1 } },
			});
		},
	});
}

