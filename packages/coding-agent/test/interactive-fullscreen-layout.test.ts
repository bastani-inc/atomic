import type { Component } from "@bastani/atomic-tui";
import { Text, TuiMainScreen } from "@bastani/atomic-tui";
import { expect, test } from "vitest";
import {
	createProductionFullscreenContext,
	getLayoutFrame,
	RecordingTerminal,
} from "./helpers/interactive-fullscreen-layout.ts";

type StackLike = {
	children: Component[];
};

test("InteractiveMode.init builds the fullscreen dock and shares navigation-aware pending previews with flat mounts (#5245)", async () => {
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

		const pendingPreview = dock.children[0];
		if (!pendingPreview) throw new Error("pending preview was not mounted");
		context.pendingMessagesContainer.addChild(new Text("pending preview", 0, 0));
		expect(pendingPreview.render(terminal.columns).map((line) => line.trimEnd())).toEqual(["pending preview"]);
		context.navigationInlineCustomUiDepth = 1;
		expect(pendingPreview.render(terminal.columns)).toEqual([]);
		context.navigationInlineCustomUiDepth = 0;
		expect(pendingPreview.render(terminal.columns).map((line) => line.trimEnd())).toEqual(["pending preview"]);
		context.pendingMessagesContainer.clear();
		const dockChildren = [
			pendingPreview,
			context.statusContainer,
			context.widgetContainerAbove,
			context.usageMeter,
			context.editorContainer,
			context.footerContainer,
			context.widgetContainerBelow,
		];
		const flatMountOrder = [
			context.documentContainer,
			pendingPreview,
			context.statusContainer,
			context.widgetContainerAbove,
			context.usageMeter,
			context.editorContainer,
			context.footerContainer,
			context.widgetContainerBelow,
		];

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
