import assert from "node:assert/strict";
import { test, vi } from "vitest";

vi.mock("node:worker_threads", async () => {
	const { EventEmitter } = await import("node:events");
	return {
		Worker: class extends EventEmitter {
			postMessage() {
				queueMicrotask(() => {
					this.emit("message", { "watch:require": ["image-resize-worker.js"] });
					this.emit("message", {
						type: "pi:image-resize-response",
						result: {
							data: "resized-image",
							mimeType: "image/png",
							originalWidth: 200,
							originalHeight: 100,
							width: 100,
							height: 50,
							wasResized: true,
						},
					});
				});
			}

			async terminate() {
				return 0;
			}
		},
	};
});

import { resizeImage } from "../src/utils/image-resize.js";

test("keeps image resize results after Node watch messages (#10527)", async () => {
	const result = await resizeImage(new Uint8Array([1, 2, 3]), "image/png");
	assert.deepEqual(result, {
		data: "resized-image",
		mimeType: "image/png",
		originalWidth: 200,
		originalHeight: 100,
		width: 100,
		height: 50,
		wasResized: true,
	});
});
