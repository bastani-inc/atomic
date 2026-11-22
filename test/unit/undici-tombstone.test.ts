import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, test } from "vitest";
import {
	appendUndiciTombstoneToTarball,
	UNDICI_TOMBSTONE_SHIMS,
	undiciTombstoneEntries,
} from "../../packages/coding-agent/scripts/undici-tombstone.mjs";
import {
	isRetryableModelFailure,
	isRetryableSameModelFailure,
} from "../../packages/coding-agent/src/core/model-fallback-failures.ts";
import { npmSpawnPrefix, spawnSyncCollect } from "../helpers/runtime.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function packFixture(version = "0.10.5"): { readonly dir: string; readonly tarball: string } {
	const dir = mkdtempSync(join(tmpdir(), "atomic-undici-tombstone-"));
	dirs.push(dir);
	const pkgDir = join(dir, "pkg");
	mkdirSync(pkgDir, { recursive: true });
	writeFileSync(
		join(pkgDir, "package.json"),
		`${JSON.stringify(
			{
				name: "@bastani/atomic",
				version,
				type: "module",
				atomicConfig: { name: "atomic" },
				files: ["index.js"],
				optionalDependencies: { "@mariozechner/clipboard": "0.3.9" },
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(join(pkgDir, "index.js"), "export const ok = true;\n");
	const pack = spawnSyncCollect([...npmSpawnPrefix(), "pack", "--ignore-scripts", "--pack-destination", dir], {
		cwd: pkgDir,
	});
	assert.equal(pack.exitCode, 0, pack.stderr.toString());
	const tgzName = pack.stdout.toString().trim().split(/\r?\n/).at(-1);
	assert.ok(tgzName);
	return { dir, tarball: join(dir, tgzName) };
}

test("appends only the 8 pure-ESM undici restart-notice files to a packed tarball, idempotently and without package.json changes", () => {
	const { dir, tarball } = packFixture("0.10.5");

	assert.equal(appendUndiciTombstoneToTarball(tarball), true);
	// Second invocation is an exact no-op.
	assert.equal(appendUndiciTombstoneToTarball(tarball), false);

	const list = spawnSyncCollect(["tar", "-tzf", basename(tarball)], { cwd: dirname(tarball) });
	assert.equal(list.exitCode, 0, list.stderr.toString());
	const entries = list.stdout.toString().trim().split(/\r?\n/).sort();
	const undiciEntries = entries.filter((entry) => entry.startsWith("package/node_modules/"));
	assert.deepEqual(
		undiciEntries,
		undiciTombstoneEntries()
			.map((entry) => `package/${entry.path}`)
			.sort(),
	);
	assert.equal(entries.includes("package/node_modules/undici/package.json"), false);

	const unpacked = join(dir, "unpacked");
	mkdirSync(unpacked, { recursive: true });
	const untar = spawnSyncCollect(["tar", "-xzf", basename(tarball), "-C", unpacked], { cwd: dirname(tarball) });
	assert.equal(untar.exitCode, 0, untar.stderr.toString());

	const unpackedManifest = JSON.parse(readFileSync(join(unpacked, "package", "package.json"), "utf8")) as {
		optionalDependencies?: Record<string, string>;
		bundleDependencies?: string[];
	};
	assert.equal(unpackedManifest.optionalDependencies?.undici, undefined);
	assert.equal(unpackedManifest.bundleDependencies, undefined);
	assert.equal(existsSync(join(unpacked, "package", "node_modules", "undici", "package.json")), false);
});

test("every unpacked undici shim throws the version-aware restart message via require() on every call and is non-retryable", () => {
	const { dir, tarball } = packFixture("0.10.5");
	appendUndiciTombstoneToTarball(tarball);

	const unpacked = join(dir, "unpacked");
	mkdirSync(unpacked, { recursive: true });
	const untar = spawnSyncCollect(["tar", "-xzf", basename(tarball), "-C", unpacked], { cwd: dirname(tarball) });
	assert.equal(untar.exitCode, 0, untar.stderr.toString());

	const pkgRoot = join(unpacked, "package");
	const req = createRequire(join(pkgRoot, "package.json"));
	for (const shim of UNDICI_TOMBSTONE_SHIMS) {
		const target = join(pkgRoot, "node_modules", "undici", shim);
		for (let attempt = 0; attempt < 2; attempt++) {
			let thrown: (Error & { code?: unknown; feature?: unknown }) | undefined;
			try {
				req(target);
			} catch (error) {
				thrown = error as Error & { code?: unknown; feature?: unknown };
			}
			assert.ok(thrown instanceof Error, `${shim} attempt ${attempt + 1} must throw an Error`);
			assert.equal(thrown.name, "UpdatedInstallError", shim);
			assert.equal(thrown.feature, "model requests", shim);
			assert.equal(thrown.code, undefined, `${shim} must not look like MODULE_NOT_FOUND`);
			assert.match(
				thrown.message,
				/^atomic was updated to 0\.10\.5 while this session was running; restart it to keep using model requests\./,
				`${shim}: ${thrown.message}`,
			);
			const thrownMessage = thrown.message;
			for (const prefix of ["Connection error.: ", "fetch failed: "]) {
				const wrapped: { stopReason: "error"; errorMessage: string } = {
					stopReason: "error",
					errorMessage: `${prefix}${thrownMessage}`,
				};
				assert.equal(isRetryableSameModelFailure(wrapped), false, `${shim} (${prefix})`);
				assert.equal(isRetryableModelFailure(wrapped), false, `${shim} (${prefix})`);
			}
		}
	}

	// Reads version from the installed package.json at throw time rather than baking it in at pack time:
	// unpack the exact same tarball into a fresh directory and bump its package.json before first load.
	const unpacked2 = join(dir, "unpacked-0109");
	mkdirSync(unpacked2, { recursive: true });
	assert.equal(
		spawnSyncCollect(["tar", "-xzf", basename(tarball), "-C", unpacked2], { cwd: dirname(tarball) }).exitCode,
		0,
	);
	const manifestPath2 = join(unpacked2, "package", "package.json");
	const updated = JSON.parse(readFileSync(manifestPath2, "utf8")) as Record<string, unknown>;
	updated.version = "0.10.9";
	writeFileSync(manifestPath2, `${JSON.stringify(updated, null, 2)}\n`);
	assert.throws(
		() =>
			createRequire(manifestPath2)(
				join(unpacked2, "package", "node_modules", "undici", "lib/llhttp/llhttp-wasm.js"),
			),
		/atomic was updated to 0\.10\.9 while this session was running; restart it to keep using model requests\./,
	);

	// Falls back cleanly when package.json cannot be read.
	const unpacked3 = join(dir, "unpacked-missing-manifest");
	mkdirSync(unpacked3, { recursive: true });
	assert.equal(
		spawnSyncCollect(["tar", "-xzf", basename(tarball), "-C", unpacked3], { cwd: dirname(tarball) }).exitCode,
		0,
	);
	const manifestPath3 = join(unpacked3, "package", "package.json");
	rmSync(manifestPath3);
	assert.throws(
		() =>
			createRequire(join(unpacked3, "package", "index.js"))(
				join(unpacked3, "package", "node_modules", "undici", "lib/llhttp/llhttp-wasm.js"),
			),
		/The atomic installation this session runs from was updated while this session was running; restart it to keep using model requests\./,
	);
});
