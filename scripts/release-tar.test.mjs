import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { gunzipSync } from "node:zlib";
import tar from "tar-stream";

// #3073: macOS tar must not inject unsealed AppleDouble files into Linux payloads.
test("release tar preserves payload bytes without host metadata", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-release-tar-"));
	try {
		mkdirSync(join(root, "atomic"));
		writeFileSync(join(root, "atomic", "library"), "sealed library");
		if (process.platform === "darwin") {
			const result = spawnSync("xattr", ["-w", "com.atomic.test", "metadata", join(root, "atomic", "library")]);
			assert.equal(result.status, 0, result.stderr.toString());
		}
		const archive = join(root, "candidate.tar.gz");
		const result = spawnSync("sh", ["scripts/create-release-tar.sh", archive, root, "atomic"]);
		assert.equal(result.status, 0, result.stderr.toString());
		const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
		assert.equal(listing.status, 0, listing.stderr);
		const entries = [];
		const metadata = [];
		const reader = tar.extract();
		reader.on("entry", (header, stream, next) => {
			entries.push(header.name);
			metadata.push(...Object.keys(header.pax ?? {}).filter((key) => /xattr|acl/iu.test(key)));
			stream.on("end", next);
			stream.resume();
		});
		await new Promise((resolve, reject) => {
			reader.on("finish", resolve);
			reader.on("error", reject);
			reader.end(gunzipSync(readFileSync(archive)));
		});
		assert.deepEqual(entries.sort(), ["atomic/", "atomic/library"]);
		assert.deepEqual(metadata, [], "archive must not retain host extended attributes");
		mkdirSync(join(root, "extract"));
		assert.equal(spawnSync("tar", ["-xzf", archive, "-C", join(root, "extract")]).status, 0);
		assert.equal(readFileSync(join(root, "extract/atomic/library"), "utf8"), "sealed library");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
