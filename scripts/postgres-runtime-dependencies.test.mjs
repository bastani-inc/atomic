import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateRuntimeDependencies } from "./postgres-runtime-dependencies.mjs";

function macho(dependency) {
	const name = Buffer.from(`${dependency}\0`);
	const commandSize = 24 + name.length;
	const image = Buffer.alloc(32 + commandSize);
	image.writeUInt32LE(0xfeedfacf, 0);
	image.writeUInt32LE(1, 16);
	image.writeUInt32LE(commandSize, 20);
	image.writeUInt32LE(0xc, 32);
	image.writeUInt32LE(commandSize, 36);
	image.writeUInt32LE(24, 40);
	name.copy(image, 56);
	return image;
}

// #3073: verify all bundled images, not just libraries loaded by --version.
test("dependency closure rejects a missing transitive library and accepts the repaired payload", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-pg-closure-"));
	try {
		mkdirSync(join(root, "bin"));
		mkdirSync(join(root, "lib"));
		writeFileSync(join(root, "bin/postgres"), macho("@loader_path/../lib/first.dylib"));
		writeFileSync(join(root, "lib/first.dylib"), macho("@loader_path/transitive.dylib"));
		assert.throws(() => validateRuntimeDependencies(root), /transitive.dylib/u);
		writeFileSync(join(root, "lib/transitive.dylib"), macho("/usr/lib/libSystem.B.dylib"));
		assert.equal(validateRuntimeDependencies(root).images, 3);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// #3073: an optional image outside the executable closure must still fail the full-image diagnostic.
test("full-image diagnostic rejects the upstream OAuth module's absent libcurl", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-pg-oauth-"));
	try {
		mkdirSync(join(root, "bin"));
		mkdirSync(join(root, "lib"));
		writeFileSync(join(root, "bin/postgres"), macho("/usr/lib/libSystem.B.dylib"));
		writeFileSync(join(root, "lib/libpq-oauth-18.dylib"), macho("@loader_path/../lib/libcurl.4.dylib"));
		assert.throws(() => validateRuntimeDependencies(root), /libpq-oauth-18.dylib -> .*libcurl.4.dylib/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// #3073: official language packs include universal static archives, not loadable images.
test("dependency closure ignores universal static archives alongside dynamic images", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-pg-static-"));
	try {
		const archive = Buffer.alloc(40);
		archive.writeUInt32BE(0xcafebabe, 0);
		archive.writeUInt32BE(1, 4);
		archive.writeUInt32BE(32, 16);
		archive.writeUInt32BE(8, 20);
		archive.write("!<arch>\n", 32);
		writeFileSync(join(root, "libpython.a"), archive);
		writeFileSync(join(root, "postgres"), macho("/usr/lib/libSystem.B.dylib"));
		assert.deepEqual(validateRuntimeDependencies(root), { images: 1, edges: 1 });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// #3073: Linux language modules are invisible to entrypoint version probes too.
test("ELF closure follows ORIGIN search paths and rejects missing language libraries", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-pg-elf-"));
	try {
		const image = Buffer.alloc(1024);
		image.writeUInt32BE(0x7f454c46, 0);
		image[4] = 2;
		image[5] = 1;
		image.writeBigUInt64LE(64n, 32);
		image.writeUInt16LE(56, 54);
		image.writeUInt16LE(2, 56);
		image.writeUInt32LE(1, 64);
		image.writeBigUInt64LE(1024n, 96);
		image.writeUInt32LE(2, 120);
		image.writeBigUInt64LE(256n, 128);
		image.writeBigUInt64LE(64n, 152);
		image.writeBigUInt64LE(5n, 256);
		image.writeBigUInt64LE(512n, 264);
		image.writeBigUInt64LE(1n, 272);
		image.writeBigUInt64LE(1n, 280);
		image.writeBigUInt64LE(29n, 288);
		image.writeBigUInt64LE(17n, 296);
		image.write("\0libperl.so.5.26\0$ORIGIN\0", 512);
		writeFileSync(join(root, "plperl.so"), image);
		assert.throws(() => validateRuntimeDependencies(root), /libperl.so.5.26/u);
		writeFileSync(join(root, "libperl.so.5.26"), "library fixture");
		assert.equal(validateRuntimeDependencies(root).edges, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
