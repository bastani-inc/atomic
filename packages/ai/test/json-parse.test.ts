import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { parseStreamingJson, parseToolCallArguments } from "../src/utils/json-parse.js";

describe("parseStreamingJson", () => {
	it("preserves __proto__ as an own data property in partial JSON (#3679)", () => {
		const input = '{"__proto__":{"polluted":true}';
		const parsed = parseStreamingJson(input);
		assert.deepEqual(parsed, JSON.parse(`${input}}`));
		assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
		assert.equal(Object.hasOwn(parsed, "__proto__"), true);
		assert.deepEqual(Object.keys(parsed), ["__proto__"]);
		assert.equal(parsed.polluted, undefined);
		assert.equal(JSON.stringify(parsed), `${input}}`);
		assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
	});

	it("preserves prototype-like keys at every depth and in arrays (#3679)", () => {
		for (const complete of [
			'{"__proto__":null}',
			'{"__proto__":42}',
			'{"__proto__":{"first":true},"__proto__":{"last":true}}',
			String.raw`{"\u005f_proto__":{"polluted":true},"___proto__":"distinct","":"empty"}`,
			String.raw`{"_proto__":{"safe":true},"\u005fproto__":{"last":true},"$__proto__":"distinct","$":"prefix"}`,
			'{"nested":{"__proto__":{"__proto__":{"polluted":true}}},"constructor":{"prototype":{"ok":true}},"prototype":"data"}',
			'[{"__proto__":[{"__proto__":{"polluted":true}}]}, {"constructor":"data","prototype":"data"}]',
			String.raw`{"__proto__":"__proto__","text":"a \\\"__proto__\\\" : b","slash":"\\","unicode":"\u00e9"}`,
		]) {
			const expected = JSON.parse(complete);
			for (const input of [complete, complete.slice(0, -1)]) {
				const parsed = parseStreamingJson(input);
				assert.deepEqual(parsed, expected, input);
				assert.equal(Object.getPrototypeOf(parsed), Array.isArray(expected) ? Array.prototype : Object.prototype);
				assert.equal(JSON.stringify(parsed), JSON.stringify(expected), input);
			}
		}
	});

	it("preserves __proto__ while repairing malformed JSON strings (#3679)", () => {
		const input = String.raw`{"__proto__":{"text":"\url"},"nested":[{"__proto__":null}]}`;
		const parsed = parseStreamingJson(input);
		const expected = JSON.parse(String.raw`{"__proto__":{"text":"\\url"},"nested":[{"__proto__":null}]}`);
		assert.deepEqual(parsed, expected);
		assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
		assert.equal(JSON.stringify(parsed), JSON.stringify(expected));
	});

	it("retains partial string contents through the repair retry (#3679)", () => {
		assert.equal(parseStreamingJson(String.raw`"\x" trailing`), "\\x");
		assert.deepEqual(parseStreamingJson('{"__proto__":"trailing\\'), JSON.parse('{"__proto__":"trailing"}'));
	});

	it("keeps invalid \\u escapes as literal text without dropping fields (#10868)", () => {
		assert.deepEqual(parseStreamingJson(String.raw`{"text":"\url{x}"}`), { text: "\\url{x}" });
		assert.deepEqual(parseStreamingJson(String.raw`{"path":"a.tex","content":"\usepackage{x}","mode":"w"}`), {
			path: "a.tex",
			content: "\\usepackage{x}",
			mode: "w",
		});
	});

	it("decodes valid \\u escapes alongside invalid escapes", () => {
		assert.deepEqual(parseStreamingJson(String.raw`{"text":"caf\u00e9 \url"}`), { text: "café \\url" });
	});

	it("omits a \\u escape that is cut off mid-stream", () => {
		assert.deepEqual(parseStreamingJson(String.raw`{"text":"ab\u00`), { text: "ab" });
	});
});

describe("parseToolCallArguments (#10897)", () => {
	it("parses complete JSON and repairs invalid escapes", () => {
		assert.deepEqual(parseToolCallArguments(String.raw`{"kind":"seek","note":"\url"}`), {
			arguments: { kind: "seek", note: "\\url" },
		});
	});

	it("uses empty arguments for empty text", () => {
		for (const raw of [undefined, "", "  "]) {
			assert.deepEqual(parseToolCallArguments(raw), { arguments: {} });
		}
	});

	it("rejects malformed or cut-off JSON without keeping a parsed prefix", () => {
		for (const raw of [
			'{"action":"apply","actions":[{"kind":"seek","time":.5}]}',
			'{"kind":"seek","clipId":"clip-fl',
		]) {
			const result = parseToolCallArguments(raw);
			assert.deepEqual(result.arguments, {});
			assert.ok(result.argumentsError?.endsWith(`Received arguments:\n${raw}`));
		}
	});

	it("rejects JSON that is not an object", () => {
		for (const raw of ["[1,2]", "null", "true", "42", '"text"']) {
			assert.deepEqual(parseToolCallArguments(raw), {
				arguments: {},
				argumentsError: `Tool arguments must be a JSON object\n\nReceived arguments:\n${raw}`,
			});
		}
	});
});
