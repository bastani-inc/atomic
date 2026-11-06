import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { resizeImage } from "../src/utils/image-resize.js";

useTemporaryAgentDir();

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

describe("image resize worker teardown", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not resolve until the resize worker has finished terminating (#10695)", async () => {
		const originalTerminate = Worker.prototype.terminate;
		let pendingTerminations = 0;
		const terminate = vi.spyOn(Worker.prototype, "terminate").mockImplementation(function (this: Worker) {
			pendingTerminations++;
			return originalTerminate.apply(this).finally(() => {
				pendingTerminations--;
			});
		});

		const bytes = new Uint8Array(Buffer.from(TINY_PNG_BASE64, "base64"));

		for (let i = 0; i < 2; i++) {
			const result = await resizeImage(bytes, "image/png");
			expect(result).not.toBeNull();
			expect(pendingTerminations).toBe(0);
			expect(terminate).toHaveBeenCalledTimes(i + 1);
		}
	});
});
