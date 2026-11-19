import assert from "node:assert";
import { describe, it } from "node:test";
import {
	clickableHint,
	clickableHintText,
	clickableKeysHint,
	clickableKeyTextHint,
	commandHintAction,
	keyHintAction,
	readHintSpans,
	slashCommandHint,
} from "../src/clickable-hints.ts";
import { Text } from "../src/components/text.ts";
import { keyInputData, matchesKey } from "../src/keys.ts";
import { type Component, compositeTuiLine, type TuiMouseEvent, type TuiMouseEventResult } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { sliceByColumn, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** A terminal that keeps every write, so a test can tell what reached it. */
class RecordingVirtualTerminal extends VirtualTerminal {
	readonly writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

/** A focused view that draws `lines` and records the keys it receives and the mouse events it is offered. */
class KeyView implements Component {
	lines: string[];
	readonly keys: string[] = [];
	readonly mouse: string[] = [];
	private readonly takesPresses: boolean;

	constructor(lines: string[], takesPresses = false) {
		this.lines = lines;
		this.takesPresses = takesPresses;
	}

	render(): string[] {
		return this.lines;
	}

	handleInput(data: string): void {
		this.keys.push(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "move") return undefined;
		this.mouse.push(`${event.type}@${event.y}`);
		return this.takesPresses ? { handled: true } : undefined;
	}

	invalidate(): void {}
}

const press = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M`;
const drag = (x: number, y: number) => `\x1b[<32;${x + 1};${y + 1}M`;
const release = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}m`;
const DOUBLE_CLICK_GAP_MS = 600;

async function mount(lines: string[], takesPresses = false) {
	const terminal = new RecordingVirtualTerminal(40, 6);
	const tui = new TuiAltScreen(terminal);
	const view = new KeyView(lines, takesPresses);
	tui.addChild(view);
	tui.setFocus(view);
	tui.start();
	await terminal.waitForRender();
	const click = async (x: number, y: number) => {
		terminal.sendInput(press(x, y));
		terminal.sendInput(release(x, y));
		await terminal.waitForRender();
	};
	return { terminal, tui, view, click };
}

/** The keys `view` received, by the key id each one matches. */
function keysOf(view: KeyView, ...ids: Parameters<typeof matchesKey>[1][]): string[] {
	return view.keys.map((data) => ids.find((id) => matchesKey(data, id)) ?? JSON.stringify(data));
}

describe("a click on a key hint runs its key", () => {
	it("feeds the hint's key to the focused view, and never writes the hint markers to the terminal", async () => {
		const { terminal, view, click, tui } = await mount([clickableHint("esc cancel", keyHintAction("escape"))]);
		await click(5, 0);
		assert.deepStrictEqual(keysOf(view, "escape"), ["escape"]);
		assert.ok(!terminal.writes.join("").includes("\x1b_pi:h"), "the hint markers stay inside the renderer");
		assert.strictEqual(tui.getScreenLines()[0]?.includes("\x1b_pi"), false);
		assert.strictEqual(terminal.getViewport()[0]?.trimEnd(), "esc cancel");
		tui.stop();
	});

	it("acts by the half clicked on a hint that names two keys", async () => {
		const hint = clickableKeysHint(
			[
				{ text: "↑/", key: "up" },
				{ text: "↓", key: "down" },
			],
			" select",
		);
		const { view, click, tui } = await mount([`  ${hint}`]);
		await click(2, 0); // ↑
		await new Promise((resolve) => setTimeout(resolve, DOUBLE_CLICK_GAP_MS));
		await click(4, 0); // ↓
		await new Promise((resolve) => setTimeout(resolve, DOUBLE_CLICK_GAP_MS));
		await click(8, 0); // select
		assert.deepStrictEqual(keysOf(view, "up", "down"), ["up", "down", "down"]);
		tui.stop();
	});

	it("runs once for a double click, and not at all for a drag, which selects the hint's text", async () => {
		const { terminal, view, click, tui } = await mount([clickableHint("enter select", keyHintAction("enter"))]);
		await click(2, 0);
		await click(2, 0);
		assert.deepStrictEqual(keysOf(view, "enter"), ["enter"], "the second click of a double click selects the word");

		await new Promise((resolve) => setTimeout(resolve, DOUBLE_CLICK_GAP_MS));
		terminal.sendInput(press(1, 0));
		terminal.sendInput(drag(8, 0));
		terminal.sendInput(release(8, 0));
		await terminal.waitForRender();
		assert.deepStrictEqual(keysOf(view, "enter"), ["enter"], "a drag selects text and runs nothing");
		assert.strictEqual(tui.hasActiveSelection(), true);
		tui.stop();
	});

	it("runs remapped function keys when their hint labels are clicked (#5528)", async () => {
		const keys = ["ctrl+f1", "alt+f3", "shift+f5", "ctrl+shift+f12"] as const;
		const { view, click, tui } = await mount(keys.map((key) => clickableKeyTextHint(key, " select")));
		try {
			for (const [row, key] of keys.entries()) await click(key.length + 2, row);
			assert.deepStrictEqual(keysOf(view, ...keys), [...keys]);
		} finally {
			tui.stop();
		}
	});

	it("keeps a literal plus key distinct from its modifier or alternative separator (#5528)", async () => {
		const { view, click, tui } = await mount([clickableKeyTextHint("+/ctrl++/esc", " close")]);
		try {
			for (const x of [0, 3, 10]) {
				await click(x, 0);
				if (x !== 10) await new Promise((resolve) => setTimeout(resolve, DOUBLE_CLICK_GAP_MS));
			}
			assert.deepStrictEqual(keysOf(view, "+", "ctrl++", "escape"), ["+", "ctrl++", "escape"]);
		} finally {
			tui.stop();
		}
	});

	it("a spaced slash separates alternatives without swallowing a literal slash key (#5528)", async () => {
		const { view, click, tui } = await mount([
			clickableKeyTextHint("esc / enter", " choose"),
			clickableKeyTextHint("esc / /", " choose"),
		]);
		try {
			await click(4, 0); // separator between esc and enter
			await click(6, 1); // literal slash after the separator
			assert.deepStrictEqual(keysOf(view, "escape", "/"), ["escape", "/"]);
		} finally {
			tui.stop();
		}
	});

	it("a hint written as text presses the same final slash as one with an explicit label (#5528)", async () => {
		const { view, click, tui } = await mount([
			clickableHintText("esc / / pick"),
			clickableKeyTextHint("esc / /", " pick"),
		]);
		try {
			for (const x of [4, 6, 9]) {
				for (const y of [0, 1]) await click(x, y);
			}
			assert.deepStrictEqual(keysOf(view, "escape", "/"), ["escape", "escape", "/", "/", "/", "/"]);
		} finally {
			tui.stop();
		}
	});

	it("a spaced slash owns an unbound letter and its label, but separates a bound key (#5656)", () => {
		const line = "esc / a destination";
		assert.deepStrictEqual(hintsOn(clickableHintText(line)), ["escape: esc ", "/: / a destination"]);
		assert.deepStrictEqual(hintsOn(clickableHintText(line, ["a"])), ["escape: esc / ", "a: a destination"]);
	});

	it("keeps horizontal label separators in the clicked text without interpreting line breaks (#5656)", () => {
		for (const space of ["\t", "\u00a0", "\u2003", "\u202f"]) {
			const line = `enter${space}choose`;
			assert.strictEqual(clickableHintText(line), clickableHint(line, keyHintAction("enter")));
			assert.strictEqual(clickableKeyTextHint(`esc${space}enter`, " label"), `esc${space}enter label`);
		}
		const unread = new Proxy<never[]>([], { get: () => assert.fail("prose read a binding") });
		assert.strictEqual(clickableHintText("a\u00a0destination", unread), "a\u00a0destination");
		assert.strictEqual(
			clickableHintText("esc\u2003a destination", unread),
			clickableHint("esc\u2003a destination", keyHintAction("escape")),
		);
		for (const separator of ["\n", "\r", "\u2028"]) {
			const line = `enter${separator}choose`;
			assert.strictEqual(clickableHintText(line), line);
		}
	});

	it("a trailing slash in a space-separated key list remains a literal binding (#5528)", async () => {
		const { view, click, tui } = await mount([
			clickableKeyTextHint("esc /", " pick"),
			clickableHintText("esc / pick"),
			clickableHintText("esc /enter pick"),
		]);
		try {
			for (const row of [0, 1, 2]) await click(4, row);
			assert.deepStrictEqual(keysOf(view, "escape", "/"), ["/", "/", "escape"]);
		} finally {
			tui.stop();
		}
	});

	it("keeps counts, paths, ratios, URLs and punctuation in prose inert, even beside a real hint (#5528)", () => {
		for (const plain of [
			"1/10 tasks",
			"3/5",
			"3/5 tasks",
			"3 / 5 complete",
			"1/2/10 tasks",
			"3 tasks",
			"1.2/3 versions",
			"a/file.txt",
			"src/x.ts",
			"a/b pick",
			"enter/file.txt",
			"/usr/bin/env",
			"https://a/b",
			"ftp://x/y",
			"a note about +",
			"+ in prose",
			"x + y",
			"a+b",
			"C++ examples",
			"f13 choose",
			"/ choose",
			"+ choose",
			"y Yes",
		]) {
			const line = `${plain} · esc close`;
			assert.strictEqual(clickableHintText(line), `${plain} · ${clickableKeyTextHint("esc", " close")}`, plain);
		}
		assert.deepStrictEqual(["a/file.txt", "b/file.txt"].map(clickableHintText), ["a/file.txt", "b/file.txt"]);
		for (const ratio of ["1/10 tasks", "3/5 tasks", "3 / 5 complete"]) {
			assert.strictEqual(clickableHintText(ratio, ["1", "3", "5", "/"]), ratio);
		}
	});

	it("activates each key in a mixed numeric shortcut, without consulting bindings for ratios or invalid lists (#5656)", () => {
		const line = "1/2 / esc pick";
		assert.deepStrictEqual(hintsOn(clickableHintText(line, ["1", "2"])), ["1: 1/", "2: 2 / ", "escape: esc pick"]);
		assert.strictEqual(clickableHintText(line, ["1"]), line);
		const unread = new Proxy<never[]>([], { get: () => assert.fail("inert text read a binding") });
		for (const plain of [
			"1 / 2",
			"1/2 / 3 complete",
			"12/3 / esc choose",
			"1/2 / document",
			"1/2 / esc/bad-key",
			"1/2 / esc/",
			"1/2 / q finish",
		]) {
			assert.strictEqual(clickableHintText(plain, unread), plain);
		}
	});

	it("marks only complete named keys, explicit bindings and real slash-command hints (#5528)", () => {
		for (const [keys, label] of [
			["esc", " close"],
			["return", " choose"],
			["tab", " next"],
			["space", " toggle"],
			["home/end", " jump"],
			["pgup/pgdn", " scroll"],
			["↑↓", " select"],
			["↵", " open"],
			["shift+←/alt+f12", " move"],
			["ctrl+/", " pick"],
			["ctrl++", " pick"],
			["esc / /", " pick"],
			["esc /enter", " pick"],
			["enter/space", ""],
		] as const)
			assert.deepStrictEqual(
				readHintSpans(clickableHintText(keys + label)),
				readHintSpans(clickableKeyTextHint(keys, label)),
				keys,
			);
		for (const k of ["/", "+", "-", ",", "y", "n", "?"] as const) {
			assert.strictEqual(clickableHintText(`${k} choose`, [k]), clickableKeyTextHint(k, " choose"));
		}
		assert.strictEqual(clickableHintText("a/b pick", ["a", "b"]), clickableKeyTextHint("a/b", " pick"));
		assert.strictEqual(clickableHintText("a/file.txt", ["a"]), "a/file.txt");
		assert.strictEqual(
			clickableHintText("/tasks to manage"),
			clickableHint("/tasks to manage", commandHintAction("/tasks")),
		);
	});

	it("recognizes built-in slash commands but does not guess paths or extension commands (#5528)", () => {
		for (const name of ["/tasks", "/resume", "/settings", "/reload"]) {
			assert.strictEqual(clickableHintText(`${name} to open`), slashCommandHint(`${name} to open`));
		}
		for (const text of [
			"/tmp",
			"/README",
			"/usr/bin",
			"/tasks/output",
			"/workflows before registration",
			"/ext-command to open",
		]) {
			assert.strictEqual(clickableHintText(text), text);
		}
		assert.deepStrictEqual(
			readHintSpans(slashCommandHint("/ext-command to open")).spans[0]?.action,
			commandHintAction("/ext-command"),
		);
	});

	it("takes a press on a hint ahead of the view that drew it, and leaves every other cell to the view", async () => {
		const { view, click, tui } = await mount(
			["enter is plain text here", clickableHint("esc close", keyHintAction("escape"))],
			true,
		);
		await click(1, 0);
		assert.deepStrictEqual(view.keys, [], "text that only reads like a hint runs nothing");
		assert.ok(view.mouse.includes("press@0"), "the view keeps its own presses");
		await new Promise((resolve) => setTimeout(resolve, DOUBLE_CLICK_GAP_MS));
		await click(1, 1);
		assert.deepStrictEqual(keysOf(view, "escape"), ["escape"]);
		assert.ok(!view.mouse.includes("press@1"), "the hint took its press");
		tui.stop();
	});

	it("runs only the hints of the layer that holds the keys: a focused overlay's, not those drawn beneath it", async () => {
		const { view, click, tui, terminal } = await mount([clickableHint("esc interrupt", keyHintAction("escape"))]);
		const dialog = new KeyView(["", clickableHint("enter confirm", keyHintAction("enter"))]);
		tui.showOverlay(dialog, { anchor: "bottom-left", width: 20 });
		await terminal.waitForRender();
		await click(1, 0);
		assert.deepStrictEqual(view.keys, []);
		assert.deepStrictEqual(dialog.keys, [], "a hint beneath the dialog names a key the dialog does not offer");
		await new Promise((resolve) => setTimeout(resolve, DOUBLE_CLICK_GAP_MS));
		await click(1, 5);
		assert.deepStrictEqual(keysOf(dialog, "enter"), ["enter"]);
		tui.stop();
	});

	it("does not run a hint whose action changed between press and release (#5528)", async () => {
		const label = "open";
		const { terminal, view, tui } = await mount([clickableHint(label, keyHintAction("enter"))]);
		try {
			terminal.sendInput(press(1, 0));
			view.lines = [clickableHint(label, keyHintAction("down"))];
			tui.renderNow();
			terminal.sendInput(release(1, 0));
			assert.deepStrictEqual(view.keys, []);
		} finally {
			tui.stop();
		}
	});

	it("hands a slash command to the command handler", async () => {
		const { click, tui } = await mount([clickableHint("/tasks to manage", commandHintAction("/tasks"))]);
		const commands: string[] = [];
		tui.setHintCommandHandler((command) => commands.push(command));
		await click(3, 0);
		assert.deepStrictEqual(commands, ["/tasks"]);
		tui.stop();
	});
});

/** The text of each hint on `line` as the terminal shows it, with the key or command a click on it runs. */
function hintsOn(line: string): string[] {
	const { line: unmarked, spans } = readHintSpans(line);
	const text = stripTerminalSequences(unmarked);
	return spans.map(
		(span) =>
			`${span.action.kind === "key" ? span.action.key : span.action.command}: ${sliceByColumn(text, span.start, span.end - span.start)}`,
	);
}

describe("a hint keeps its action on every row it is drawn over, and no further", () => {
	const notice = `(${clickableKeyTextHint("ctrl+o", " for prompt, tool calls and full result")})`;

	it("runs its key from a click on the continuation of a wrapped hint, and not from the text after it", async () => {
		const { terminal, view, click, tui } = await mount([...new Text(notice, 0, 0).render(40), "after the hint"]);
		assert.deepStrictEqual(
			terminal
				.getViewport()
				.slice(0, 3)
				.map((row) => row.trimEnd()),
			["(ctrl+o for prompt, tool calls and full", "result)", "after the hint"],
		);
		await click(2, 1); // result
		assert.deepStrictEqual(keysOf(view, "ctrl+o"), ["ctrl+o"], "the wrapped row is part of the hint");
		await new Promise((resolve) => setTimeout(resolve, DOUBLE_CLICK_GAP_MS));
		await click(6, 1); // )
		await new Promise((resolve) => setTimeout(resolve, DOUBLE_CLICK_GAP_MS));
		await click(2, 2); // after
		assert.deepStrictEqual(keysOf(view, "ctrl+o"), ["ctrl+o"], "the text after the hint runs nothing");
		tui.stop();
	});

	it("does not insert a marker-only row between an exact-width key and its wrapped label (#5528)", () => {
		const wrapped = wrapTextWithAnsi(clickableKeyTextHint("esc", " close"), 3);
		assert.deepEqual(
			wrapped.map((row) => readHintSpans(row).line),
			["esc", "clo", "se"],
		);
		assert.deepEqual(wrapped.map(hintsOn), [["escape: esc"], ["escape: clo"], ["escape: se"]]);
	});

	it("wraps marked text into the same rows as unmarked text at widths 1 through 40 (#5528)", () => {
		for (const label of [
			" close",
			" choose  ",
			" to return to the current session",
			" 界e\u0301確認",
			"\n  choose\n",
			" \x1b[4munderlined text\x1b[24m",
		]) {
			for (const key of ["esc", "ctrl+f8", "↑↓", "1-4"]) {
				const plain = key + label;
				const marked = clickableKeyTextHint(key, label);
				for (let width = 1; width <= 40; width++) {
					assert.deepEqual(
						wrapTextWithAnsi(marked, width).map((row) => readHintSpans(row).line),
						wrapTextWithAnsi(plain, width),
						`${JSON.stringify(plain)} at width ${width}`,
					);
				}
			}
		}
	});

	it("marks each row of a hint wrapped at a space, broken inside a long word, or continued after a newline", () => {
		// A row is padded or bordered after it is wrapped, and the hint must end where its text does.
		const bordered = (line: string) => hintsOn(`${line}   │`);
		assert.deepStrictEqual(wrapTextWithAnsi(`${notice} after`, 40).map(bordered), [
			["ctrl+o: ctrl+o for prompt, tool calls and full"],
			["ctrl+o: result"],
		]);
		const long = wrapTextWithAnsi(`${clickableHint("x".repeat(25), keyHintAction("escape"))} after`, 10);
		assert.deepStrictEqual(long.map(bordered), [
			["escape: xxxxxxxxxx"],
			["escape: xxxxxxxxxx"],
			["escape: xxxxx"],
			[],
		]);
		const lines = wrapTextWithAnsi(`${clickableHint("esc\ncancel", keyHintAction("escape"))} after`, 40);
		assert.deepStrictEqual(lines.map(bordered), [["escape: esc"], ["escape: cancel"]]);
		// Wide characters wrap by columns, two to a character.
		const wide = wrapTextWithAnsi(`${clickableHint("确认取消对话框", keyHintAction("escape"))} 后`, 6);
		assert.deepStrictEqual(wide.map(bordered), [["escape: 确认取"], ["escape: 消对话"], ["escape: 框"]]);
		assert.strictEqual(stripTerminalSequences(readHintSpans(wide[2]!).line), "框 后");
	});

	it("ends a truncated hint where its kept text does, before the ellipsis and whatever follows", () => {
		const hint = clickableHint("esc cancel the dialog", keyHintAction("escape"));
		assert.deepStrictEqual(hintsOn(`${truncateToWidth(hint, 10, "…")} · more`), ["escape: esc cance"]);
		// A row clipped to a narrower width, as a frame drawn for the previous width is until the next one arrives.
		assert.deepStrictEqual(hintsOn(`${truncateToWidth(`${hint} after`, 12, "")}│`), ["escape: esc cancel t"]);
		const wide = clickableHint("确认取消", keyHintAction("escape"));
		assert.deepStrictEqual(hintsOn(`${truncateToWidth(wide, 6, "…", true)}│`), ["escape: 确认"]);
	});

	it("keeps a hint's action on the parts beside a box drawn over it, and not on the box", () => {
		const base = clickableHint("esc to interrupt the running turn", keyHintAction("escape"));
		const row = compositeTuiLine(base, "dialog", 4, 8, 40);
		assert.strictEqual(
			stripTerminalSequences(readHintSpans(row).line),
			`esc dialog  rupt the running turn${" ".repeat(7)}`,
		);
		assert.deepStrictEqual(hintsOn(row), ["escape: esc ", "escape: rupt the running turn"]);
	});
});

describe("keyInputData", () => {
	it("encodes a key as input that matches it", () => {
		for (const key of [
			"escape",
			"enter",
			"ctrl+o",
			"pageUp",
			"pageDown",
			"up",
			"left",
			"?",
			"x",
			"shift+tab",
			"ctrl+x",
			"ctrl+clear",
			"shift+clear",
		] as const) {
			const data = keyInputData(key);
			assert.ok(data !== undefined && matchesKey(data, key), key);
		}
	});
});
