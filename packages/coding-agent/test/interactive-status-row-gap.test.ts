import { Text } from "@bastani/atomic-tui";
import { expect, test } from "vitest";
import {
	AtomicWorkedStatusComponent,
	AtomicWorkingStatusComponent,
} from "../src/modes/interactive/components/atomic-working-status.ts";
import type { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createProductionFullscreenContext, getLayoutFrame } from "./helpers/interactive-fullscreen-layout.ts";

/** The rows of the main chat's painted frame from the last transcript line through the composer, ANSI removed. */
function rowsAboveComposer(context: InteractiveMode, lines: readonly string[]): string[] {
	const plain = lines.map((line) => stripAnsi(line).trimEnd());
	const editorRow = plain.findIndex((line) => line === "editor");
	const transcriptRow = plain.findLastIndex((line) => line.startsWith("transcript line "));
	if (editorRow < 0 || transcriptRow < 0)
		throw new Error(`frame lacks the transcript or the composer:\n${plain.join("\n")}`);
	expect(context.editorContainer.children).toContain(context.editor);
	return plain.slice(transcriptRow, editorRow + 1);
}

async function withMainChat(run: (context: InteractiveMode, paint: () => string[]) => void): Promise<void> {
	const { context, tui, initPromise, resolveTheme, restoreOffline } = createProductionFullscreenContext({
		columns: 100,
		rows: 30,
		transcriptLines: 40,
	});
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		const paint = () => {
			tui.renderNow();
			return rowsAboveComposer(context, getLayoutFrame(tui).lines);
		};
		run(context, paint);
	} finally {
		resolveTheme();
		await initPromise;
		tui.stop();
		restoreOffline();
	}
}

test("the main chat's working status sits directly on the usage row above the composer", async () => {
	await withMainChat((context, paint) => {
		context.statusContainer.addChild(new AtomicWorkingStatusComponent({ message: "Baptizing" }));
		const rows = paint();
		expect(rows).toHaveLength(5);
		expect(rows[0]).toBe("transcript line 40");
		expect(rows[1]).toBe("");
		expect(rows[2]).toContain("Baptizing");
		expect(rows[3]).toBe("usage");
		expect(rows[4]).toBe("editor");
	});
});

test("the main chat's finished-turn line sits directly on the usage row above the composer", async () => {
	await withMainChat((context, paint) => {
		context.statusContainer.addChild(
			new AtomicWorkedStatusComponent({ message: "Baptizing", snapshot: { elapsedMs: 209_000, tokens: 13_500 } }),
		);
		expect(paint()).toEqual(["transcript line 40", "", expect.stringContaining("for 3m 29s"), "usage", "editor"]);
	});
});

test("an idle main chat puts its transcript directly on the usage row above the composer", async () => {
	await withMainChat((_context, paint) => {
		expect(paint()).toEqual(["transcript line 40", "usage", "editor"]);
	});
});

test("above-editor extension widgets stay separated from the working status and sit on the usage row", async () => {
	await withMainChat((context, paint) => {
		context.statusContainer.addChild(new AtomicWorkingStatusComponent({ message: "Baptizing" }));
		context.extensionWidgetsAbove.set("example", new Text("widget row", 0, 0));
		context.renderWidgets();
		const rows = paint();
		expect(rows[0]).toBe("transcript line 40");
		expect(rows[1]).toBe("");
		expect(rows[2]).toContain("Baptizing");
		expect(rows.slice(3)).toEqual(["", "widget row", "usage", "editor"]);
	});
});
