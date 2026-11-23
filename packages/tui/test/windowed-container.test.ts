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

	it("scrolls from the rows it showed when children above them were added or removed before the next frame", async () => {
		const line = (n: number) => new Entry(`line ${n}`, 1, false);
		const content = new WindowedContainer();
		const session = open(
			content,
			Array.from({ length: 100 }, (_, n) => line(n)),
		);
		const top = async () => (await screen(session))[0]!.trim();
		try {
			await screen(session);
			session.tui.scrollToTop();
			await screen(session);
			session.tui.scrollBy(40);
			assert.equal(await top(), "line 40 row 0");
			// An older page is mounted above, then the wheel moves three rows before the next frame.
			content.children.splice(0, 0, ...Array.from({ length: 10 }, (_, n) => line(-10 + n)));
			session.tui.scrollBy(3);
			assert.equal(await top(), "line 43 row 0");
			// A page above is released, then the wheel moves on.
			content.children.splice(0, 30);
			session.tui.scrollBy(3);
			session.tui.scrollBy(3);
			assert.equal(await top(), "line 49 row 0");
			// A jump to a row is not moved by the rows above it.
			content.children.splice(0, 5);
			session.transcript.scrollTo(0);
			assert.equal(await top(), "line 25 row 0");
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

	it("bounds first-frame and top-jump renders by real row height rather than stale 1-row estimates", async () => {
		const tallRows = 36;
		const makeTall = () => Array.from({ length: 128 }, (_, index) => new Entry(`tall ${index}`, 12, index % 4 === 0));
		const windowedChildren = makeTall();
		const plainChildren = makeTall();
		const openTall = (container: Container, list: readonly Component[]) => {
			for (const child of list) container.addChild(child);
			const terminal = new VirtualTerminal(COLUMNS, tallRows);
			const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
			const transcript = new ScrollView(container, { follow: "end", primary: true });
			tui.setLayoutRoot(transcript);
			tui.start();
			return { terminal, tui, transcript };
		};
		const windowed = openTall(new WindowedContainer(), windowedChildren);
		const plain = openTall(new Container(), plainChildren);
		try {
			// First frame at bottom (followEnd = true): 36 visible rows = 3 entries of height 12.
			// Measure synchronously right after renderNow(), before background sweepSlice runs on setImmediate.
			windowed.tui.renderNow();
			const renderedBottom = windowedChildren.filter((child) => child.renders > 0).length;
			assert.ok(
				renderedBottom <= 10,
				`first frame at bottom rendered ${renderedBottom} tall children (expected <= 10)`,
			);
			await windowed.terminal.flush();
			const bottomWindowed = windowed.terminal.getViewport();
			const bottomPlain = await screen(plain);
			assert.deepEqual(bottomWindowed, bottomPlain);

			// Jump to top (followEnd = false) onto unmeasured tall children: also bounded by real height.
			for (const child of windowedChildren) child.renders = 0;
			windowed.tui.scrollToTop();
			plain.tui.scrollToTop();
			windowed.tui.renderNow();
			const renderedTop = windowedChildren.filter((child) => child.renders > 0).length;
			assert.ok(renderedTop <= 10, `top jump rendered ${renderedTop} tall children (expected <= 10)`);
			await windowed.terminal.flush();
			const topWindowed = windowed.terminal.getViewport();
			const topPlain = await screen(plain);
			assert.deepEqual(topWindowed, topPlain);
		} finally {
			windowed.tui.stop();
			plain.tui.stop();
		}
	});

	it("covers every visible row when non-followEnd entries near the bottom shrink below their estimates", async () => {
		// Seed a large height estimate (20) from the first rendered entry, then add 20 entries that actually render 1 row.
		const children = [
			new Entry("tall 0", 20, true),
			...Array.from({ length: 20 }, (_, i) => new Entry(`short ${i + 1}`, 1, false)),
		];
		const content = new WindowedContainer();
		for (const child of children) content.addChild(child);
		const request = { width: COLUMNS, height: ROWS, followEnd: false, requestRender() {} };
		// Measure tall 0 at top so estimated height is 20.
		content.layoutWindow({ ...request, top: 0 });
		// Now jump near the estimated bottom (non-followEnd, exact) where entries shrink from 20 -> 1.
		const layout = content.layoutWindow({ ...request, top: 380, exact: true });
		for (let r = layout.top; r < Math.min(layout.length, layout.top + ROWS); r++) {
			const line = layout.at(r);
			assert.ok(
				line !== undefined && line.length > 0,
				`visible row ${r} was blank (top=${layout.top}, len=${layout.length})`,
			);
		}
	});
});
