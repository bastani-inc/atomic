/**
 * Drift-prevention tests for INFO_COMMAND_ARGV0 / isInfoCommandArgv.
 *
 * Static-source scan: reads cli.ts, regex-finds every hidden `_`-prefixed
 * command registration, and asserts each is present in INFO_COMMAND_ARGV0.
 * This guards against someone adding a new hidden command without updating
 * the skip set (which would cause the new command to inadvertently trigger
 * the workflow bootstrap).
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INFO_COMMAND_ARGV0, isInfoCommandArgv } from "./info-command-skip.ts";


test("INFO_COMMAND_ARGV0 snapshot includes all expected entries", () => {
    const expected = [
        "install",
        "uninstall",
        "update",
        "completions",
        "_claude-stop-hook",
        "_claude-ask-hook",
        "_claude-session-start-hook",
        "_claude-inflight-hook",
    ] as const;
    for (const entry of expected) {
        expect(INFO_COMMAND_ARGV0).toContain(entry);
    }
    expect(INFO_COMMAND_ARGV0).toHaveLength(expected.length);
});

// ─── isInfoCommandArgv unit tests ─────────────────────────────────────────────

describe("isInfoCommandArgv", () => {
    test("returns true for --version", () => {
        expect(isInfoCommandArgv(["--version"])).toBe(true);
    });

    test("returns true for -v", () => {
        expect(isInfoCommandArgv(["-v"])).toBe(true);
    });

    test("returns true for --help", () => {
        expect(isInfoCommandArgv(["--help"])).toBe(true);
    });

    test("returns true for -h", () => {
        expect(isInfoCommandArgv(["-h"])).toBe(true);
    });

    test("returns true for every INFO_COMMAND_ARGV0 entry", () => {
        for (const cmd of INFO_COMMAND_ARGV0) {
            expect(isInfoCommandArgv([cmd])).toBe(true);
        }
    });

    test("returns false for unknown command", () => {
        expect(isInfoCommandArgv(["chat"])).toBe(false);
    });

    test("returns false for empty argv", () => {
        expect(isInfoCommandArgv([])).toBe(false);
    });

    test("returns false for unrelated args", () => {
        expect(isInfoCommandArgv(["workflow", "list"])).toBe(false);
    });
});

// ─── Static-source drift scan ─────────────────────────────────────────────────

test("every hidden _-prefixed command in cli.ts appears in INFO_COMMAND_ARGV0", () => {
    // NOTE: This static scan protects against drift. If a new hidden command
    // (matching .command("_...") pattern) is added to cli.ts without updating
    // INFO_COMMAND_ARGV0, this test will fail.
    const cliSource = readFileSync(
        join(import.meta.dir, "cli.ts"),
        "utf8",
    );

    // Match: .command("_some-name" or .command("_some-name", { hidden: true }
    const HIDDEN_CMD_RE = /\.command\("(_[^"]+)"/g;
    const found: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = HIDDEN_CMD_RE.exec(cliSource)) !== null) {
        found.push(m[1]!);
    }

    expect(found.length).toBeGreaterThan(0); // sanity: we found at least one

    for (const cmd of found) {
        expect(INFO_COMMAND_ARGV0 as readonly string[]).toContain(cmd);
    }
});
