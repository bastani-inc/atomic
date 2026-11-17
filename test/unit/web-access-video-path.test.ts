import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { isVideoFile } from "../../packages/web-access/video-extract.js";

// #3111: native absolute paths include drive letters on Windows. File URLs
// must use the host conversion rather than treating /C:/... as a native path.
test("local video discovery accepts native absolute paths and encoded file URLs", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-video-path-"));
	try {
		const path = join(root, "a # clip.mp4");
		writeFileSync(path, "video");
		for (const input of [path, pathToFileURL(path).href]) {
			assert.deepEqual(await isVideoFile(input), { absolutePath: path, mimeType: "video/mp4", sizeBytes: 5 });
		}
		assert.equal(await isVideoFile("https://example.com/clip.mp4"), null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
