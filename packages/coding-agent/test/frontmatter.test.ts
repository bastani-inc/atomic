import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseFrontmatter, stripFrontmatter } from "../src/utils/frontmatter.ts";

describe("parseFrontmatter", () => {
	it("parses keys, strips quotes, and returns body", () => {
		const input = "---\nname: \"skill-name\"\ndescription: 'A desc'\nfoo-bar: value\n---\n\nBody text";
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(input);
		expect(frontmatter.name).toBe("skill-name");
		expect(frontmatter.description).toBe("A desc");
		expect(frontmatter["foo-bar"]).toBe("value");
		expect(body).toBe("Body text");
	});

	it("normalizes newlines and handles CRLF", () => {
		const input = "---\r\nname: test\r\n---\r\nLine one\r\nLine two";
		const { body } = parseFrontmatter<Record<string, string>>(input);
		expect(body).toBe("Line one\nLine two");
	});

	it("throws on invalid YAML frontmatter", () => {
		const input = "---\nfoo: [bar\n---\nBody";
		expect(() => parseFrontmatter<Record<string, string>>(input)).toThrow(/at line 1, column 10/);
	});

	it("parses | multiline yaml syntax", () => {
		const input = "---\ndescription: |\n  Line one\n  Line two\n---\n\nBody";
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(input);
		expect(frontmatter.description).toBe("Line one\nLine two\n");
		expect(body).toBe("Body");
	});

	it("returns original content when frontmatter is missing or unterminated", () => {
		const noFrontmatter = "Just text\nsecond line";
		const missingEnd = "---\nname: test\nBody without terminator";
		const resultNoFrontmatter = parseFrontmatter<Record<string, string>>(noFrontmatter);
		const resultMissingEnd = parseFrontmatter<Record<string, string>>(missingEnd);
		expect(resultNoFrontmatter.body).toBe("Just text\nsecond line");
		expect(resultMissingEnd.body).toBe(
			"---\nname: test\nBody without terminator".replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
		);
	});

	it("returns empty object for empty or comment-only frontmatter", () => {
		const input = "---\n# just a comment\n---\nBody";
		const { frontmatter } = parseFrontmatter(input);
		expect(frontmatter).toEqual({});
	});

	it("matches yaml.parse identically on every bundled SKILL.md and adversarial YAML edge cases", () => {
		const skillRoots = [
			join(import.meta.dirname, "../../subagents/skills"),
			join(import.meta.dirname, "../../intercom/skills"),
		];
		const skillFiles: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (entry.name === "SKILL.md") skillFiles.push(full);
			}
		};
		for (const root of skillRoots) walk(root);
		expect(skillFiles.length).toBeGreaterThanOrEqual(20);

		for (const file of skillFiles) {
			const raw = readFileSync(file, "utf8");
			const normalized = raw
				.replace(/^\uFEFF/, "")
				.replace(/\r\n/g, "\n")
				.replace(/\r/g, "\n");
			const end = normalized.indexOf("\n---", 3);
			const yamlStr = normalized.startsWith("---") && end !== -1 ? normalized.slice(4, end) : "";
			const expected = yamlStr ? (parseYaml(yamlStr) ?? {}) : {};
			expect(parseFrontmatter(raw).frontmatter, file).toEqual(expected);
		}

		const edgeCases = [
			'---\nname: foo\ndescription: Bar with "quotes" and https://example.com and Bash(tool:*)\nhidden: true\ndisable-model-invocation: false\nmetadata:\n    author: Atomic\n    ref: refs/tags/v1.0.0\n---\nBody',
			"---\nname: foo # inline comment\n---\nBody",
			"---\nname: foo: bar\n---\nBody",
			"---\nname: trailing:\n---\nBody",
			"---\nval: null\nval2: ~\nval3: Null\nval4: True\nval5: FALSE\n---\nBody",
			"---\nnum1: 0\nnum2: 42\nnum3: -1\nnum4: +1\nnum5: 3.14\nnum6: 0x10\nnum7: .inf\nnum8: .nan\n---\nBody",
			"---\nflow: [a, b]\nmap: { k: v }\n---\nBody",
			'---\nquoted: "line1\\nline2\\"quoted\\\\slash"\n---\nBody',
			"---\nempty_nested:\nname: after-empty\n---\nBody",
			"---\nname: a\nname: b\n---\nBody",
			"---\nlist:\n  - one\n  - two\n---\nBody",
			"---\nanchor: &a val\nalias: *a\n---\nBody",
			"---\nsingle: 'hello ''world'''\n---\nBody",
			"---\nleading-dash: -item\nleading-bang: !tag val\nleading-at: @bad\n---\nBody",
			"---\nmetadata:\n    nested:\n        deep: val\n---\nBody",
			"---\nname: sha-skill\nmetadata:\n    github-tree-sha: 35a90942a7f02e1ebbc244364317954\n    short-sci: 1e50000\n    hex-pref: 0x1234abcd\n---\nBody",
			"---\nname: block-skill\ndescription: |\n  First line\n  Second line\n---\nBody",
			"---\nname: block-blank\ndescription: |\n  First line\n\n  Third line\n---\nBody",
			"---\nname: block-trailing\ndescription: |\n  Only line\n\n---\nBody",
			"---\nname: block-strip\ndescription: |-\n  No trailing newline\n---\nBody",
			// Coerced YAML 1.2 keys and coerced duplicate keys must fall back to yaml.parse
			"---\n00: a\n007: b\n010: c\n-0: d\n0o10: e\n0x10: f\n9007199254740993: g\n1e2: h\n1e50000: i\n---\nBody",
			"---\nTrue: a\nFALSE: b\nnull: c\n---\nBody",
			"---\n0x10: a\n16: b\n---\nBody",
			"---\n123: a\n0123: b\n---\nBody",
			"---\ntrue: a\nTrue: b\n---\nBody",
			"---\nnull: a\nNull: b\n---\nBody",
			"---\n-0: a\n0: b\n---\nBody",
			"---\nfoo: a\n010: b\n---\nBody",
			// Non-ASCII whitespace after literal block '|' must reject like yaml.parse
			"---\ndescription: |\u000b\n  line\n---\nBody",
			"---\ndescription: |\u000c\n  line\n---\nBody",
			"---\ndescription: |\u00a0\n  line\n---\nBody",
			"---\ndescription: |\u2028\n  line\n---\nBody",
			"---\ndescription: |\ufeff\n  line\n---\nBody",
		];
		for (const raw of edgeCases) {
			const end = raw.indexOf("\n---", 3);
			const yamlStr = raw.slice(4, end);
			let expected: unknown;
			let expectedThrew = false;
			try {
				expected = parseYaml(yamlStr) ?? {};
			} catch {
				expectedThrew = true;
			}
			if (expectedThrew) {
				expect(() => parseFrontmatter(raw), yamlStr).toThrow();
			} else {
				const actual = parseFrontmatter(raw).frontmatter;
				expect(actual, yamlStr).toEqual(expected);
				expect(Object.keys(actual), yamlStr).toEqual(Object.keys(expected as Record<string, unknown>));
			}
		}
	});
});

describe("stripFrontmatter", () => {
	it("removes frontmatter and trims body", () => {
		const input = "---\nkey: value\n---\n\nBody\n";
		expect(stripFrontmatter(input)).toBe("Body");
	});

	it("returns body when no frontmatter present", () => {
		const input = "\n  No frontmatter body  \n";
		expect(stripFrontmatter(input)).toBe("\n  No frontmatter body  \n");
	});
});
