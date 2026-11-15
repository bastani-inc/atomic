import { Container } from "@bastani/atomic-tui";
import { afterEach, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { renderDiagnosticStatus } from "../src/modes/interactive-engine/engine-diagnostic-view.js";
import { convertBufferWithMarkit, setMarkitDiagnosticSink } from "../src/utils/markit.js";

const fixture = vi.hoisted(() => ({ lines: [] as string[], markdown: "converted" }));
vi.mock("markit-ai", () => ({
	Markit: class {
		async convert() {
			const module = (
				globalThis as typeof globalThis & {
					$libmupdf_wasm_Module: { printErr(line: string): void };
				}
			).$libmupdf_wasm_Module;
			for (const line of fixture.lines) module.printErr(line);
			return { markdown: fixture.markdown };
		}
	},
}));

afterEach(() => vi.restoreAllMocks());

// Regression #2964: even successful conversions must surface bounded diagnostics.
test("bounds diagnostic count and oversized lines, and clears them between conversions", async () => {
	fixture.lines = Array.from({ length: 40 }, (_, i) => `${i}: ${"x".repeat(5000)}`);
	const messages: string[] = [];
	const dispose = setMarkitDiagnosticSink((message) => messages.push(message));
	try {
		expect(await convertBufferWithMarkit(new Uint8Array(), ".pdf")).toEqual({ content: "converted", ok: true });
		expect(messages).toHaveLength(1);
		const lines = messages[0]!.split("\n");
		expect(lines).toHaveLength(32);
		expect(lines[0]).toMatch(/^8: /);
		expect(lines.at(-1)).toMatch(/^39: /);
		expect(lines.every((line) => line.length === 4096)).toBe(true);
		fixture.lines = [];
		await convertBufferWithMarkit(new Uint8Array(), ".pdf");
		expect(messages).toHaveLength(1);
		fixture.lines = ["  verbatim  ", "  verbatim  ", ""];
		await convertBufferWithMarkit(new Uint8Array(), ".pdf");
		expect(messages[1]).toBe("  verbatim  \n  verbatim  \n");
	} finally {
		dispose();
	}
});

// Regression #2965: in-process presentation must not sanitize the stored failure suffix.
test("displays MuPDF controls inertly while retaining raw failure diagnostics", async () => {
	initTheme("dark");
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
	Object.assign(mode, { chatContainer: new Container(), ui: { requestRender: vi.fn() } });
	const line = "  MUPDF_BEFORE\x1b[2J\x1b[1;1HMUPDF_AFTER\x07\r\x9b2J  ";
	fixture.lines = [line, line, ""];
	fixture.markdown = "";
	const raw: string[] = [];
	const showStatus = vi.fn(mode.showStatus.bind(mode));
	const dispose = setMarkitDiagnosticSink((message) => {
		raw.push(message);
		renderDiagnosticStatus(message, { showStatus });
	});
	try {
		const result = await convertBufferWithMarkit(new Uint8Array(), ".pdf");
		expect(result).toEqual({
			content: "",
			ok: false,
			error: `Conversion produced no output (mupdf: ${line}; ${line}; )`,
		});
		expect(raw).toEqual([`${line}\n${line}\n`]);
		expect(showStatus.mock.calls[0]![0]).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
		const rendered = mode.chatContainer.render(120).join("\n");
		expect(rendered).not.toContain("\x1b[2J");
		expect(rendered.match(/MUPDF_BEFOREMUPDF_AFTER/g)).toHaveLength(2);
	} finally {
		dispose();
		fixture.markdown = "converted";
		fixture.lines = [];
	}
});

// Regression #2965: CSI must not consume printable text up to a later BEL (Node 26).
test.each([
	["\x1b[2J\x1b[1;1HAFTER\x07", "AFTER "],
	["\x9b2JAFTER", "AFTER"],
	["\x1b]0;hidden title\x07AFTER", "AFTER"],
	["\x1b]0;hidden title\x1b\\AFTER", "AFTER"],
])("preserves diagnostic text around terminal controls %j", (input, expected) => {
	const showStatus = vi.fn();
	renderDiagnosticStatus(`BEFORE${input}`, { showStatus });
	expect(showStatus).toHaveBeenCalledExactlyOnceWith(`BEFORE${expected}`, true);
});
