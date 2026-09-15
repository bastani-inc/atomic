import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function hash(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}
// #3073: exercise the shipped compiled dispatch, not a mocked launcher.
test("standalone launcher validates sealed inventory, aliases and optional image dependencies", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-install-validator-"));
	try {
		const launcher = join(root, process.platform === "win32" ? "atomic.exe" : "atomic");
		const build = spawnSync(
			"bun",
			["build", "--compile", "--format=cjs", "packages/coding-agent/src/bun/split-loader.ts", "--outfile", launcher],
			{ encoding: "utf8" },
		);
		assert.equal(build.status, 0, build.stderr);
		const runtime = join(root, "runtime");
		mkdirSync(runtime);
		writeFileSync(join(runtime, "source"), "library");
		writeFileSync(join(runtime, "alias"), "library");
		writeFileSync(join(runtime, "pg-symlinks.json"), JSON.stringify([{ source: "source", target: "alias" }]));
		function seal(names = ["source", "alias", "pg-symlinks.json"]) {
			writeFileSync(
				join(runtime, "payload-files.json"),
				JSON.stringify(names.map((path) => ({ path, sha256: hash(join(runtime, path)) }))),
			);
			writeFileSync(
				join(runtime, "runtime-provenance.json"),
				JSON.stringify({ payloadInventorySha256: hash(join(runtime, "payload-files.json")) }),
			);
		}
		const run = () =>
			spawnSync(launcher, ["--internal-validate-postgres-runtime", runtime], { cwd: root, encoding: "utf8" });
		seal();
		let result = run();
		assert.equal(result.status, 0, result.stderr);
		rmSync(join(runtime, "alias"));
		result = run();
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /incomplete PostgreSQL runtime.*missing file/u);
		writeFileSync(join(runtime, "alias"), "wrong");
		seal();
		assert.match(run().stderr, /invalid materialized runtime alias/u);
		writeFileSync(join(runtime, "alias"), "library");
		writeFileSync(join(runtime, "pg-symlinks.json"), JSON.stringify([{ source: "../escape", target: "alias" }]));
		seal();
		assert.match(run().stderr, /invalid runtime path/u);
		writeFileSync(join(runtime, "pg-symlinks.json"), "[]");
		const name = Buffer.from("@loader_path/libcurl.4.dylib\0");
		const image = Buffer.alloc(56 + name.length);
		image.writeUInt32LE(0xfeedfacf, 0);
		image.writeUInt32LE(1, 16);
		image.writeUInt32LE(0xc, 32);
		image.writeUInt32LE(24 + name.length, 36);
		image.writeUInt32LE(24, 40);
		name.copy(image, 56);
		writeFileSync(join(runtime, "oauth.dylib"), image);
		seal(["source", "alias", "pg-symlinks.json", "oauth.dylib"]);
		assert.match(run().stderr, /dependency closure.*oauth.dylib.*libcurl.4.dylib/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
