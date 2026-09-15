import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateRuntimeDependencies } from "./postgres-runtime-dependencies.mjs";
import { relocateMachO } from "./relocate-postgres-macho.mjs";

// #3073: relocation must repair both architecture slices without growing load commands.
test("relocated universal module resolves its packaged language library", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-relocate-"));
	try {
		const slice = Buffer.alloc(128);
		slice.writeUInt32LE(0xfeedfacf, 0);
		slice.writeUInt32LE(1, 16);
		slice.writeUInt32LE(64, 20);
		slice.writeUInt32LE(0xc, 32);
		slice.writeUInt32LE(64, 36);
		slice.writeUInt32LE(24, 40);
		slice.write("/lib/libpython3.13.dylib\0", 56);
		const fat = Buffer.alloc(320);
		fat.writeUInt32BE(0xcafebabe, 0);
		fat.writeUInt32BE(2, 4);
		fat.writeUInt32BE(64, 16);
		fat.writeUInt32BE(128, 20);
		fat.writeUInt32BE(192, 36);
		fat.writeUInt32BE(128, 40);
		slice.copy(fat, 64);
		slice.copy(fat, 192);
		const path = join(root, "module.dylib");
		writeFileSync(path, fat);
		writeFileSync(join(root, "P"), "supplied library");
		assert.throws(() => validateRuntimeDependencies(root), /libpython/u);
		assert.equal(relocateMachO(path, new Map([["/lib/libpython3.13.dylib", "@loader_path/P"]])), true);
		assert.equal(readFileSync(path).length, fat.length);
		assert.deepEqual(validateRuntimeDependencies(root), { images: 1, edges: 2 });
		assert.equal(relocateMachO(path, new Map()), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
