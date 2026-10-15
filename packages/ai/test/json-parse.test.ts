import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { parseStreamingJson, parseToolCallArguments } from "../src/utils/json-parse.js";

describe("parseStreamingJson", () => {
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
		for (const raw of ['{"action":"apply","actions":[{"kind":"seek","time":.5}]}', '{"kind":"seek","clipId":"clip-fl']) {
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
