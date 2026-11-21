import assert from "node:assert";
import { describe, it, type TestContext } from "node:test";
import { type Component, Container, type TuiMouseEventResult } from "../src/tui.ts";
import { MULTI_CLICK_INTERVAL_MS, TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const press = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M`;
const release = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}m`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mockClickClock(t: TestContext): void {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
	// Node's mock timers advance Date and timeouts, but not performance.now().
	t.mock.method(performance, "now", Date.now.bind(Date));
}

/**
 * A renderer that copies what a double-click selects, over rows whose single click acts only once it is known not to
 * start a double- or triple-click. `capture` makes each row take its press, as a component that owns its gesture does.
 */
function settleFixture(options: { readonly capture?: boolean } = {}) {
	const terminal = new VirtualTerminal(30, 4);
	const copied: string[] = [];
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	const acted: string[] = [];
	const clicks: string[] = [];
	const row = (name: string, label = name): Component => ({
		render: () => [`${label} words here`],
		invalidate: () => {},
		handleMouse: (event): TuiMouseEventResult | undefined => {
			if (options.capture && event.type === "press") return { handled: true, capture: true };
			if (event.type !== "click" || (event.clickCount ?? 1) !== 1) return undefined;
			clicks.push(name);
			return { handled: true, whenSingleClick: () => acted.push(name) };
		},
	});
	const list = new Container();
	list.addChild(row("first"));
	list.addChild(row("second"));
	tui.addChild(list);
	const click = (x: number, y: number) => {
		terminal.sendInput(press(x, y));
		terminal.sendInput(release(x, y));
	};
	return { terminal, tui, copied, acted, clicks, click, list, row };
}

describe("a single click's action waits until it cannot become a double-click", () => {
	for (const capture of [false, true]) {
		it(`hiding and showing a dialog revokes its held choice without losing button-up (capture: ${capture}) (#5643)`, async (t) => {
			const { terminal, tui } = settleFixture();
			const events: string[] = [];
			const dialog = new Container();
			const child: Component = {
				render: () => ["Choose red"],
				invalidate() {},
				handleMouse(event) {
					events.push(event.type);
					if (event.type === "press" && capture) return { handled: true, capture: true };
					if (event.type === "click") return { handled: true };
					return undefined;
				},
			};
			dialog.addChild(child);
			const overlay = tui.showOverlay(dialog, { anchor: "top-left", width: 15 });
			tui.setFocus(child);
			tui.start();
			t.after(() => tui.stop());
			await terminal.waitForRender();
			terminal.sendInput(press(2, 0));
			overlay.setHidden(true);
			overlay.setHidden(false);
			terminal.sendInput(release(2, 0));
			assert.deepStrictEqual(events, ["press", "release"]);
			terminal.sendInput(press(9, 0));
			terminal.sendInput(release(9, 0));
			assert.deepStrictEqual(events.slice(2), ["press", "release", "click"]);
		});
	}

	for (const handlesDouble of [false, true]) {
		it(`the row still decides whether a repeat click copies a word (handled: ${handlesDouble}) (#5643)`, async (t) => {
			const { terminal, tui, click, copied } = settleFixture();
			const dialog = new Container();
			const counts: number[] = [];
			const child: Component = {
				render: () => ["Second choice"],
				invalidate() {},
				handleMouse(event) {
					if (event.type !== "click") return undefined;
					counts.push(event.clickCount!);
					return event.clickCount === 2 && handlesDouble ? { handled: true } : undefined;
				},
			};
			dialog.addChild(child);
			const overlay = tui.showOverlay(dialog, { anchor: "top-left", width: 15 });
			tui.setFocus(child);
			tui.start();
			t.after(() => tui.stop());
			await terminal.waitForRender();
			mockClickClock(t);
			click(0, 0);
			terminal.sendInput(press(0, 0));
			overlay.setHidden(true);
			overlay.setHidden(false);
			terminal.sendInput(release(0, 0));
			assert.deepStrictEqual(counts, [1, 2]);
			assert.deepStrictEqual(copied, handlesDouble ? [] : ["Second"]);
		});
	}

	it("cancels a deferred choice only when its own overlay occurrence ends (#5643)", async (t) => {
		const { terminal, tui, click } = settleFixture();
		const events: string[] = [];
		const child: Component = {
			render: () => ["Choose red"],
			invalidate() {},
			handleMouse(event) {
				if (event.type !== "click") return undefined;
				events.push("offer");
				return {
					handled: true,
					whenSingleClick: () => events.push("commit"),
					onSingleClickCancel: () => events.push("cancel"),
				};
			},
		};
		const dialog = new Container();
		dialog.addChild(child);
		const other = tui.showOverlay(dialog, { anchor: "top-right", width: 10 });
		const owner = tui.showOverlay(dialog, { anchor: "top-left", width: 10 });
		tui.setFocus(child);
		tui.start();
		t.after(() => tui.stop());
		await terminal.waitForRender();
		mockClickClock(t);
		click(2, 0);
		other.hide();
		t.mock.timers.tick(MULTI_CLICK_INTERVAL_MS + 1);
		assert.deepStrictEqual(events, ["offer", "commit"]);
		click(7, 0);
		owner.setHidden(true);
		owner.setHidden(false);
		assert.deepStrictEqual(events, ["offer", "commit", "offer"]);
		t.mock.timers.tick(MULTI_CLICK_INTERVAL_MS + 1);
		assert.deepStrictEqual(events, ["offer", "commit", "offer", "cancel"]);
	});

	it("runs once the multi-click interval has passed since the press, and not before", async () => {
		const { terminal, tui, acted, clicks, click } = settleFixture();
		tui.start();
		await terminal.waitForRender();

		click(1, 0);
		await terminal.waitForRender();
		assert.deepStrictEqual(clicks, ["first"], "the click reached the row at once");
		assert.deepStrictEqual(acted, [], "its action waits for the multi-click interval");

		await sleep(MULTI_CLICK_INTERVAL_MS / 2);
		assert.deepStrictEqual(acted, []);
		await sleep(MULTI_CLICK_INTERVAL_MS / 2 + 50);
		assert.deepStrictEqual(acted, ["first"], "with no second press the click was a single click");
		await sleep(MULTI_CLICK_INTERVAL_MS);
		assert.deepStrictEqual(acted, ["first"], "the action runs once");
		tui.stop();
	});

	for (const rollback of [2_000, 60_000]) {
		it(`a wall-clock step back by ${rollback} ms does not delay a pending single click`, async (t) => {
			const { terminal, tui, acted, click } = settleFixture();
			tui.start();
			t.after(() => tui.stop());
			await terminal.waitForRender();
			mockClickClock(t);
			click(1, 0);
			t.mock.timers.tick(50);
			t.mock.method(Date, "now", () => performance.now() - rollback);
			t.mock.timers.tick(MULTI_CLICK_INTERVAL_MS - 50);
			assert.deepStrictEqual(acted, []);
			t.mock.timers.tick(1);
			assert.deepStrictEqual(acted, ["first"]);
		});
	}

	it("never runs for a double- or triple-click, which still select a word and a line", async () => {
		const { terminal, tui, copied, acted, click } = settleFixture();
		tui.start();
		await terminal.waitForRender();

		click(8, 0);
		click(8, 0);
		await terminal.waitForRender();
		await sleep(MULTI_CLICK_INTERVAL_MS + 100);
		assert.deepStrictEqual(acted, [], "a double-click is not a single click");
		assert.deepStrictEqual(copied, ["words"]);

		click(8, 1);
		click(8, 1);
		click(8, 1);
		await terminal.waitForRender();
		await sleep(MULTI_CLICK_INTERVAL_MS + 100);
		assert.deepStrictEqual(acted, [], "a triple-click is not a single click");
		assert.deepStrictEqual(copied, ["words", "words", "second words here"]);
		tui.stop();
	});

	it("keeps a click's action when a quick second click lands elsewhere, and runs both", async () => {
		const { terminal, tui, acted, click } = settleFixture();
		tui.start();
		await terminal.waitForRender();

		click(1, 0);
		click(1, 1);
		await terminal.waitForRender();
		assert.deepStrictEqual(acted, []);
		await sleep(MULTI_CLICK_INTERVAL_MS + 100);
		assert.deepStrictEqual(acted, ["first", "second"]);
		tui.stop();
	});

	it("clicking two items painted at the same cell runs both pending singles on their own items (#5562)", async (t) => {
		const { terminal, tui, acted, click, list, row } = settleFixture();
		tui.start();
		t.after(() => tui.stop());
		await terminal.waitForRender();
		mockClickClock(t);
		click(1, 0);
		list.children.unshift(row("inserted", "first"));
		list.invalidate();
		tui.renderNow();
		click(1, 0);
		t.mock.timers.tick(MULTI_CLICK_INTERVAL_MS + 1);
		assert.deepStrictEqual(acted, ["first", "inserted"]);
	});

	it("waits the same way for a component that takes its press", async () => {
		const { terminal, tui, acted, clicks, click } = settleFixture({ capture: true });
		tui.start();
		await terminal.waitForRender();

		click(1, 0);
		await terminal.waitForRender();
		assert.deepStrictEqual(clicks, ["first"]);
		assert.deepStrictEqual(acted, []);
		await sleep(MULTI_CLICK_INTERVAL_MS + 100);
		assert.deepStrictEqual(acted, ["first"]);

		click(1, 1);
		click(1, 1);
		await terminal.waitForRender();
		await sleep(MULTI_CLICK_INTERVAL_MS + 100);
		assert.deepStrictEqual(acted, ["first"], "the second click made it a double-click");
		tui.stop();
	});

	it("holding the second press of a captured double-click never runs a single-click action (#5562)", async (t) => {
		const { terminal, tui, acted } = settleFixture({ capture: true });
		tui.start();
		t.after(() => tui.stop());
		await terminal.waitForRender();
		mockClickClock(t);

		terminal.sendInput(press(1, 0));
		t.mock.timers.tick(10);
		terminal.sendInput(release(1, 0));
		t.mock.timers.tick(MULTI_CLICK_INTERVAL_MS - 10);
		terminal.sendInput(press(1, 0)); // The interval includes its last millisecond.
		t.mock.timers.tick(MULTI_CLICK_INTERVAL_MS);
		terminal.sendInput(release(1, 0));
		t.mock.timers.tick(MULTI_CLICK_INTERVAL_MS + 1);
		assert.deepStrictEqual(acted, []);
	});

	it("a captured single held beyond its deadline acts at release, and the next press starts over (#5562)", async (t) => {
		const { terminal, tui, acted, click } = settleFixture({ capture: true });
		tui.start();
		t.after(() => tui.stop());
		await terminal.waitForRender();
		mockClickClock(t);
		terminal.sendInput(press(1, 0));
		t.mock.timers.tick(MULTI_CLICK_INTERVAL_MS + 1);
		assert.deepStrictEqual(acted, []);
		terminal.sendInput(release(1, 0));
		t.mock.timers.tick(1);
		assert.deepStrictEqual(acted, ["first"]);
		click(1, 0);
		t.mock.timers.tick(MULTI_CLICK_INTERVAL_MS + 1);
		assert.deepStrictEqual(acted, ["first", "first"]);
	});

	for (const captureFirst of [true, false]) {
		it(`keeps a triple-click together when only the ${captureFirst ? "outer presses" : "middle press"} are captured (#5562)`, async (t) => {
			const options = { capture: captureFirst };
			const { terminal, tui, acted, copied, click } = settleFixture(options);
			tui.start();
			t.after(() => tui.stop());
			await terminal.waitForRender();
			mockClickClock(t);

			click(8, 0);
			options.capture = !captureFirst;
			t.mock.timers.tick(100);
			click(8, 0);
			options.capture = captureFirst;
			t.mock.timers.tick(100);
			click(8, 0);
			t.mock.timers.tick(MULTI_CLICK_INTERVAL_MS + 1);
			assert.deepStrictEqual(acted, []);
			assert.deepStrictEqual(copied, [captureFirst ? "words" : "first words here"]);
		});
	}

	for (const capture of [false, true]) {
		it(`a wheel turn separates ${capture ? "captured" : "uncaptured"} clicks and interrupts a held press (#5562)`, async (t) => {
			const { terminal, tui, acted, click } = settleFixture({ capture });
			tui.start();
			t.after(() => tui.stop());
			await terminal.waitForRender();
			mockClickClock(t);
			const wheel = () => terminal.sendInput("\x1b[<65;2;1M");
			click(1, 0);
			wheel();
			click(1, 0);
			terminal.sendInput(press(1, 1));
			wheel();
			terminal.sendInput(release(1, 1));
			t.mock.timers.tick(MULTI_CLICK_INTERVAL_MS + 1);
			assert.deepStrictEqual(acted, ["first", "first"]);
		});
	}

	it("losing terminal focus cancels an outstanding single click and a held press (#5562)", async (t) => {
		const { terminal, tui, acted, click } = settleFixture({ capture: true });
		tui.start();
		t.after(() => tui.stop());
		await terminal.waitForRender();
		mockClickClock(t);
		click(1, 0);
		terminal.sendInput(press(1, 1));
		terminal.sendInput("\x1b[O");
		terminal.sendInput("\x1b[I");
		terminal.sendInput(release(1, 1));
		click(1, 1);
		t.mock.timers.tick(MULTI_CLICK_INTERVAL_MS + 1);
		assert.deepStrictEqual(acted, ["second"]);
	});

	it("a single click that clears a painted drag highlight still acts on the unchanged row (#5562)", async (t) => {
		const { terminal, tui, acted } = settleFixture();
		tui.start();
		t.after(() => tui.stop());
		await terminal.waitForRender();
		mockClickClock(t);
		terminal.sendInput(press(6, 0));
		terminal.sendInput("\x1b[<32;9;1M");
		terminal.sendInput(release(8, 0));
		tui.renderNow();
		assert.ok(tui.hasActiveSelection());
		terminal.sendInput(press(8, 0));
		tui.renderNow();
		terminal.sendInput(release(8, 0));
		t.mock.timers.tick(MULTI_CLICK_INTERVAL_MS + 1);
		assert.deepStrictEqual(acted, ["first"]);
	});

	it("a double-click still selects a word after its first press clears a painted drag selection (#5562)", async (t) => {
		const { terminal, tui, copied, acted, click } = settleFixture();
		tui.start();
		t.after(() => tui.stop());
		await terminal.waitForRender();
		mockClickClock(t);
		terminal.sendInput(press(6, 0));
		terminal.sendInput("\x1b[<32;9;1M");
		terminal.sendInput(release(8, 0));
		tui.renderNow();
		assert.equal(copied.length, 1);
		terminal.sendInput(press(8, 0));
		tui.renderNow(); // The first press removed the drag highlight, not the word underneath it.
		terminal.sendInput(release(8, 0));
		click(8, 0);
		t.mock.timers.tick(MULTI_CLICK_INTERVAL_MS + 1);
		assert.deepStrictEqual(copied.slice(1), ["words"]);
		assert.deepStrictEqual(acted, []);
	});

	it("drops a waiting action when the renderer stops", async () => {
		const { terminal, tui, acted, click } = settleFixture();
		tui.start();
		await terminal.waitForRender();

		click(1, 0);
		await terminal.waitForRender();
		tui.stop();
		await sleep(MULTI_CLICK_INTERVAL_MS + 100);
		assert.deepStrictEqual(acted, []);
	});

	it("tells a viewport listener once the late single click leaves the pointer idle, and only then (#5693)", async (t) => {
		const { terminal, tui, acted, click } = settleFixture();
		tui.start();
		t.after(() => tui.stop());
		await terminal.waitForRender();
		const heard: boolean[] = [];
		const stop = tui.onViewportChange(() => heard.push(tui.isPointerIdle()));
		t.after(stop);
		mockClickClock(t);
		click(1, 0);
		await Promise.resolve();
		assert.deepStrictEqual(heard, [false], "the click was input, and its action still waits");
		t.mock.timers.tick(MULTI_CLICK_INTERVAL_MS + 1);
		await Promise.resolve();
		assert.deepStrictEqual(acted, ["first"]);
		assert.deepStrictEqual(heard, [false, true]);
		stop();
		click(1, 1);
		t.mock.timers.tick(MULTI_CLICK_INTERVAL_MS + 1);
		await Promise.resolve();
		assert.deepStrictEqual(heard, [false, true], "a listener that stopped hears nothing more");
	});
});
