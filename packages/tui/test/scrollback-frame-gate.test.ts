import assert from "node:assert";
import { describe, it } from "node:test";
import v8 from "node:v8";
import vm from "node:vm";
import type { Terminal } from "../src/terminal.ts";
import { type Component, Container, CURSOR_MARKER } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";

v8.setFlagsFromString("--expose-gc");
const collectGarbage = vm.runInNewContext("gc") as () => void;

/** Every byte and cursor call in the order the renderer issued them. */
class RecordingTerminal implements Terminal {
	readonly output: string[] = [];
	columns = 80;
	rows = 12;
	readonly kittyProtocolActive = false;
	start(): void {}
	stop(): void {
		this.output.push("<stop>");
	}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.output.push(data);
	}
	moveBy(): void {}
	hideCursor(): void {
		this.output.push("<hide>");
	}
	showCursor(): void {
		this.output.push("<show>");
	}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}
	get text(): string {
		return this.output.join("");
	}
}

class Row implements Component {
	failure: Error | undefined;
	private readonly name: string;
	private readonly log: string[];
	lines: string[];
	constructor(name: string, log: string[], lines: string[]) {
		this.name = name;
		this.log = log;
		this.lines = lines;
	}
	render(): string[] {
		this.log.push(this.name);
		if (this.failure) throw this.failure;
		return this.lines;
	}
	invalidate(): void {}
}

/** A transcript nested in a document above the editor, as the interactive main-screen renderer mounts it. */
function scene() {
	const terminal = new RecordingTerminal();
	const tui = new TuiMainScreen(terminal);
	const log: string[] = [];
	const row = (name: string, ...lines: string[]) => new Row(name, log, lines);
	const chat = new Container();
	const prompt = row("prompt", "> the question");
	const reply = row("reply", "the answer");
	chat.addChild(prompt);
	chat.addChild(reply);
	const document = new Container();
	document.addChild(row("header", "Atomic"));
	document.addChild(chat);
	const editor = row("editor", `> ${CURSOR_MARKER}`);
	tui.addChild(document);
	tui.addChild(editor);
	return { terminal, tui, log, chat, prompt, reply, editor, row };
}

const saved = (view: ReturnType<typeof scene>) => () =>
	view.chat.children.splice(1, 0, view.row("saved", "saved diagnostic"));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("regular scrollback frame gate (#5649)", () => {
	it("holds the frame that draws the gated rows and writes it once with the late rows, without rendering it again", () => {
		const main = scene();
		const gated = scene();
		// The rows the lookup answers with, drawn from the start: the frame the gate must write.
		const decorated = scene();
		saved(decorated)();
		const gate = gated.tui.gateScrollbackFrame?.(gated.chat, { timeoutMs: 1_000 });
		assert.ok(gate, "the main-screen renderer offers the gate");

		main.tui.renderNow();
		gated.tui.renderNow();
		decorated.tui.renderNow();

		assert.deepStrictEqual(gated.log, main.log, "renderers run at main's instant");
		assert.strictEqual(gated.terminal.text, "", "the frame waits for the lookup");
		gate.settle(saved(gated));
		assert.strictEqual(gated.terminal.text, decorated.terminal.text);
		assert.deepStrictEqual(gated.log, [...main.log, "saved"], "only the new row renders; nothing is replayed");
	});

	it("writes frames that do not draw the gated rows as main does, and holds the first one that does", () => {
		const main = scene();
		const gated = scene();
		// Startup output still withheld: the transcript draws no rows yet.
		const withheld = (view: ReturnType<typeof scene>) => view.chat.children.splice(0);
		const mainRows = withheld(main);
		const gatedRows = withheld(gated);
		const gate = gated.tui.gateScrollbackFrame?.(gated.chat, { timeoutMs: 1_000 });
		assert.ok(gate);

		main.tui.renderNow();
		gated.tui.renderNow();
		assert.strictEqual(gated.terminal.text, main.terminal.text);

		const written = gated.terminal.output.length;
		main.chat.children.push(...mainRows);
		gated.chat.children.push(...gatedRows);
		main.tui.renderNow();
		gated.tui.renderNow();
		assert.strictEqual(gated.terminal.output.length, written, "the frame that draws the transcript is held");
		gate.release();
		assert.strictEqual(gated.terminal.text, main.terminal.text);
		assert.deepStrictEqual(gated.log, main.log);
	});

	it("writes a frame over 64 KiB at main's instant, byte for byte, and ignores the late lookup", () => {
		const main = scene();
		const gated = scene();
		const rows = Array.from({ length: 1_000 }, (_, index) => `${index} `.padEnd(70, "x"));
		main.reply.lines = rows;
		gated.reply.lines = rows;
		let released = 0;
		const gate = gated.tui.gateScrollbackFrame?.(gated.chat, {
			timeoutMs: 1_000,
			onRelease: () => released++,
		});
		assert.ok(gate);

		main.tui.renderNow();
		gated.tui.renderNow();

		assert.ok(main.terminal.text.length > 64 * 1024);
		assert.strictEqual(gated.terminal.text, main.terminal.text);
		assert.strictEqual(released, 1);
		let late = false;
		gate.settle(() => {
			late = true;
		});
		assert.strictEqual(late, false, "late side rows wait for a later redraw");
		assert.strictEqual(gated.terminal.text, main.terminal.text);
		assert.deepStrictEqual(gated.log, main.log);
	});

	it("writes main's frame when the lookup takes longer than 100 ms", async () => {
		const main = scene();
		const gated = scene();
		let released = 0;
		const gate = gated.tui.gateScrollbackFrame?.(gated.chat, { timeoutMs: 100, onRelease: () => released++ });
		assert.ok(gate);

		main.tui.renderNow();
		gated.tui.renderNow();
		// A timer never fires before its deadline, so the hold is still in place here.
		await delay(50);
		assert.strictEqual(gated.terminal.text, "");
		await delay(100);

		assert.strictEqual(gated.terminal.text, main.terminal.text);
		assert.strictEqual(released, 1);
		let late = false;
		gate.settle(() => {
			late = true;
		});
		assert.strictEqual(late, false);
		assert.strictEqual(gated.terminal.text, main.terminal.text);
	});

	it("runs renderers as often and in the order main does, and an update mid-lookup is written after the held frame", () => {
		const main = scene();
		const gated = scene();
		const gate = gated.tui.gateScrollbackFrame?.(gated.chat, { timeoutMs: 1_000 });
		assert.ok(gate);
		const steps: Array<(view: ReturnType<typeof scene>) => void> = [
			(view) => view.tui.renderNow(),
			// A tool row and a keystroke arrive while the lookup is outstanding.
			(view) => {
				view.chat.addChild(view.row("tool", "tool output"));
				view.editor.lines = [`> typed${CURSOR_MARKER}`];
				view.tui.renderNow();
			},
			(view) => view.tui.renderNow(),
		];
		for (const [index, step] of steps.entries()) {
			step(main);
			step(gated);
			assert.deepStrictEqual(gated.log, main.log, `renderers after step ${index}`);
		}
		assert.strictEqual(gated.terminal.text, main.terminal.text);
		let late = false;
		gate.settle(() => {
			late = true;
		});
		assert.strictEqual(late, false);
	});

	it("keeps holding through a frame identical to the held one, which still renders", () => {
		const main = scene();
		const gated = scene();
		const decorated = scene();
		saved(decorated)();
		const gate = gated.tui.gateScrollbackFrame?.(gated.chat, { timeoutMs: 1_000 });
		assert.ok(gate);
		for (const view of [main, gated, main, gated]) view.tui.renderNow();
		decorated.tui.renderNow();

		assert.deepStrictEqual(gated.log, main.log);
		assert.strictEqual(gated.terminal.text, "");
		gate.settle(saved(gated));
		assert.strictEqual(gated.terminal.text, decorated.terminal.text);
	});

	it("lets a renderer's throw escape the same frame as on main, with the held frame already written", () => {
		const main = scene();
		const gated = scene();
		const gate = gated.tui.gateScrollbackFrame?.(gated.chat, { timeoutMs: 1_000 });
		assert.ok(gate);
		main.tui.renderNow();
		gated.tui.renderNow();
		const failure = new Error("renderer failed");
		main.reply.failure = failure;
		gated.reply.failure = failure;

		assert.throws(() => main.tui.renderNow(), failure);
		assert.throws(() => gated.tui.renderNow(), failure);

		assert.deepStrictEqual(gated.log, main.log);
		assert.strictEqual(gated.terminal.text, main.terminal.text);
	});

	it("writes the held frame as main did when the view switches, the renderer stops, or a full redraw is forced", async () => {
		for (const end of [
			(view: ReturnType<typeof scene>) => view.tui.gateScrollbackFrame?.(view.chat, { timeoutMs: 1_000 }),
			(view: ReturnType<typeof scene>) => view.tui.stop(),
			async (view: ReturnType<typeof scene>) => {
				view.tui.requestRender(true);
				await new Promise((resolve) => process.nextTick(resolve));
			},
		]) {
			const main = scene();
			const gated = scene();
			let released = 0;
			const gate = gated.tui.gateScrollbackFrame?.(gated.chat, { timeoutMs: 1_000, onRelease: () => released++ });
			assert.ok(gate);
			main.tui.renderNow();
			gated.tui.renderNow();
			await end(main);
			await end(gated);
			assert.strictEqual(gated.terminal.text, main.terminal.text);
			assert.deepStrictEqual(gated.log, main.log);
			assert.strictEqual(released, 1);
			gated.tui.stop();
		}
	});

	it("retains neither the gated rows nor the lookup once released", async () => {
		const collected = new Set<string>();
		const registry = new FinalizationRegistry<string>((name) => collected.add(name));
		const terminal = new RecordingTerminal();
		const tui = new TuiMainScreen(terminal);
		const log: string[] = [];
		// The owner keeps its handle, as a lookup that never answers keeps its receiver.
		const gates: unknown[] = [];
		const mount = (name: string): Container => {
			const transcript = new Container();
			const row = new Row(name, log, [`${name} row`]);
			transcript.addChild(row);
			registry.register(transcript, `${name} container`);
			registry.register(row, `${name} row`);
			tui.addChild(transcript);
			return transcript;
		};
		const arm = (name: string, transcript: Container, timeoutMs: number) => {
			const lookup = { name };
			registry.register(lookup, `${name} lookup`);
			const gate = tui.gateScrollbackFrame?.(transcript, { timeoutMs, onRelease: () => void lookup.name });
			assert.ok(gate);
			gates.push(gate);
			return gate;
		};
		const ends: Record<string, (gate: NonNullable<ReturnType<typeof arm>>, transcript: Container) => Promise<void>> =
			{
				timeout: () => delay(30),
				release: async (gate) => gate.release(),
				settle: async (gate, transcript) =>
					gate.settle(() => transcript.addChild(new Row("saved", log, ["saved"]))),
			};
		// Each case runs in its own frame: a suspended async frame can keep its last locals alive.
		const run = async (name: string, end: (typeof ends)[string]) => {
			const transcript = mount(name);
			const gate = arm(name, transcript, name === "timeout" ? 10 : 1_000);
			tui.renderNow();
			await end(gate, transcript);
			assert.match(terminal.text, new RegExp(`${name} row`));
			tui.removeChild(transcript);
			tui.renderNow();
		};
		for (const [name, end] of Object.entries(ends)) await run(name, end);
		const expected = Object.keys(ends).flatMap((name) => [`${name} container`, `${name} lookup`, `${name} row`]);
		for (let round = 0; round < 20 && collected.size < expected.length; round++) {
			collectGarbage();
			await delay(10);
		}
		assert.deepStrictEqual([...collected].sort(), expected.sort());
		assert.strictEqual(gates.length, 3);
		tui.stop();
	});

	it("holds nothing in fullscreen", () => {
		const fullscreen = new TuiAltScreen(new RecordingTerminal());
		assert.strictEqual(fullscreen.gateScrollbackFrame, undefined);
	});
});
