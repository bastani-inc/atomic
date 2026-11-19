import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { WindowedContainer } from "../src/components/windowed-container.ts";
import { type Component, Container, type TuiMouseEvent } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const COLUMNS = 40;
const ROWS = 8;
const PROMPT = "\x1b]133;A\x07";
const RENDERED_PER_FRAME = 4 * 3 * ROWS;
const SWEEP_WAIT_MS = 5_000;

class Entry implements Component {
	renders = 0;
	mouseRows: number[] = [];
	readonly name: string;
	height: number;
	readonly prompt: boolean;
	constructor(name: string, height: number, prompt: boolean) {
		this.name = name;
		this.height = height;
		this.prompt = prompt;
	}
	render(_width: number): string[] {
		this.renders++;
		return Array.from(
			{ length: this.height },
			(_, row) => `${row === 0 && this.prompt ? PROMPT : ""}${this.name} row ${row}`,
		);
	}
	handleMouse(event: TuiMouseEvent) {
		if (event.type !== "press") return undefined;
		this.mouseRows.push(event.y);
		return { handled: true };
	}
	invalidate(): void {}
}

function entries(count: number): Entry[] {
	return Array.from({ length: count }, (_, index) => new Entry(`entry ${index}`, 1 + (index % 4), index % 5 === 0));
}

interface Session {
	readonly terminal: VirtualTerminal;
	readonly tui: TuiAltScreen;
	readonly transcript: ScrollView;
}

function open(content: Container, children: readonly Component[]): Session {
	for (const child of children) content.addChild(child);
	const terminal = new VirtualTerminal(COLUMNS, ROWS);
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
	const transcript = new ScrollView(content, { follow: "end", primary: true });
	tui.setLayoutRoot(transcript);
	tui.start();
	return { terminal, tui, transcript };
}

async function screen(session: Session): Promise<string[]> {
	session.tui.renderNow();
	await session.terminal.flush();
	return session.terminal.getViewport();
}

async function settle(): Promise<void> {
	for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve));
}

describe("WindowedContainer in a scroll view", () => {
	it("returns hit geometry without exposing the renderer’s rows (#5696)", () => {
		const lines = ["Pending"];
		const child = { render: () => lines, invalidate() {} };
		const window = new WindowedContainer();
		window.addChild(child);
		const request = { width: COLUMNS, top: 0, height: ROWS, followEnd: false, requestRender() {} };
		window.layoutWindow(request);
		const hit = window.childAtRow(COLUMNS, 0);
		assert.ok(hit);
		assert.deepEqual(Reflect.ownKeys(hit).sort(), ["component", "height", "row"]);
		const { component, ...geometry } = hit;
		assert.equal(component, child);
		assert.deepEqual(geometry, { row: 0, height: 1 });
		for (const value of Object.values(geometry)) Object.freeze(value);
		lines.push("Delivered");
		assert.equal(window.layoutWindow(request).at(1), "Delivered");
	});
	it("scrolls to the requested row after offscreen heights replace their estimates", () => {
		const content = new WindowedContainer();
		for (const child of entries(200)) content.addChild(child);
		const request = { width: COLUMNS, height: ROWS, followEnd: false, requestRender() {} };
		content.layoutWindow({ ...request, top: 0 });
		content.settleRows();
		const rows = content.layoutWindow({ ...request, top: 300 });
		assert.equal(rows.top, 300);
		assert.equal(rows.at(rows.top), `${PROMPT}entry 120 row 0`);
	});

	it("shows the rows a container of the same children shows, at the end, the top and in between", async () => {
		const windowed = open(new WindowedContainer(), entries(200));
		const plain = open(new Container(), entries(200));
		try {
			assert.deepEqual(await screen(windowed), await screen(plain));
			for (const session of [windowed, plain]) session.tui.scrollToTop();
			assert.deepEqual(await screen(windowed), await screen(plain));
			for (const session of [windowed, plain]) session.tui.scrollBy(ROWS + 3);
			assert.deepEqual(await screen(windowed), await screen(plain));
			await settle();
			for (const session of [windowed, plain]) session.transcript.scrollTo(300);
			assert.deepEqual(await screen(windowed), await screen(plain));
		} finally {
			windowed.tui.stop();
			plain.tui.stop();
		}
	});

	it("renders the children a frame shows, and the others in the background", async () => {
		const children = entries(500);
		const session = open(new WindowedContainer(), children);
		try {
			session.tui.renderNow();
			const rendered = children.filter((child) => child.renders > 0).length;
			assert.ok(rendered <= RENDERED_PER_FRAME, `the first frame rendered ${rendered} children`);
			await settle();
			assert.ok(children.every((child) => child.renders > 0));
			for (const child of children) child.renders = 0;
			session.tui.scrollBy(-ROWS);
			session.tui.renderNow();
			const rerendered = children.filter((child) => child.renders > 0).length;
			assert.ok(rerendered <= RENDERED_PER_FRAME, `a frame after the first rendered ${rerendered} children`);
		} finally {
			session.tui.stop();
		}
	});

	it("keeps the content at the top in place while children above it change height", async () => {
		const children = entries(200);
		const session = open(new WindowedContainer(), children);
		try {
			await screen(session);
			await settle();
			session.transcript.scrollTo(150);
			const before = await screen(session);
			children[3]!.height += 5;
			children[10]!.height = 0;
			session.tui.invalidate();
			assert.deepEqual(await screen(session), before);
			await settle();
			assert.deepEqual(await screen(session), before);
		} finally {
			session.tui.stop();
		}
	});

	it("finds a child that changed height off screen without being invalidated", async () => {
		const children = entries(100);
		const session = open(new WindowedContainer(), children);
		try {
			await screen(session);
			await settle();
			const before = session.transcript.viewportHeight;
			assert.equal(before, ROWS);
			session.tui.scrollToTop();
			session.transcript.scrollTo(Number.MAX_SAFE_INTEGER);
			await screen(session);
			const end = session.transcript.scrollTop;
			session.tui.scrollToTop();
			await screen(session);
			children[90]!.height += 30;
			const deadline = Date.now() + SWEEP_WAIT_MS;
			for (;;) {
				await new Promise((resolve) => setTimeout(resolve, 20));
				session.transcript.scrollTo(Number.MAX_SAFE_INTEGER);
				await screen(session);
				if (session.transcript.scrollTop === end + 30 || Date.now() > deadline) break;
				session.tui.scrollToTop();
			}
			assert.equal(session.transcript.scrollTop, end + 30);
		} finally {
			session.tui.stop();
		}
	});

	it("sends a mouse press to the child under the pointer, at its own row", async () => {
		const children = entries(100);
		const session = open(new WindowedContainer(), children);
		try {
			const rows = await screen(session);
			const row = rows.findIndex((line) => line.startsWith("entry 97 row 1"));
			assert.ok(row >= 0);
			session.terminal.sendInput(`\x1b[<0;3;${row + 1}M`);
			session.terminal.sendInput(`\x1b[<0;3;${row + 1}m`);
			await screen(session);
			assert.deepEqual(children[97]!.mouseRows, [1]);
		} finally {
			session.tui.stop();
		}
	});

	it("lets a nested windowed container that handles the mouse see the press first, at its own rows as painted", async () => {
		class Nested extends WindowedContainer {
			readonly seen: Array<{ row: number; child: Component | undefined; childRow: number | undefined }> = [];
			override handleMouse(event: TuiMouseEvent) {
				if (event.type === "press") {
					const hit = this.childAtRow(event.width, event.y);
					this.seen.push({ row: event.y, child: hit?.component, childRow: hit?.row });
				}
				return super.handleMouse(event);
			}
		}
		const before = entries(40);
		const nestedChildren = entries(60);
		const nested = new Nested();
		for (const child of nestedChildren) nested.addChild(child);
		const session = open(new WindowedContainer(), [...before, nested]);
		try {
			const rows = await screen(session);
			const row = rows.findIndex((line) => line.startsWith("entry 57 row 1"));
			assert.ok(row >= 0, rows.join("\n"));
			session.terminal.sendInput(`\x1b[<0;3;${row + 1}M`);
			session.terminal.sendInput(`\x1b[<0;3;${row + 1}m`);
			await screen(session);
			// Its row counts the rows laid out before the child, which may still be estimates for children not rendered.
			assert.equal(nested.seen.length, 1);
			assert.equal(nested.seen[0]!.child, nestedChildren[57]);
			assert.equal(nested.seen[0]!.childRow, 1);
			assert.deepEqual(nestedChildren[57]!.mouseRows, [1]);
			assert.deepEqual(
				before.flatMap((child) => child.mouseRows),
				[],
			);
		} finally {
			session.tui.stop();
		}
	});

	it("searches and jumps between prompts in children not rendered yet", async () => {
		const children = entries(400);
		const session = open(new WindowedContainer(), children);
		try {
			await screen(session);
			session.terminal.sendInput("\x1b[102;6u");
			session.terminal.sendInput("entry 3 row 2");
			const found = await screen(session);
			assert.ok(
				found.some((line) => line.includes("1/1")) && found[0]?.startsWith("entry 3 row 0"),
				found.join("\n"),
			);
			session.terminal.sendInput("\x1b");
			session.tui.scrollToTop();
			await screen(session);
			session.terminal.sendInput("\x1b[1;5B");
			const jumped = await screen(session);
			assert.ok(jumped[0]?.startsWith("entry 5 row 0"), jumped.join("\n"));
		} finally {
			session.tui.stop();
		}
	});
});
