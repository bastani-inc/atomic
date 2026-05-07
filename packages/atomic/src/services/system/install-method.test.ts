/**
 * Tests for detectInstallMethod — covers every branch per the RFC task spec.
 *
 * Strategy: detectInstallMethod accepts `opts.execPath` and `opts.cwd` so we
 * never mutate `process.execPath` or `process.cwd()`. For PM probes we inject
 * a mock spawn via `pmListsAtomic`'s second parameter.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
    detectInstallMethod,
    pmListsAtomic,
    isInsideRepoCheckout,
    ATOMIC_PACKAGE_NAME,
} from "./install-method.ts";
import { getInstallPaths } from "../../commands/cli/install.ts";

// ── helpers ────────────────────────────────────────────────────────────────

let tmp: string;
beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "install-method-test-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

type SpawnResult = { exitCode: number | null; stdout: string };
type SpawnFn = (cmd: string[]) => Promise<SpawnResult>;

function mockSpawn(stdout: string, exitCode: number = 0): SpawnFn {
    return async (_cmd) => ({ exitCode, stdout });
}

// ── ATOMIC_PACKAGE_NAME constant ───────────────────────────────────────────

test("ATOMIC_PACKAGE_NAME is @bastani/atomic", () => {
    expect(ATOMIC_PACKAGE_NAME).toBe("@bastani/atomic");
});

// ── binary detection ───────────────────────────────────────────────────────

describe("binary install detection", () => {
    test("returns binary kind when execPath equals getInstallPaths().binPath", async () => {
        const { binPath } = getInstallPaths();
        const result = await detectInstallMethod({ execPath: binPath, skipProbe: true });
        expect(result.kind).toBe("binary");
        if (result.kind === "binary") {
            expect(result.binPath).toBeTruthy();
        }
    });

    test("does not return binary kind for a different path", async () => {
        const result = await detectInstallMethod({
            execPath: join(tmp, "other-binary"),
            skipProbe: true,
        });
        expect(result.kind).not.toBe("binary");
    });
});

// ── bun global bin detection ───────────────────────────────────────────────

describe("bun install detection", () => {
    test("returns bun kind when execPath is under ~/.bun/bin/", async () => {
        const bunBinPath = join(homedir(), ".bun", "bin", "atomic");

        const result = await detectInstallMethod({ execPath: bunBinPath, skipProbe: true });
        expect(result.kind).toBe("bun");
        if (result.kind === "bun") {
            expect(result.binPath).toBeTruthy();
        }
    });

    test("returns bun kind when execPath is under $BUN_INSTALL/bin/", async () => {
        const fakeBunInstall = join(tmp, "bun-install");
        mkdirSync(join(fakeBunInstall, "bin"), { recursive: true });
        const bunBinPath = join(fakeBunInstall, "bin", "atomic");

        const origEnv = process.env.BUN_INSTALL;
        process.env.BUN_INSTALL = fakeBunInstall;
        try {
            const result = await detectInstallMethod({ execPath: bunBinPath, skipProbe: true });
            expect(result.kind).toBe("bun");
        } finally {
            if (origEnv === undefined) {
                delete process.env.BUN_INSTALL;
            } else {
                process.env.BUN_INSTALL = origEnv;
            }
        }
    });
});

// ── node_modules PM heuristic ──────────────────────────────────────────────

describe("node_modules PM heuristic", () => {
    test("returns npm when no .pnpm or .yarn-state.yml present", async () => {
        const nmDir = join(tmp, "node_modules", "@bastani", "atomic", "bin");
        mkdirSync(nmDir, { recursive: true });
        const fakeExec = join(nmDir, "atomic");
        writeFileSync(fakeExec, "#!/bin/sh\necho hi");

        const result = await detectInstallMethod({ execPath: fakeExec, skipProbe: true });
        expect(result.kind).toBe("npm");
    });

    test("returns pnpm when node_modules/.pnpm is present", async () => {
        const nmDir = join(tmp, "node_modules", "@bastani", "atomic", "bin");
        mkdirSync(nmDir, { recursive: true });
        mkdirSync(join(tmp, "node_modules", ".pnpm"), { recursive: true });
        const fakeExec = join(nmDir, "atomic");
        writeFileSync(fakeExec, "#!/bin/sh\necho hi");

        const result = await detectInstallMethod({ execPath: fakeExec, skipProbe: true });
        expect(result.kind).toBe("pnpm");
    });

    test("returns yarn when node_modules/.yarn-state.yml is present", async () => {
        const nmDir = join(tmp, "node_modules", "@bastani", "atomic", "bin");
        mkdirSync(nmDir, { recursive: true });
        writeFileSync(join(tmp, "node_modules", ".yarn-state.yml"), "__metadata:\n  version: 6\n");
        const fakeExec = join(nmDir, "atomic");
        writeFileSync(fakeExec, "#!/bin/sh\necho hi");

        const result = await detectInstallMethod({ execPath: fakeExec, skipProbe: true });
        expect(result.kind).toBe("yarn");
    });
});

// ── pmListsAtomic probe ────────────────────────────────────────────────────

describe("pmListsAtomic", () => {
    test("bun: returns true when stdout contains package name", async () => {
        const stdout = `@bastani/atomic@0.7.8\nsome-other-package@1.0.0\n`;
        expect(await pmListsAtomic("bun", mockSpawn(stdout))).toBe(true);
    });

    test("bun: returns false when stdout does not contain package name", async () => {
        expect(await pmListsAtomic("bun", mockSpawn("other-pkg@1.0.0\n"))).toBe(false);
    });

    test("bun: returns false when exit code non-zero", async () => {
        expect(await pmListsAtomic("bun", mockSpawn("@bastani/atomic@0.7.8", 1))).toBe(false);
    });

    test("npm: returns true when dependencies contain package", async () => {
        const json = JSON.stringify({
            dependencies: {
                "@bastani/atomic": { version: "0.7.8" },
            },
        });
        expect(await pmListsAtomic("npm", mockSpawn(json))).toBe(true);
    });

    test("npm: returns false when package absent from dependencies", async () => {
        const json = JSON.stringify({ dependencies: { "other-pkg": {} } });
        expect(await pmListsAtomic("npm", mockSpawn(json))).toBe(false);
    });

    test("npm: returns false when exit code non-zero", async () => {
        const json = JSON.stringify({ dependencies: { "@bastani/atomic": {} } });
        expect(await pmListsAtomic("npm", mockSpawn(json, 1))).toBe(false);
    });

    test("pnpm: returns true when any array entry has the package", async () => {
        const json = JSON.stringify([
            { dependencies: { "@bastani/atomic": { version: "0.7.8" } } },
        ]);
        expect(await pmListsAtomic("pnpm", mockSpawn(json))).toBe(true);
    });

    test("pnpm: returns false when no entry has the package", async () => {
        const json = JSON.stringify([{ dependencies: { "other": {} } }]);
        expect(await pmListsAtomic("pnpm", mockSpawn(json))).toBe(false);
    });

    test("yarn: returns true when NDJSON contains package name", async () => {
        const ndjson = JSON.stringify({
            type: "list",
            data: { type: "info", trees: [{ name: "@bastani/atomic@0.7.8" }] },
        });
        expect(await pmListsAtomic("yarn", mockSpawn(ndjson))).toBe(true);
    });

    test("yarn: returns false when NDJSON does not contain package name", async () => {
        const ndjson = JSON.stringify({ type: "list", data: { trees: [{ name: "other@1.0.0" }] } });
        expect(await pmListsAtomic("yarn", mockSpawn(ndjson))).toBe(false);
    });

    test("swallows non-zero exit and returns false", async () => {
        expect(await pmListsAtomic("npm", mockSpawn("{}", 2))).toBe(false);
    });

    test("swallows thrown errors and returns false", async () => {
        const throwingSpawn: SpawnFn = async (_cmd) => {
            throw new Error("spawn failed");
        };
        expect(await pmListsAtomic("npm", throwingSpawn)).toBe(false);
    });
});

// ── probe fallback via detectInstallMethod ─────────────────────────────────

describe("detectInstallMethod probe behavior", () => {
    test("skipProbe: true skips probe and goes to source/unknown", async () => {
        const fakeExec = join(tmp, "some-other-bin", "atomic");
        mkdirSync(join(tmp, "some-other-bin"), { recursive: true });
        const result = await detectInstallMethod({
            execPath: fakeExec,
            cwd: tmp,
            skipProbe: true,
        });
        expect(result.kind).toBe("unknown");
    });
});

// ── source checkout detection ──────────────────────────────────────────────

describe("isInsideRepoCheckout", () => {
    test("returns true when cwd is inside a dir with .git and package.json name=atomic", () => {
        const repoDir = join(tmp, "my-atomic-repo");
        mkdirSync(join(repoDir, ".git"), { recursive: true });
        writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "atomic" }));
        const subDir = join(repoDir, "packages", "atomic", "src");
        mkdirSync(subDir, { recursive: true });

        expect(isInsideRepoCheckout(subDir)).toBe(true);
    });

    test("returns true when workspace root package.json has workspaces including packages/atomic", () => {
        const repoDir = join(tmp, "monorepo");
        mkdirSync(join(repoDir, ".git"), { recursive: true });
        writeFileSync(
            join(repoDir, "package.json"),
            JSON.stringify({
                name: "root",
                workspaces: ["packages/atomic", "packages/other"],
            }),
        );
        const subDir = join(repoDir, "packages", "atomic");
        mkdirSync(subDir, { recursive: true });

        expect(isInsideRepoCheckout(subDir)).toBe(true);
    });

    test("returns false for a non-repo temp dir", () => {
        const plainDir = join(tmp, "not-a-repo");
        mkdirSync(plainDir, { recursive: true });
        expect(isInsideRepoCheckout(plainDir)).toBe(false);
    });

    test("returns false when .git present but package.json name is not atomic and no workspaces", () => {
        const repoDir = join(tmp, "other-repo");
        mkdirSync(join(repoDir, ".git"), { recursive: true });
        writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "not-atomic" }));
        expect(isInsideRepoCheckout(repoDir)).toBe(false);
    });

    test("returns false when path walk throws (defensive)", () => {
        expect(isInsideRepoCheckout(join(tmp, "does-not-exist"))).toBe(false);
    });

    // ── new cases for patched heuristic ──────────────────────────────────────

    test("returns true when root package.json has name @bastani/atomic-monorepo and workspaces packages/*", () => {
        // Regression: real monorepo shape was a false-negative before the fix.
        const repoDir = join(tmp, "bastani-monorepo");
        mkdirSync(join(repoDir, ".git"), { recursive: true });
        writeFileSync(
            join(repoDir, "package.json"),
            JSON.stringify({
                name: "@bastani/atomic-monorepo",
                workspaces: ["packages/*", "examples/*"],
            }),
        );
        const subDir = join(repoDir, "packages", "atomic", "src");
        mkdirSync(subDir, { recursive: true });

        expect(isInsideRepoCheckout(subDir)).toBe(true);
    });

    test("returns true for scoped suffix match name @some-org/atomic-monorepo", () => {
        const repoDir = join(tmp, "scoped-monorepo");
        mkdirSync(join(repoDir, ".git"), { recursive: true });
        writeFileSync(
            join(repoDir, "package.json"),
            JSON.stringify({ name: "@some-org/atomic-monorepo" }),
        );
        const subDir = join(repoDir, "packages", "atomic");
        mkdirSync(subDir, { recursive: true });

        expect(isInsideRepoCheckout(subDir)).toBe(true);
    });

    test("returns false for unrelated repo with name other and no workspaces", () => {
        const repoDir = join(tmp, "unrelated-repo");
        mkdirSync(join(repoDir, ".git"), { recursive: true });
        writeFileSync(
            join(repoDir, "package.json"),
            JSON.stringify({ name: "other" }),
        );

        expect(isInsideRepoCheckout(repoDir)).toBe(false);
    });
});

// ── bun-tree detection (P1 regression) ────────────────────────────────────

describe("bun-tree detection (P1 regression)", () => {
    test("returns bun for execPath under ~/.bun/install/global/node_modules/...", async () => {
        const execPath = join(
            homedir(),
            ".bun",
            "install",
            "global",
            "node_modules",
            "@bastani",
            "atomic-linux-x64",
            "bin",
            "atomic",
        );
        const result = await detectInstallMethod({ execPath, skipProbe: true });
        expect(result.kind).toBe("bun");
        if (result.kind === "bun") {
            expect(result.binPath).toBe(execPath);
        }
    });

    test("returns bun for execPath under $BUN_INSTALL/install/... when BUN_INSTALL is set", async () => {
        const origEnv = process.env.BUN_INSTALL;
        process.env.BUN_INSTALL = "/opt/bun";
        try {
            const execPath =
                "/opt/bun/install/global/node_modules/@bastani/atomic-linux-x64/bin/atomic";
            const result = await detectInstallMethod({ execPath, skipProbe: true });
            expect(result.kind).toBe("bun");
            if (result.kind === "bun") {
                expect(result.binPath).toBe(execPath);
            }
        } finally {
            if (origEnv === undefined) {
                delete process.env.BUN_INSTALL;
            } else {
                process.env.BUN_INSTALL = origEnv;
            }
        }
    });

    test("bun-tree match wins over node_modules heuristic", async () => {
        // Regression guard: path contains /node_modules/ but must NOT classify as npm/pnpm/yarn.
        const execPath = join(
            homedir(),
            ".bun",
            "install",
            "global",
            "node_modules",
            "@bastani",
            "atomic-linux-x64",
            "bin",
            "atomic",
        );
        const result = await detectInstallMethod({ execPath, skipProbe: true });
        expect(result.kind).toBe("bun");
        expect(result.kind).not.toBe("npm");
        expect(result.kind).not.toBe("pnpm");
        expect(result.kind).not.toBe("yarn");
    });
});

// ── source / unknown via detectInstallMethod ───────────────────────────────

describe("detectInstallMethod source vs unknown", () => {
    test("returns source when cwd is inside a repo checkout", async () => {
        const repoDir = join(tmp, "atomic-source-repo");
        mkdirSync(join(repoDir, ".git"), { recursive: true });
        writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "atomic" }));
        const subDir = join(repoDir, "packages", "atomic", "src");
        mkdirSync(subDir, { recursive: true });

        const result = await detectInstallMethod({
            execPath: join(tmp, "random-bin", "atomic"),
            cwd: subDir,
            skipProbe: true,
        });
        expect(result.kind).toBe("source");
    });

    test("returns unknown for unrecognised exec path with non-repo cwd", async () => {
        const fakeExec = join(tmp, "random-bin", "atomic");
        mkdirSync(join(tmp, "random-bin"), { recursive: true });

        const result = await detectInstallMethod({
            execPath: fakeExec,
            cwd: tmp,
            skipProbe: true,
        });
        expect(result.kind).toBe("unknown");
    });
});
