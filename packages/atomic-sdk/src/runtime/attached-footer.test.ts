/**
 * Regression coverage for the attached-footer command emitter.
 *
 * Two layers:
 *   - Unit: assert the shell command shape for dev (runtime !== cliPath)
 *     vs compiled (runtime === cliPath) on linux + win32. Catches naive
 *     edits to `buildAttachedFooterCommand`.
 *   - Integration (compiled binary only, skipped otherwise): exec the
 *     emitted command against the real binary and assert it reaches the
 *     `_footer` subcommand instead of the `chat` default. Catches the
 *     specific Bun-compiled-binary argv regression where two copies of
 *     the binary path in argv push the subcommand token past Commander's
 *     default `slice(2)`, falling through to the default `chat` command
 *     and printing "Missing agent".
 */

import { test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildAttachedFooterCommand } from "./attached-footer.ts";

describe("buildAttachedFooterCommand", () => {
  describe("dev mode (runtime !== cliPath)", () => {
    test("linux: emits both runtime and cliPath", () => {
      const cmd = buildAttachedFooterCommand({
        runtime: "/usr/local/bin/bun",
        cliPath: "/repo/packages/atomic/src/cli.ts",
        windowName: "atomic-chat-opencode-abc",
        agentType: "opencode",
        platform: "linux",
      });
      expect(cmd).toBe(
        `"/usr/local/bin/bun" "/repo/packages/atomic/src/cli.ts" _footer ` +
          `--name "atomic-chat-opencode-abc" --agent "opencode"`,
      );
    });

    test("win32: emits both runtime and cliPath inside the encoded pwsh script", () => {
      const cmd = buildAttachedFooterCommand({
        runtime: "C:\\bun\\bun.exe",
        cliPath: "C:\\repo\\cli.ts",
        windowName: "atomic-chat-opencode-abc",
        agentType: "opencode",
        platform: "win32",
      });
      const decoded = decodePwshEncodedCommand(cmd);
      expect(decoded).toContain("'C:\\bun\\bun.exe'");
      expect(decoded).toContain("'C:\\repo\\cli.ts'");
      expect(decoded).toContain("'_footer'");
      expect(decoded).toContain("'--agent' 'opencode'");
    });
  });

  describe("compiled binary mode (runtime === cliPath)", () => {
    // The compiled binary is its own runtime — Bun auto-injects argv[1] = binary
    // so the emitted command must NOT duplicate the path, otherwise Commander's
    // slice(2) drops the `_footer` token and falls through to the default `chat`.
    const BIN = "/usr/local/bin/atomic";

    test("linux: emits the binary path exactly once", () => {
      const cmd = buildAttachedFooterCommand({
        runtime: BIN,
        cliPath: BIN,
        windowName: "atomic-chat-opencode-abc",
        agentType: "opencode",
        platform: "linux",
      });
      expect(cmd).toBe(
        `"${BIN}" _footer --name "atomic-chat-opencode-abc" --agent "opencode"`,
      );
      // Defensive: count occurrences of the binary path. Must be exactly one.
      const occurrences = cmd.split(BIN).length - 1;
      expect(occurrences).toBe(1);
    });

    test("win32: emits the binary path exactly once inside the encoded pwsh script", () => {
      const winBin = "C:\\Program Files\\atomic\\atomic.exe";
      const cmd = buildAttachedFooterCommand({
        runtime: winBin,
        cliPath: winBin,
        windowName: "atomic-chat-opencode-abc",
        agentType: "opencode",
        platform: "win32",
      });
      const decoded = decodePwshEncodedCommand(cmd);
      const occurrences = decoded.split(winBin).length - 1;
      expect(occurrences).toBe(1);
      expect(decoded).toContain("'_footer'");
    });
  });

  test("agentType is optional (workflow path passes only window name)", () => {
    const cmd = buildAttachedFooterCommand({
      runtime: "/bin/atomic",
      cliPath: "/bin/atomic",
      windowName: "atomic-workflow-abc",
      platform: "linux",
    });
    expect(cmd).toBe(`"/bin/atomic" _footer --name "atomic-workflow-abc"`);
    expect(cmd).not.toContain("--agent");
  });
});

// ── Integration: exec the emitted command against the real compiled binary ──
// Skipped when no built binary is present (e.g. unit-test-only CI lanes that
// run before the build). When the binary exists (locally or in CI's
// runtime-assets-smoke job), this asserts the emitted command actually
// dispatches to `_footer`, not to the default `chat` command.

const builtBinary = locateBuiltBinary();

describe.skipIf(!builtBinary)("compiled binary footer dispatch", () => {
  test("emitted footer command reaches the _footer subcommand (not the chat default)", () => {
    const bin = builtBinary!;
    const cmd = buildAttachedFooterCommand({
      runtime: bin,
      cliPath: bin,
      windowName: "atomic-chat-opencode-test",
      agentType: "opencode",
      platform: process.platform === "win32" ? "win32" : "linux",
    });

    // Run the emitted command verbatim through bash so we exercise the same
    // argv tmux's split-window would produce. 1.5s is enough for the OpenTUI
    // headless renderer to emit at least one frame containing the agent pill.
    const result = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        `${cmd} & PID=$!; sleep 1.5; kill -TERM $PID 2>/dev/null; wait $PID 2>/dev/null; exit 0`,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();

    // Bug signature: when argv is malformed, Commander falls through to the
    // default `chat` command which exits 1 with this message.
    expect(stderr).not.toContain("Missing agent");
    expect(stdout).not.toContain("Missing agent");

    // Positive signal: the renderer painted the agent pill at least once.
    // The pill text is uppercase agent name embedded in ANSI styling.
    expect(stdout).toContain("OPENCODE");
  });
});

// ── helpers ────────────────────────────────────────────────────────────

function decodePwshEncodedCommand(cmd: string): string {
  // Format: `pwsh -NoProfile -EncodedCommand <base64>`
  const match = cmd.match(/-EncodedCommand\s+(\S+)/);
  if (!match) throw new Error(`Not a pwsh -EncodedCommand string: ${cmd}`);
  return Buffer.from(match[1]!, "base64").toString("utf16le");
}

function locateBuiltBinary(): string | null {
  if (process.platform === "win32") return null; // bash test harness is unix-only
  // Walk up from this test file (packages/atomic-sdk/src/runtime/) to the
  // monorepo root, then look for a built atomic binary under
  // packages/atomic/dist/<target>/bin/atomic. We can't use findRepoRoot from
  // the atomic package here because atomic-sdk must not depend on atomic.
  let dir = import.meta.dir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "packages"))) {
      const distRoot = join(dir, "packages", "atomic", "dist");
      const targets = [
        "linux-x64",
        "linux-arm64",
        "darwin-x64",
        "darwin-arm64",
      ];
      for (const target of targets) {
        const candidate = join(distRoot, target, "bin", "atomic");
        if (existsSync(candidate)) return candidate;
      }
      return null;
    }
    dir = dirname(dir);
  }
  return null;
}
