import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_NAME, PACKAGE_NAME } from "@bastani/atomic";
import {
    findPiPackageRootFromEntry,
    formatPiSpawnError,
    getPiSpawnCommand,
    resolvePiCliScript,
    validatePiSpawnCwd,
} from "../../packages/subagents/src/runs/shared/pi-spawn.js";

describe("subagent CLI spawning", () => {
    test("falls back to the host app command instead of hard-coded pi", () => {
        const command = getPiSpawnCommand(["--mode", "json"], {
            argv1: "/not/a/script",
            existsSync: () => false,
            resolvePackageJson: () => {
                throw new Error("not installed");
            },
        });

        assert.deepEqual(command, {
            command: APP_NAME,
            args: ["--mode", "json"],
        });
    });

    test("resolves the host package root by package name", () => {
        const root = mkdtempSync(join(tmpdir(), "atomic-subagent-spawn-"));
        const dist = join(root, "dist");
        mkdirSync(dist);
        writeFileSync(
            join(root, "package.json"),
            JSON.stringify({ name: PACKAGE_NAME }),
        );
        const entry = join(dist, "cli.js");
        writeFileSync(entry, "");

        assert.equal(findPiPackageRootFromEntry(entry), root);
    });

    test("prefers the host app bin from package metadata", () => {
        const root = mkdtempSync(join(tmpdir(), "atomic-subagent-spawn-"));
        const dist = join(root, "dist");
        mkdirSync(dist);
        writeFileSync(
            join(root, "package.json"),
            JSON.stringify({
                name: PACKAGE_NAME,
                bin: { [APP_NAME]: "dist/cli.js", pi: "dist/pi.js" },
            }),
        );
        writeFileSync(join(dist, "cli.js"), "");
        writeFileSync(join(dist, "pi.js"), "");

        assert.equal(
            resolvePiCliScript({
                argv1: undefined,
                resolvePackageJson: () => join(root, "package.json"),
            }),
            join(dist, "cli.js"),
        );
    });

    test("uses the resolved host CLI script with the current runtime", () => {
        const command = getPiSpawnCommand(["--version"], {
            execPath: "/bin/runtime",
            argv1: "/opt/atomic/dist/cli.js",
            existsSync: (filePath) => filePath === "/opt/atomic/dist/cli.js",
        });

        assert.deepEqual(command, {
            command: "/bin/runtime",
            args: ["/opt/atomic/dist/cli.js", "--version"],
        });
    });

    test("preserves a TypeScript dev CLI entrypoint when the parent runs under Bun", () => {
        const cliPath = "/repo/packages/coding-agent/src/cli.ts";
        const command = getPiSpawnCommand(["--mode", "json"], {
            platform: "linux",
            execPath: "/opt/bun/bin/bun",
            argv1: cliPath,
            existsSync: (filePath) => filePath === cliPath,
        });

        assert.deepEqual(command, {
            command: "/opt/bun/bin/bun",
            args: [cliPath, "--mode", "json"],
        });
    });

    test("spawns a TypeScript dev CLI with Bun and forwards child arguments", () => {
        const root = mkdtempSync(join(tmpdir(), "atomic-subagent-bun-ts-"));
        const cliPath = join(root, "cli.ts");
        const forwardedArgs = ["--mode", "json", "argument with spaces"];

        try {
            writeFileSync(
                cliPath,
                'const forwarded: string[] = process.argv.slice(2); process.stdout.write(JSON.stringify(forwarded));',
            );
            const command = getPiSpawnCommand(forwardedArgs, {
                platform: process.platform,
                execPath: process.execPath,
                argv1: cliPath,
            });
            assert.equal(command.command, process.execPath);
            assert.deepEqual(command.args, [cliPath, ...forwardedArgs]);

            const child = spawnSync(command.command, command.args, { encoding: "utf8" });

            assert.equal(child.status, 0, child.stderr);
            assert.deepEqual(JSON.parse(child.stdout), forwardedArgs);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("does not reuse a TypeScript CLI entrypoint with a non-Bun runtime", () => {
        const cliPath = "/repo/packages/coding-agent/src/cli.ts";
        const command = getPiSpawnCommand(["--version"], {
            platform: "linux",
            execPath: "/opt/atomic/atomic",
            argv1: cliPath,
            existsSync: (filePath) => filePath === cliPath,
            resolvePackageJson: () => {
                throw new Error("not installed");
            },
        });

        assert.deepEqual(command, {
            command: APP_NAME,
            args: ["--version"],
        });
    });

    test("recognizes bun.exe without shell command construction on Windows", () => {
        const cliPath = String.raw`C:\repo\packages\coding-agent\src\cli.ts`;
        const bunPath = String.raw`C:\tools\bun.exe`;
        const command = getPiSpawnCommand(["--mode", "json"], {
            platform: "win32",
            execPath: bunPath,
            argv1: cliPath,
            existsSync: (filePath) => filePath === cliPath,
        });

        assert.deepEqual(command, {
            command: bunPath,
            args: [cliPath, "--mode", "json"],
        });
    });

    test("reports missing cwd before spawn", () => {
        const root = mkdtempSync(join(tmpdir(), "atomic-subagent-spawn-cwd-"));
        const missing = join(root, "missing");
        try {
            assert.deepEqual(validatePiSpawnCwd(missing), {
                ok: false,
                error: `cwd does not exist: ${missing}`,
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("reports file cwd as not a directory before spawn", () => {
        const root = mkdtempSync(join(tmpdir(), "atomic-subagent-spawn-cwd-"));
        const filePath = join(root, "not-a-directory");
        try {
            writeFileSync(filePath, "not a directory");
            assert.deepEqual(validatePiSpawnCwd(filePath), {
                ok: false,
                error: `cwd is not a directory: ${filePath}`,
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("accepts an existing cwd directory", () => {
        const root = mkdtempSync(join(tmpdir(), "atomic-subagent-spawn-cwd-"));
        try {
            assert.deepEqual(validatePiSpawnCwd(root), { ok: true });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("formats runtime spawn ENOENT without requiring a missing binary", () => {
        const error = Object.assign(new Error("spawn /bin/runtime ENOENT"), { code: "ENOENT" });

        assert.equal(
            formatPiSpawnError(error, { command: "/bin/runtime", args: ["child.js"] }, "/repo"),
            "failed to spawn subagent runtime '/bin/runtime' from cwd '/repo': runtime executable was not found or could not be launched (spawn /bin/runtime ENOENT)",
        );
    });
});
