import { describe, expect, it } from "vitest";
import { escapeTerminalControls, hasTerminalControls, stripAnsi } from "../src/utils/ansi.ts";

function referenceAnsiRegex(): RegExp {
	const ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
	const osc = `(?:\\u001B\\][\\s\\S]*?${ST})`;
	const csi = "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";
	return new RegExp(`${osc}|${csi}`, "g");
}

const referenceRegex = referenceAnsiRegex();

function referenceStripAnsi(value: string): string {
	if (!value.includes("\u001B") && !value.includes("\u009B")) {
		return value;
	}
	return value.replace(referenceRegex, "");
}

function getCompatibilityInputs(): string[] {
	const inputs = [
		"plain",
		"a\x1b[31mred\x1b[0mz",
		"a\x1b]8;;https://example.com\x07link\x1b]8;;\x07z",
		"a\x1b]unterminated",
		"a\x1b]funterminated",
		"a\x1bPabc\x1b\\z",
		"a\x1b^abc\x07z",
		"a\x1b_abc\x9cz",
		"a\x90abc\x9cz",
		"a\x9dabc\x9cz",
		"a\x9b31mred",
		"a\x1b(0x",
		"a\x1b*0x",
		"a\x1b+c",
		"a\x1b/0x",
		"a\x1bcok",
		"a\x1b\\ok",
	];
	const chars = [
		"a",
		"f",
		"0",
		"1",
		";",
		":",
		"[",
		"]",
		"(",
		")",
		"#",
		"?",
		"m",
		"P",
		"_",
		"\\",
		"\x07",
		"\x1b",
		"\x9b",
		"\x9c",
		"\x90",
		"\x9d",
	];

	for (const char of chars) {
		inputs.push(`x\x1b${char}y`);
		inputs.push(`x\x9b${char}y`);
		for (let index = 0; index < chars.length; index += 3) {
			inputs.push(`x\x1b${char}${chars[index]}y`);
		}
	}

	return inputs;
}

describe("stripAnsi", () => {
	it("matches chalk strip-ansi for generated compatibility inputs", () => {
		for (const input of getCompatibilityInputs()) {
			expect(stripAnsi(input)).toBe(referenceStripAnsi(input));
		}
	});

	it("bounds CPU work for repeated unterminated OSC while preserving ANSI fallback", () => {
		// PR #2700: use CPU, not wall time, with ample headroom for loaded runners.
		const OSC_CPU_BUDGET_US = 1_000_000;
		const value = `${"\x1b]".repeat(160_000)}! tail\x1b[31mred`;
		const start = process.cpuUsage();
		const output = stripAnsi(value);
		const cpu = process.cpuUsage(start);
		expect(cpu.user + cpu.system).toBeLessThan(OSC_CPU_BUDGET_US);
		expect(output).toBe(`${"\x1b]".repeat(160_000)}! tailred`);
	});

	it("preserves OSC/CSI ordering and fallback on both sides of the final terminator", () => {
		// PR #2700: removing OSC in a separate pass could create new CSI matches.
		for (const end of ["\x07", "\x1b\\", "\x9c"]) {
			for (const input of getCompatibilityInputs()) {
				for (const value of [
					`${input}${end}\x1b]! unfinished`,
					`\x1b[\x1b]hidden${end}31m${input}`,
					`${input}\x1b]hidden${end}\x1b[38:2:1:2:3mtext\x9b0m`,
				]) {
					expect(stripAnsi(value)).toBe(referenceStripAnsi(value));
				}
			}
		}
	});

	it("throws the same TypeError as chalk strip-ansi for non-string values", () => {
		const stripAnsiUnknown = stripAnsi as (value: unknown) => string;

		for (const value of [undefined, null, 123, {}, Object("x")]) {
			const message = `Expected a \`string\`, got \`${typeof value}\``;
			expect(() => stripAnsiUnknown(value)).toThrow(TypeError);
			expect(() => stripAnsiUnknown(value)).toThrow(message);
		}
	});

	it("strips RIS without leaking the final byte", () => {
		expect(stripAnsi("\x1bcdone")).toBe("done");
	});

	it("strips single-byte ESC sequences without leaking final bytes", () => {
		for (let code = "g".charCodeAt(0); code <= "m".charCodeAt(0); code++) {
			expect(stripAnsi(`\x1b${String.fromCharCode(code)}ok`)).toBe("ok");
		}
		for (let code = "r".charCodeAt(0); code <= "t".charCodeAt(0); code++) {
			expect(stripAnsi(`\x1b${String.fromCharCode(code)}ok`)).toBe("ok");
		}
	});

	it("strips common ANSI sequences used in tool output", () => {
		const input = "a\x1b[31mred\x1b[0m\x1b]8;;https://example.com\x07link\x1b]8;;\x07z";
		expect(stripAnsi(input)).toBe("aredlinkz");
	});
});

describe("escapeTerminalControls", () => {
	it("renders C0/DEL/C1 as \\xNN, keeps LF, and maps tab to \\x09 without tabWidth", () => {
		expect(escapeTerminalControls("a\x00b\x07c\x1bd\x7fe\x9bf\ng")).toBe("a\\x00b\\x07c\\x1bd\\x7fe\\x9bf\ng");
		expect(escapeTerminalControls("a\tb")).toBe("a\\x09b");
	});

	it("expands tabs to the next stop and resets the column on LF when tabWidth is set", () => {
		expect(escapeTerminalControls("a\tb", { tabWidth: 4 })).toBe("a   b");
		expect(escapeTerminalControls("ab\nc\td", { tabWidth: 4 })).toBe("ab\nc   d");
	});

	it("hasTerminalControls is true for tab and \\x9b, false for LF and plain text", () => {
		expect(hasTerminalControls("\t")).toBe(true);
		expect(hasTerminalControls("\x9b")).toBe(true);
		expect(hasTerminalControls("\n")).toBe(false);
		expect(hasTerminalControls("plain")).toBe(false);
	});
});
