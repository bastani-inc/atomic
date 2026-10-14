import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { parseStreamingJson } from "../src/utils/json-parse.js";

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
