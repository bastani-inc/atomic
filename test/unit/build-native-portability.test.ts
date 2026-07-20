import { test } from "bun:test";

// These contracts drive the build script through bash-shebang stub executables
// (fake cargo/bunx on PATH), which Windows cannot execute; the same arg
// contracts run on the Linux and macOS jobs.
const unixTest = process.platform === "win32" ? test.skip : test;
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const script = join(root, "packages/natives/scripts/build-native.ts");
const output = join(root, "packages/natives/native/atomic_natives.linux-x64-gnu.node");

unixTest("glibc-suffixed Linux targets use cargo-zigbuild and copy from the bare target directory", () => {
  const stage = mkdtempSync(join(tmpdir(), "atomic-zigbuild-contract-"));
  const bin = join(stage, "bin");
  const target = join(stage, "target");
  const args = join(stage, "cargo-args.txt");
  const existing = existsSync(output) ? readFileSync(output) : undefined;

  try {
    mkdirSync(bin);
    const cargo = join(bin, "cargo");
    writeFileSync(cargo, `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$*" > "$CARGO_ARGS_FILE"\nmkdir -p "$CARGO_TARGET_DIR/x86_64-unknown-linux-gnu/release"\nprintf 'portable-fixture' > "$CARGO_TARGET_DIR/x86_64-unknown-linux-gnu/release/libatomic_natives.so"\n`);
    chmodSync(cargo, 0o755);

    const result = Bun.spawnSync([process.execPath, script], {
      cwd: root,
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
    if (existing) writeFileSync(output, existing);
    else rmSync(output, { force: true });
    rmSync(stage, { recursive: true, force: true });
  }
});

unixTest("explicit Darwin targets stay native and do not request cross compilation", () => {
  const stage = mkdtempSync(join(tmpdir(), "atomic-darwin-native-contract-"));
  const bin = join(stage, "bin");
  const args = join(stage, "bunx-args.txt");

  try {
    mkdirSync(bin);
    const bunx = join(bin, "bunx");
    writeFileSync(bunx, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "$BUNX_ARGS_FILE"\n`);
    chmodSync(bunx, 0o755);
    const result = Bun.spawnSync([process.execPath, script], {
      cwd: root,
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
