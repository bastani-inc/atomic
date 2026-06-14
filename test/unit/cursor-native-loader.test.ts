import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
	CURSOR_H2_NATIVE_PACKAGE,
	cursorH2NativeLoadSummary,
	formatCursorH2NativeLoadFailure,
	loadCursorH2NativeBinding,
	resetCursorH2NativeBindingCache,
	type CursorH2NativeLoadResult,
} from "../../packages/cursor/src/native-loader.js";

describe("Cursor native HTTP/2 loader", () => {
	test("uses the NAPI-RS package entrypoint", () => {
		assert.equal(CURSOR_H2_NATIVE_PACKAGE, "@bastani/atomic-natives");
	});

	test("reports the generated NAPI-RS binding load result", () => {
		resetCursorH2NativeBindingCache();
		const result = loadCursorH2NativeBinding();
		assert.equal(result.packageName, CURSOR_H2_NATIVE_PACKAGE);
		assert.match(cursorH2NativeLoadSummary(result), /@bastani\/atomic-natives|Cursor HTTP\/2 native package/);
		if (result.ok) {
			assert.equal(typeof result.binding.cursorH2RequestUnary, "function");
			assert.equal(typeof result.binding.cursorH2OpenStream, "function");
		}
	});

	test("formats actionable unavailable native binding diagnostics", () => {
		const result: CursorH2NativeLoadResult = {
			ok: false,
			packageName: CURSOR_H2_NATIVE_PACKAGE,
			error: new Error("Cursor HTTP/2 native package is unavailable for test-platform: missing"),
		};
		const message = formatCursorH2NativeLoadFailure(result);
		assert.match(message, /Cursor HTTP\/2 native package is unavailable/);
		assert.match(message, /@bastani\/atomic-natives/);
		assert.match(message, /NAPI-RS optional dependency/);
		assert.doesNotMatch(message, /ATOMIC_CURSOR_H2/);
	});
});
