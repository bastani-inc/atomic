import assert from "node:assert/strict";
import { Container } from "@bastani/atomic-tui";
import { beforeAll, test, vi } from "vitest";
import "../src/modes/interactive/interactive-extension-runtime.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

/** Removing the working row draws the screen without it; a clear that removed nothing asks for no frame. */

beforeAll(() => initTheme("dark"));

function screenWithStatus() {
	const requestRender = vi.fn();
	const mode = {
		ui: { requestRender, requestImmediateRender() {}, terminal: { columns: 80, rows: 24 } },
		loadingAnimation: undefined,
		workingIndicatorEmbedded: false,
		statusContainer: new Container(),
		setEditorWorkingStatusIndicator: () => false,
	} as unknown as InteractiveModeBase;
	return { mode, requestRender };
}

test("removing the working row asks for a frame, so the row leaves the screen with no key pressed (#6134)", () => {
	const { mode, requestRender } = screenWithStatus();
	const stop = vi.fn();
	const row = { render: () => ["∀ Working…"], invalidate() {}, stop };
	Object.assign(mode, { loadingAnimation: row });
	mode.statusContainer.addChild(row as never);
	InteractiveModeBase.prototype.clearWorkingLoader.call(mode);
	assert.equal(stop.mock.calls.length, 1);
	assert.deepEqual(mode.statusContainer.render(80), []);
	assert.equal(requestRender.mock.calls.length, 1);
});

test("a clear with no working row asks for no frame (#6134)", () => {
	const { mode, requestRender } = screenWithStatus();
	InteractiveModeBase.prototype.clearWorkingLoader.call(mode);
	assert.equal(requestRender.mock.calls.length, 0);
});
