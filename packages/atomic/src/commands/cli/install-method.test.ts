import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
    detectInstallMethod,
    _resetInstallMethodCache,
    type InstallMethod,
} from "./install-method.ts";

const home = homedir();

// Probe that always fails — used for unknown fallthrough
const noopProbe = (_cmd: string[]): { exitCode: number; stdout: string } => ({
    exitCode: 1,
    stdout: "",
});

describe("detectInstallMethod()", () => {
    beforeEach(() => {
        _resetInstallMethodCache();
    });

    // Case 1: Unix binary install path
    test("~/.local/bin/atomic → binary", () => {
        const execPath = join(home, ".local", "bin", "atomic");
        expect(detectInstallMethod({ execPath })).toBe("binary" satisfies InstallMethod);
    });

    // Case 3: bun global node_modules — path heuristic, no probe needed
    test("~/.bun/install/global/.../node_modules/@bastani/atomic/... → bun", () => {
        const execPath = join(
            home,
            ".bun",
            "install",
            "global",
            "node_modules",
            "@bastani",
            "atomic",
            "bin",
            "atomic",
        );
        let probeCallCount = 0;
        const countingProbe = (_cmd: string[]): { exitCode: number; stdout: string } => {
            probeCallCount++;
            return { exitCode: 1, stdout: "" };
        };
        expect(detectInstallMethod({ execPath, probe: countingProbe })).toBe("bun" satisfies InstallMethod);
        expect(probeCallCount).toBe(0);
    });

    // Case 4: pnpm global path heuristic
    test(".../pnpm/global/.../node_modules/@bastani/atomic/... → pnpm", () => {
        const execPath = join(
            home,
            ".local",
            "share",
            "pnpm",
            "global",
            "5",
            "node_modules",
            "@bastani",
            "atomic",
            "bin",
            "atomic",
        );
        expect(detectInstallMethod({ execPath, probe: noopProbe })).toBe("pnpm" satisfies InstallMethod);
    });

    // Case 5: ambiguous node_modules path + npm probe succeeds
    test("ambiguous node_modules + npm probe returns @bastani/atomic → npm", () => {
        const execPath = join(
            home,
            ".nvm",
            "versions",
            "node",
            "v20.0.0",
            "lib",
            "node_modules",
            "@bastani",
            "atomic",
            "bin",
            "atomic",
        );
        const probe = mock((cmd: string[]): { exitCode: number; stdout: string } => {
            // Only respond to `npm list -g`
            if (cmd[0] === "npm" && cmd.includes("list")) {
                return { exitCode: 0, stdout: "/usr/local/lib\n├── @bastani/atomic@0.7.8\n" };
            }
            return { exitCode: 1, stdout: "" };
        });
        expect(detectInstallMethod({ execPath, probe })).toBe("npm" satisfies InstallMethod);
    });

    // Case 6: execPath is bun binary itself → source
    test("/usr/bin/bun → source", () => {
        expect(detectInstallMethod({ execPath: "/usr/bin/bun", probe: noopProbe })).toBe("source" satisfies InstallMethod);
    });

    // Case 7: random path, all probes fail → unknown
    test("/tmp/random/atomic + all probes fail → unknown", () => {
        expect(detectInstallMethod({ execPath: "/tmp/random/atomic", probe: noopProbe })).toBe("unknown" satisfies InstallMethod);
    });

    // RFC §8.3 — per-platform suffix regression tests
    describe("per-platform suffix", () => {
        test("@bastani/atomic-linux-x64 under bun global → bun", () => {
            const execPath = join(
                home,
                ".bun",
                "install",
                "global",
                "node_modules",
                "@bastani",
                "atomic-linux-x64",
                "bin",
                "atomic",
            );
            expect(detectInstallMethod({ execPath, probe: noopProbe })).toBe("bun" satisfies InstallMethod);
        });

        test("@bastani/atomic-darwin-arm64 under bun global → bun", () => {
            const execPath = join(
                home,
                ".bun",
                "install",
                "global",
                "node_modules",
                "@bastani",
                "atomic-darwin-arm64",
                "bin",
                "atomic",
            );
            expect(detectInstallMethod({ execPath, probe: noopProbe })).toBe("bun" satisfies InstallMethod);
        });

        test("@bastani/atomic-linux-x64 under pnpm global → pnpm", () => {
            const execPath = join(
                home,
                ".local",
                "share",
                "pnpm",
                "global",
                "5",
                "node_modules",
                "@bastani",
                "atomic-linux-x64",
                "bin",
                "atomic",
            );
            expect(detectInstallMethod({ execPath, probe: noopProbe })).toBe("pnpm" satisfies InstallMethod);
        });

        test("@bastani/atomic-darwin-x64 under yarn global → yarn", () => {
            const execPath = join(
                home,
                ".config",
                "yarn",
                "global",
                "node_modules",
                "@bastani",
                "atomic-darwin-x64",
                "bin",
                "atomic",
            );
            expect(detectInstallMethod({ execPath, probe: noopProbe })).toBe("yarn" satisfies InstallMethod);
        });

        test("@bastani/atomic-linux-x64 under nvm + npm probe success → npm", () => {
            const execPath = join(
                home,
                ".nvm",
                "versions",
                "node",
                "v20.0.0",
                "lib",
                "node_modules",
                "@bastani",
                "atomic-linux-x64",
                "bin",
                "atomic",
            );
            const probe = mock((cmd: string[]): { exitCode: number; stdout: string } => {
                if (cmd[0] === "npm" && cmd.includes("list")) {
                    return { exitCode: 0, stdout: "/usr/local/lib\n├── @bastani/atomic@0.7.8\n" };
                }
                return { exitCode: 1, stdout: "" };
            });
            expect(detectInstallMethod({ execPath, probe })).toBe("npm" satisfies InstallMethod);
        });

        test("@bastani-evil/atomic-linux-x64 must NOT match scope boundary → unknown", () => {
            const execPath = join(
                home,
                ".bun",
                "install",
                "global",
                "node_modules",
                "@bastani-evil",
                "atomic-linux-x64",
                "bin",
                "atomic",
            );
            expect(detectInstallMethod({ execPath, probe: noopProbe })).toBe("unknown" satisfies InstallMethod);
        });
    });

    // defaultProbe branch tests — use spyOn so no probe injection required
    describe("defaultProbe", () => {
        let spawnSyncSpy: ReturnType<typeof spyOn<typeof Bun, "spawnSync">>;

        afterEach(() => {
            spawnSyncSpy.mockRestore();
        });

        // Ambiguous path: matches PKG_PATH_RE but none of the cheap heuristics
        const ambiguousExecPath = "/some/other/global/node_modules/@bastani/atomic/bin/atomic";

        test("happy path: first probe (bun pm ls -g) succeeds → bun", () => {
            const fakeResult = {
                exitCode: 0,
                stdout: Buffer.from("@bastani/atomic@0.7.8\n"),
                stderr: Buffer.from(""),
                success: true,
                pid: 0,
                signalCode: null,
                resourceUsage: undefined,
            } as unknown as ReturnType<typeof Bun.spawnSync>;
            spawnSyncSpy = spyOn(Bun, "spawnSync").mockReturnValue(fakeResult);
            _resetInstallMethodCache();
            const result = detectInstallMethod({ execPath: ambiguousExecPath });
            expect(result).toBe("bun" satisfies InstallMethod);
            // Verify spy was called with the bun probe options object
            const firstCallArgs = spawnSyncSpy.mock.calls[0];
            expect(firstCallArgs).toBeDefined();
            const firstArg = firstCallArgs?.[0] as unknown as { cmd: string[] };
            expect(firstArg.cmd).toEqual(["bun", "pm", "ls", "-g"]);
        });

        test("throw path: all Bun.spawnSync calls throw → npm fallback", () => {
            spawnSyncSpy = spyOn(Bun, "spawnSync").mockImplementation((() => {
                throw new Error("ENOENT");
            }) as never);
            _resetInstallMethodCache();
            const result = detectInstallMethod({ execPath: ambiguousExecPath });
            expect(result).toBe("npm" satisfies InstallMethod);
        });
    });

    // npm fallback: injected probe always fails (non-zero exitCode)
    test("npm fallback: all probes return exitCode 1 → npm", () => {
        const execPath =
            "/home/test/.nvm/versions/node/v20.0.0/lib/node_modules/@bastani/atomic/bin/atomic";
        const result = detectInstallMethod({
            execPath,
            probe: () => ({ exitCode: 1, stdout: "" }),
        });
        expect(result).toBe("npm" satisfies InstallMethod);
    });

    // Iter 5 regression: separator-anchored binDir match
    test("~/.local/bin-other/atomic → unknown (not binary)", () => {
        const execPath = join(home, ".local", "bin-other", "atomic");
        expect(detectInstallMethod({ execPath, probe: noopProbe })).toBe("unknown" satisfies InstallMethod);
    });

    test("~/.local/binx/atomic → unknown (not binary)", () => {
        const execPath = join(home, ".local", "binx", "atomic");
        expect(detectInstallMethod({ execPath, probe: noopProbe })).toBe("unknown" satisfies InstallMethod);
    });

    // Iter 5 regression: probe-only override must not poison cache for subsequent no-override reads
    test("cache symmetry — probe-only override does not poison subsequent no-override read", () => {
        // First call: probe-only override — returns bun via stdout match on ambiguous path.
        const probeReturningBun = (_cmd: string[]): { exitCode: number; stdout: string } => ({
            exitCode: 0,
            stdout: "@bastani/atomic",
        });
        const ambiguousExecPath = "/some/other/global/node_modules/@bastani/atomic/bin/atomic";
        const first = detectInstallMethod({ execPath: ambiguousExecPath, probe: probeReturningBun });
        expect(first).toBe("bun" satisfies InstallMethod);

        // Second call: no overrides — must resolve from real process.execPath (bun runtime → "source"),
        // NOT from the bun result returned by the probe above.
        const second = detectInstallMethod();
        expect(second).toBe("source" satisfies InstallMethod);
    });

    test("cache poison guard: override call must not populate module cache", () => {
        const bunFixture = join(
            home,
            ".bun",
            "install",
            "global",
            "node_modules",
            "@bastani",
            "atomic-linux-x64",
            "bin",
            "atomic",
        );
        // First call WITH override — must not write cache
        expect(detectInstallMethod({ execPath: bunFixture, probe: noopProbe })).toBe("bun" satisfies InstallMethod);
        // Second call WITHOUT override — must resolve from real process.execPath, not cached "bun".
        // In bun:test environment process.execPath is the bun host binary, so result is "source".
        const second = detectInstallMethod();
        expect(second).not.toBe("bun");
        expect(second).toBe("source" satisfies InstallMethod);
    });
});
