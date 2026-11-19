// A fresh SDK process exposes cold initialization and lets us collect objects between event-loop turns.
import assert from "node:assert/strict";

let segmenters = 0;
Intl.Segmenter = class extends Intl.Segmenter {
	constructor(...args) {
		super(...args);
		segmenters++;
	}
};
const { CustomMessageComponent, initTheme, rowsFrom } = await import("@bastani/atomic");
if (process.argv[2] === "import") {
	assert.deepEqual(rowsFrom(1, 2), { start: 1, end: 2 });
	assert.ok(segmenters <= 6, `noninteractive SDK import constructed ${segmenters} segmenters`);
} else {
	const { StartupChatContainer } = await import("../../dist/modes/interactive/interactive-startup-chat-container.js");
	await initTheme("dark", false);
	const request = { width: 70, height: 8, top: 0, followEnd: false, requestRender() {} };
	const chat = new StartupChatContainer();
	chat.releaseStartupOutput();
	let oldFrame;
	let first = true;
	const rows = Array.from({ length: 2000 }, (_, i) => `report ${i}`);
	const block = new CustomMessageComponent(
		{ role: "custom", customType: "report", content: "report", display: true, timestamp: 1 },
		() => ({ render: () => (first ? rows : ["new report"]), invalidate() {} }),
	);
	const render = block.render.bind(block);
	block.render = (width) => {
		const lines = render(width);
		if (first && !oldFrame) oldFrame = new WeakRef(lines);
		return lines;
	};
	chat.addChild(block);
	const layout = chat.layoutWindow(request);
	assert.equal(layout.at(1), "report 0");
	const cell = {
		button: "left", clickCount: 1, x: 1, y: 1, screenX: 1, screenY: 1,
		width: 70, height: layout.length, shift: false, alt: false, ctrl: false,
	};
	chat.handleMouse({ ...cell, type: "press" });
	const pending = chat.handleMouse({ ...cell, type: "click" });
	assert.equal(typeof pending?.whenSingleClick, "function");
	first = false;
	assert.equal(chat.layoutWindow(request).at(1), "new report");
	for (let i = 0; i < 8; i++) {
		await new Promise((resolve) => setImmediate(resolve));
		globalThis.gc();
	}
	assert.ok(oldFrame);
	assert.equal(Boolean(oldFrame.deref()), false, "the waiting toggle kept the replaced row array alive");
	pending.whenSingleClick();
}
