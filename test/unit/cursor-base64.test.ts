import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { decodeStrictBase64ImageData } from "../../packages/cursor/src/proto/protobuf-codec-base64.js";

describe("Cursor base64 image decoding", () => {
	test("accepts MIME-wrapped standard base64 image payloads", () => {
		const decoded = decodeStrictBase64ImageData("aG\n k=\r\n", { kind: "selected image", mimeType: "image/png", index: 0 });

		assert.deepEqual([...decoded], [104, 105]);
	});

	test("rejects empty image payloads with sanitized context", () => {
		assert.throws(
			() => decodeStrictBase64ImageData(" \r\n\t", { kind: "MCP image", mimeType: "image/webp", index: 2 }),
			(error: Error) => {
				assert.match(error.message, /Invalid MCP image base64 image data at index 2 for MIME type image\/webp/u);
				assert.doesNotMatch(error.message, /\r|\n|\t/u);
				return true;
			},
		);
	});
});
