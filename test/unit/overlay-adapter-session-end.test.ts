import assert from "node:assert/strict";
import { test } from "vitest";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import type { PiOverlayHandle } from "../../packages/workflows/src/extension/wiring.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { buildGraphOverlayAdapter } from "../../packages/workflows/src/tui/overlay-adapter.js";
import { openSessionPicker } from "../../packages/workflows/src/tui/session-overlays.js";
import { sleep } from "../helpers/runtime.js";

test("a graph overlay dismissed by session shutdown neither leaks the abort nor stays mounted", async () => {
	initTheme("dark");
	const store = createStore();
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	const sessionEnd = new AbortController();
	let mounts = 0;
	const handle: PiOverlayHandle = {
		hide: () => {},
		setHidden: () => {},
		isHidden: () => false,
		focus: () => {},
		unfocus: () => {},
		isFocused: () => true,
	};
	const adapter = buildGraphOverlayAdapter(
		{
			ui: {
				custom: (factory, options) => {
					mounts++;
					options.onHandle?.(handle);
					factory({ requestRender: () => {}, terminal: { rows: 24, columns: 80 } }, {}, {}, () => {});
					return new Promise((_resolve, reject) => {
						sessionEnd.signal.addEventListener("abort", () => reject(sessionEnd.signal.reason), { once: true });
					});
				},
			},
		},
		store,
		{ terminalOutput: { platform: "linux", isTTY: false, write: () => {} } },
	);
	try {
		adapter.open(null);
		sessionEnd.abort();
		await sleep(10);
		assert.deepEqual(unhandled, [], "the session-end abort must not surface as an unhandled rejection");
		adapter.open(null);
		assert.equal(mounts, 2, "a later open must mount a fresh overlay instead of reusing the dismissed one");
	} finally {
		adapter.close();
		process.off("unhandledRejection", onUnhandled);
	}
});

test("a workflow session picker aborted before mounting resolves as closed without leaking the abort", async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		const result = await openSessionPicker(
			{ custom: () => Promise.reject(new DOMException("The operation was aborted.", "AbortError")) },
			createStore(),
			deriveGraphTheme({}),
		);
		await sleep(10);
		assert.deepEqual(result, { kind: "close" });
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});
