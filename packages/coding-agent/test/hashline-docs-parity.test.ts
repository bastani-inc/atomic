import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { readTextSync } from "../../../test/helpers/runtime.js";
import { nativeBlockResolver } from "../src/core/tools/block-resolver.ts";
import {
	BARE_BODY_AUTO_PIPED_WARNING,
	BLOCK_RESOLVER_UNAVAILABLE,
	DELETE_BLOCK_TAKES_NO_BODY,
	DELETE_TAKES_NO_BODY,
	describeAnchorExamples,
	EMPTY_BLOCK,
	EMPTY_INSERT,
	EMPTY_REPLACE,
	HUNK_LIKE_LITERAL_WARNING,
	MINUS_ROW_REJECTED,
	Patch,
	parseTag,
	UNRESOLVED_BLOCK_INTERNAL,
} from "../src/core/tools/hashline-engine/index.ts";
import { loadNativeSearchBinding } from "../src/core/tools/search-native.ts";

const docs = readTextSync(join(dirname(fileURLToPath(import.meta.url)), "../docs/tools/edit.md"), "utf8");
const normalizedDocs = docs.replace(/\s+/g, " ");

describe("hashline edit reference documentation", () => {
	test("keeps exported diagnostics and generated anchor examples aligned with the engine", () => {
		assert.ok(docs.includes(describeAnchorExamples("119")));
		for (const diagnostic of [
			MINUS_ROW_REJECTED,
			EMPTY_INSERT,
			EMPTY_BLOCK,
			DELETE_TAKES_NO_BODY,
			DELETE_BLOCK_TAKES_NO_BODY,
			BLOCK_RESOLVER_UNAVAILABLE,
			UNRESOLVED_BLOCK_INTERNAL,
			BARE_BODY_AUTO_PIPED_WARNING,
			HUNK_LIKE_LITERAL_WARNING,
			EMPTY_REPLACE,
		]) {
			assert.ok(docs.includes(diagnostic), `reference docs omitted or changed: ${diagnostic}`);
		}
	});

	test("documents the exact condition for hash-comment skipping", () => {
		assert.ok(!normalizedDocs.includes("Comment lines beginning with `#` between hunks are ignored"));
		assert.ok(!normalizedDocs.includes("skipped only before the first operation in a section"));
		assert.ok(normalizedDocs.includes("skipped only when an operation header is the immediately next token"));
		assert.ok(normalizedDocs.includes("a blank line, end of input, or the next `[PATH#TAG]` header intervenes"));
	});

	test("skips a leading hash comment but treats one in an open hunk as body content", () => {
		const leadingComment = Patch.parse("[probe.ts#AAAA]\n# note\ndelete 3");
		assert.equal(leadingComment.sections[0]?.edits.length, 1);
		assert.equal(leadingComment.sections[0]?.edits[0]?.kind, "delete");

		const replacementComment = Patch.parse(
			'[probe.ts#AAAA]\nreplace 3..3:\n+    msg = "hi"\n# note\ninsert after 5:\n+tail()',
		);
		assert.ok(
			replacementComment.sections[0]?.edits.some((edit) => edit.kind === "insert" && edit.text === "# note"),
			"a hash comment in an open replacement hunk must remain literal payload",
		);
	});

	test("rejects deferred hash comments unless an operation header immediately follows", () => {
		const expected =
			'line 1: payload line has no preceding hunk header. Use `replace N..M:`, `delete N..M`, or `insert before|after|head|tail:` above the body. Got "# note".';
		for (const input of [
			"[probe.ts#AAAA]\n# note\n\ndelete 3",
			"[probe.ts#AAAA]\n# note",
			"[probe.ts#AAAA]\n# note\n[other.ts#BBBB]\ndelete 1",
		]) {
			let message: string | undefined;
			try {
				Patch.parse(input).sections.flatMap((section) => section.edits);
			} catch (error) {
				assert.ok(error instanceof Error);
				message = error.message;
			}
			assert.equal(message, expected, `unexpected result for ${JSON.stringify(input)}`);
		}
	});

	test("keeps the literal low-level invalid-line-reference error in the catalogue", () => {
		let message: string | undefined;
		try {
			parseTag("abc");
		} catch (error) {
			assert.ok(error instanceof Error);
			message = error.message;
		}
		assert.ok(message);
		assert.ok(docs.includes(message), `reference docs omitted or changed: ${message}`);
		assert.ok(normalizedDocs.includes("currently have no caller in Atomic"));
	});

	test("pins which leading nodes tree-sitter sweeps into their construct", () => {
		assert.equal(typeof loadNativeSearchBinding()?.blockRangeAt, "function");
		const resolve = (path: string, text: string) => nativeBlockResolver({ path, text, line: 1 });

		assert.deepEqual(resolve("decorated.py", "@cache\ndef greet(name):\n    return name\n"), { start: 1, end: 3 });
		assert.deepEqual(resolve("decorated.ts", "@Component({})\nexport class C {\n  x = 1;\n}\n"), {
			start: 1,
			end: 4,
		});
		assert.deepEqual(resolve("attribute.rs", "#[derive(Debug)]\npub struct S {\n    a: u32,\n}\n"), {
			start: 1,
			end: 1,
		});
		assert.deepEqual(resolve("docs.rs", "/// docs\npub fn f() -> u8 {\n    1\n}\n"), { start: 1, end: 1 });
		assert.deepEqual(resolve("jsdoc.ts", "/**\n * doc\n */\nexport function f() {\n  return 1;\n}\n"), {
			start: 1,
			end: 3,
		});
		assert.deepEqual(resolve("comment.go", "// F does a thing.\nfunc F() int {\n\treturn 1\n}\n"), {
			start: 1,
			end: 1,
		});
	});
});
