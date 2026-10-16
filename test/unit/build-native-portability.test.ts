import { TaskSupervisor } from "@bastani/atomic-natives";
import { test } from "vitest";

// These contracts drive the build script through bash-shebang stub executables
// (fake cargo/bunx on PATH), which Windows cannot execute; the same arg
// contracts run on the Linux and macOS jobs.
const unixTest = process.platform === "win32" ? test.skip : test;

import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bunExecutable, spawnSyncCollect } from "../helpers/runtime.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
function stageBuildScript(stage: string) {
	const packageRoot = join(stage, "packages/natives");
	// The real script writes its binding and generated files relative to its own location.
	// Never run the stub build against artifacts already mapped by other unit workers.
	for (const file of [
		"scripts/build-native.ts",
		"scripts/spawn-error.ts",
		"scripts/generated-binding-fixes.ts",
		"native/index.js",
		"native/index.d.ts",
		"package.json",
	]) {
		const destination = join(packageRoot, file);
		mkdirSync(dirname(destination), { recursive: true });
		copyFileSync(join(root, "packages/natives", file), destination);
	}
	return {
		script: join(packageRoot, "scripts/build-native.ts"),
		output: join(packageRoot, "native/atomic_natives.linux-x64-gnu.node"),
	};
}

unixTest("glibc-suffixed Linux targets use cargo-zigbuild and copy from the bare target directory", () => {
	const stage = mkdtempSync(join(tmpdir(), "atomic-zigbuild-contract-"));
	const bin = join(stage, "bin");
	const target = join(stage, "target");
	const args = join(stage, "cargo-args.txt");
	const supervisor = new TaskSupervisor();

	try {
		const { script, output } = stageBuildScript(stage);
		mkdirSync(bin);
		const cargo = join(bin, "cargo");
		writeFileSync(
			cargo,
			`#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$*" > "$CARGO_ARGS_FILE"\nmkdir -p "$CARGO_TARGET_DIR/x86_64-unknown-linux-gnu/release"\nprintf 'portable-fixture' > "$CARGO_TARGET_DIR/x86_64-unknown-linux-gnu/release/libatomic_natives.so"\n`,
		);
		chmodSync(cargo, 0o755);

		const result = spawnSyncCollect([bunExecutable(), script], {
			cwd: stage,
			env: {
				...process.env,
				PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
				CROSS_TARGET: "x86_64-unknown-linux-gnu.2.17",
				CARGO_TARGET_DIR: target,
				CARGO_ARGS_FILE: args,
			},
			stdout: "pipe",
			stderr: "pipe",
		});

		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.match(readFileSync(args, "utf8"), /^zigbuild .*--target x86_64-unknown-linux-gnu\.2\.17 --release/u);
		assert.equal(readFileSync(output, "utf8"), "portable-fixture");
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
	// Other unit workers can already have this binding mapped while the build contract runs.
	assert.ok(supervisor.bindHostSession({ kind: "session", sessionId: "build-native-contract" }));
});

unixTest("musl targets use NAPI-RS cross compilation without a glibc floor suffix", () => {
	const stage = mkdtempSync(join(tmpdir(), "atomic-musl-cross-contract-"));
	const bin = join(stage, "bin");
	const args = join(stage, "bunx-args.txt");

	try {
		const { script } = stageBuildScript(stage);
		mkdirSync(bin);
		const bunx = join(bin, "bunx");
		writeFileSync(bunx, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "$BUNX_ARGS_FILE"\n`);
		chmodSync(bunx, 0o755);
		const result = spawnSyncCollect([bunExecutable(), script], {
			cwd: stage,
			env: {
				...process.env,
				PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
				CROSS_TARGET: "x86_64-unknown-linux-musl",
				BUNX_ARGS_FILE: args,
			},
			stdout: "pipe",
			stderr: "pipe",
		});

		assert.equal(result.exitCode, 0, result.stderr.toString());
		const invoked = readFileSync(args, "utf8");
		assert.match(invoked, /napi build .*--target x86_64-unknown-linux-musl --cross-compile/u);
		assert.doesNotMatch(invoked, /x86_64-unknown-linux-musl\.2\.17/u);
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
});

unixTest("explicit Darwin targets stay native and do not request cross compilation", () => {
	const stage = mkdtempSync(join(tmpdir(), "atomic-darwin-native-contract-"));
	const bin = join(stage, "bin");
	const args = join(stage, "bunx-args.txt");

	try {
		const { script } = stageBuildScript(stage);
		mkdirSync(bin);
		const bunx = join(bin, "bunx");
		writeFileSync(bunx, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "$BUNX_ARGS_FILE"\n`);
		chmodSync(bunx, 0o755);
		const result = spawnSyncCollect([bunExecutable(), script], {
			cwd: stage,
			env: {
				...process.env,
				PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
				CROSS_TARGET: "",
				NATIVE_TARGET: "aarch64-apple-darwin",
				BUNX_ARGS_FILE: args,
			},
			stdout: "pipe",
			stderr: "pipe",
		});

		assert.equal(result.exitCode, 0, result.stderr.toString());
		const invoked = readFileSync(args, "utf8");
		assert.match(invoked, /napi build .*--target aarch64-apple-darwin/u);
		assert.doesNotMatch(invoked, /--cross-compile/u);
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
});
