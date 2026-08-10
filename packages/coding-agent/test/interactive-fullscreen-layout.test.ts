import type { Component } from "@earendil-works/pi-tui";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import {
	createProductionFullscreenContext,
	getLayoutFrame,
	RecordingTerminal,
} from "./helpers/interactive-fullscreen-layout.ts";

type StackLike = {
	children: Component[];
};

test("InteractiveMode.init builds the fullscreen dock and preserves flat mount order", async () => {
	const { context, terminal, tui, initPromise, resolveTheme, restoreOffline } = createProductionFullscreenContext();

	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		tui.renderNow();

		const root = context.fullscreenLayoutRoot as StackLike | undefined;
		const transcript = context.transcriptScrollView;
		if (!root || !transcript) {
			throw new Error("InteractiveMode.init did not build the fullscreen layout");
		}
		const [rootTranscript, dock] = root.children as [Component | undefined, StackLike | undefined];
		if (!rootTranscript || !dock) {
			throw new Error("InteractiveMode.init did not mount the transcript and dock");
		}

		const dockChildren = [
			context.pendingMessagesContainer,
			context.statusContainer,
			context.widgetContainerAbove,
			context.usageMeter,
			context.editorContainer,
			context.footerContainer,
			context.widgetContainerBelow,
		];
		const flatMountOrder = [context.documentContainer, ...dockChildren];

		// These are production components, not a hand-built test root. Their
		// identities and order catch wiring changes before rendering.
		expect(root.children).toHaveLength(2);
		expect(rootTranscript).toBe(transcript);
		expect(transcript.children).toEqual([context.documentContainer]);
		expect(dock.children).toEqual(dockChildren);
		expect(tui.children).toEqual(flatMountOrder);

		tui.renderNow();
		const initial = getLayoutFrame(tui);
		expect(initial.root.component).toBe(context.fullscreenLayoutRoot);
		const initialTranscript = initial.root.children[0];
		const initialDock = initial.root.children[1];
		if (!initialTranscript || !initialDock) throw new Error("fullscreen layout children disappeared");
		expect(initialTranscript.component).toBe(transcript);
		expect(initialDock.component).toBe(dock);
		const expectedDockHeight = dock.render(terminal.columns).length;
		expect(initialDock.rect.height).toBe(expectedDockHeight);
		expect(initialDock.rect.y).toBe(terminal.rows - initialDock.rect.height);
		expect(initialTranscript.rect.height).toBe(initialDock.rect.y);
		const dockLines = initial.lines.slice(initialDock.rect.y, initialDock.rect.y + initialDock.rect.height);
		expect(dockLines.some((line) => line.includes("editor"))).toBe(true);
		expect(dockLines.at(-1)).toContain("footer");

		const regularTui = new TuiMainScreen(new RecordingTerminal());
		context.mountInteractiveTui(regularTui, flatMountOrder);
		expect(regularTui.children).toEqual(flatMountOrder);
	} finally {
		resolveTheme();
		await initPromise;
		tui.stop();
		restoreOffline();
	}
});
