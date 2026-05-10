import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasUv,
  prependPath,
  resolveCommandFromCurrentPath,
  runCommand,
} from "./spawn.ts";

describe("spawn PATH helpers", () => {
  let originalPath: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalPath = process.env.PATH;
    tempDir = mkdtempSync(join(tmpdir(), "atomic-spawn-"));
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(tempDir, { force: true, recursive: true });
  });

  test("resolves commands added to PATH during the current process", () => {
    const commandName = process.platform === "win32"
      ? "atomic-spawn-test.cmd"
      : "atomic-spawn-test";
    const commandPath = join(tempDir, commandName);
    const body = process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n";

    writeFileSync(commandPath, body);
    chmodSync(commandPath, 0o755);

    process.env.PATH = originalPath ?? "";
    prependPath(tempDir);

    expect(resolveCommandFromCurrentPath("atomic-spawn-test")).toBe(commandPath);
  });

  test("does not add duplicate PATH entries", () => {
    process.env.PATH = originalPath ?? "";

    prependPath(tempDir);
    prependPath(tempDir);

    const delimiter = process.platform === "win32" ? ";" : ":";
    const entries = (process.env.PATH ?? "").split(delimiter);
    expect(entries.filter((entry) => entry === tempDir)).toHaveLength(1);
  });

  test("runCommand keeps stdout and stderr separate", async () => {
    const scriptPath = join(tempDir, "streams.ts");
    writeFileSync(
      scriptPath,
      "await Bun.write(Bun.stderr, 'warning\\n'); await Bun.write(Bun.stdout, 'value\\n');\n",
    );

    const result = await runCommand([
      process.execPath,
      scriptPath,
    ]);

    expect(result.success).toBe(true);
    expect(result.details).toBe("warning");
    expect(result.stderr).toBe("warning");
    expect(result.stdout).toBe("value");
  });
});
