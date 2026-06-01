import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_NAME, PACKAGE_NAME } from "@bastani/atomic";
import {
    findPiPackageRootFromEntry,
    getPiSpawnCommand,
    resolvePiCliScript,
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
});
