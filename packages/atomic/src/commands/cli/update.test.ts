/**
 * Integration tests for `updateCommand` orchestrator.
 *
 * Mocking strategy:
 *   - mock.module() at file level for ES module seams that don't leak into
 *     other test files: @clack/prompts, install-method.ts, release-fetch.ts,
 *     version.ts.
 *   - spyOn(installModule, ...) for install.ts — `mock.module("./install.ts")`
 *     leaks across test files (oven-sh/bun#12823) and breaks install.test.ts
 *     when both files run in the same `bun test` invocation.
 *   - mutable variables closed over by the factories so per-test return values work.
 *   - spyOn(Bun, "spawn") / spyOn(Bun, "spawnSync") for process-dispatch tests.
 *   - updateCommand is dynamically imported AFTER mocks are registered.
 */

import {
    describe,
    test,
    expect,
    beforeEach,
    afterAll,
    mock,
    spyOn,
} from "bun:test";
import { writeFileSync } from "node:fs";
import * as realClack from "@clack/prompts";
import * as installMethodModule from "../../services/system/install-method.ts";
import type { InstallMethod } from "../../services/system/install-method.ts";
import * as releaseFetchModule from "../../services/system/release-fetch.ts";
import type { ReleaseInfo, Manifest } from "../../services/system/release-fetch.ts";
import type { InstallPaths } from "./install.ts";
// Host-derived fixtures: mirror the production `hostTarget()` in update.ts:46-49.
// We compute inline (rather than `import { hostTarget } from "../../../script/targets.ts"`)
// because tsconfig sets `rootDir: "src"`, which forbids src files from importing
// out-of-tree script/. Both production and tests still derive identically from
// process.platform / process.arch — the single-source-of-truth property holds.
const IS_WINDOWS_HOST = process.platform === "win32";
const HOST = `${IS_WINDOWS_HOST ? "windows" : process.platform}-${process.arch}`;
const HOST_ASSET = `atomic-${HOST}${IS_WINDOWS_HOST ? ".exe" : ""}`;

// ── Fake install paths ────────────────────────────────────────────────────────

const FAKE_PATHS: InstallPaths = {
    binDir: "/tmp/atomic-test-bin",
    binPath: "/tmp/atomic-test-bin/atomic",
    completionsDir: "/tmp/atomic-test-completions",
};

// ── @clack/prompts stubs ──────────────────────────────────────────────────────

const logInfoMock = mock((_msg: string) => {});
const logErrorMock = mock((_msg: string) => {});
const logSuccessMock = mock((_msg: string) => {});
const noteMock = mock((_msg: string, _title?: string) => {});
const spinnerStartMock = mock((_msg: string) => {});
const spinnerStopMock = mock((_msg: string) => {});
const spinnerMock = mock(() => ({ start: spinnerStartMock, stop: spinnerStopMock }));

// Spread the real module so every export (cancel, select, isCancel, log.warn,
// etc.) stays available — `mock.module()` is process-global in Bun
// (oven-sh/bun#12823) and a partial replacement breaks unrelated test files
// that import the missing names from `@clack/prompts` later in the same
// `bun test` run (e.g. session.test.ts → session.ts → import { cancel }).
await mock.module("@clack/prompts", () => ({
    ...realClack,
    log: {
        ...realClack.log,
        info: logInfoMock,
        error: logErrorMock,
        success: logSuccessMock,
    },
    note: noteMock,
    spinner: spinnerMock,
}));

// ── install-method.ts spy ─────────────────────────────────────────────────────
//
// We deliberately do NOT use `mock.module("../../services/system/install-method.ts", ...)`
// here: Bun's `mock.module()` is process-global and the stub object's missing
// named exports surface as `SyntaxError: Export named '<x>' not found in module`
// in unrelated test files (install-method.test.ts) that import the real module
// later in the same `bun test` run. spyOn returns Bun mock instances that
// support `.mockClear()` / `.mockImplementation(...)` like top-level `mock()`
// and is reverted via `.mockRestore()` in `afterAll`.

let detectInstallMethodResult: InstallMethod = { kind: "unknown" };
const detectInstallMethodMock = spyOn(installMethodModule, "detectInstallMethod").mockImplementation(
    async (): Promise<InstallMethod> => detectInstallMethodResult,
);

// ── release-fetch.ts spies ────────────────────────────────────────────────────
//
// Same rationale as install-method.ts above — `mock.module()` of release-fetch.ts
// breaks release-fetch.test.ts's real-module imports (e.g. `downloadAsset`,
// `ATOMIC_PACKAGE_NAME`) when both files run in the same `bun test` run.

const FAKE_RELEASE: ReleaseInfo = {
    tag_name: "v0.9.0",
    assets: [
        {
            name: HOST_ASSET,
            browser_download_url: `https://example.com/${HOST_ASSET}`,
        },
        {
            name: "manifest.json",
            browser_download_url: "https://example.com/manifest.json",
        },
    ],
};

const getLatestReleaseMock = spyOn(releaseFetchModule, "getLatestRelease").mockImplementation(
    async (): Promise<ReleaseInfo> => FAKE_RELEASE,
);
const getReleaseByTagMock = spyOn(releaseFetchModule, "getReleaseByTag").mockImplementation(
    async (_tag: string): Promise<ReleaseInfo> => FAKE_RELEASE,
);
const downloadAssetFromUrlMock = spyOn(releaseFetchModule, "downloadAssetFromUrl").mockImplementation(
    async (_url: string, _dest: string): Promise<void> => {},
);
const verifyChecksumMock = spyOn(releaseFetchModule, "verifyChecksum").mockImplementation(
    async (_path: string, _checksum: string): Promise<void> => {},
);
const isNewerMock = spyOn(releaseFetchModule, "isNewer").mockImplementation(
    (_tag: string, _current: string): boolean => true,
);
const normalizeVersionMock = spyOn(releaseFetchModule, "normalizeVersion").mockImplementation(
    (input: string): string => {
        const t = input.trim();
        if (t.toLowerCase() === "latest") return "latest";
        return t.replace(/^v/, "");
    },
);

// ── install.ts spies ──────────────────────────────────────────────────────────
//
// We deliberately do NOT use `mock.module("./install.ts", ...)` here:
// Bun's `mock.module()` is process-global and leaks across test files when
// `bun test` runs the entire suite in one process (oven-sh/bun#12823). That
// breaks install.test.ts, which imports many real install.ts symbols.
//
// Instead, we `spyOn(installModule, "<name>")` to override the three functions
// updateCommand depends on. spyOn returns Bun mock instances that support
// `.mockImplementation(...)` / `.mockClear()` exactly like top-level mocks,
// and `mock.restore()` (called from `afterAll`) reverts them so the real
// module is intact for other test files.

import * as installModule from "./install.ts";

const getInstallPathsMock = spyOn(installModule, "getInstallPaths").mockImplementation(
    (): InstallPaths => FAKE_PATHS,
);
const copyBinaryMock = spyOn(installModule, "copyBinary").mockImplementation(
    (_paths: InstallPaths, _source?: string): void => {},
);
const cleanupOldArtifactsMock = spyOn(installModule, "cleanupOldArtifacts").mockImplementation(
    (_binDir: string) => ({ oldBinariesRemoved: 0, tempFilesRemoved: 0 }),
);

// ── version.ts stub ───────────────────────────────────────────────────────────

await mock.module("../../version.ts", () => ({
    VERSION: "0.7.8",
}));

// ── Load updateCommand after all mocks are registered ─────────────────────────

const { updateCommand } = await import("./update.ts");

afterAll(() => {
    // Restore spies so other test files in the same `bun test` process see
    // the real module exports — see comments above each `spyOn(...)` block.
    detectInstallMethodMock.mockRestore();
    getLatestReleaseMock.mockRestore();
    getReleaseByTagMock.mockRestore();
    downloadAssetFromUrlMock.mockRestore();
    verifyChecksumMock.mockRestore();
    isNewerMock.mockRestore();
    normalizeVersionMock.mockRestore();
    getInstallPathsMock.mockRestore();
    copyBinaryMock.mockRestore();
    cleanupOldArtifactsMock.mockRestore();
});

// ── Manifest JSON for binary tests ───────────────────────────────────────────

function makeManifestContent(): string {
    const manifest: Manifest = {
        version: "0.9.0",
        platforms: {
            [HOST]: { checksum: "abc123" },
        },
    };
    return JSON.stringify(manifest);
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
    // Reset all call counts
    logInfoMock.mockClear();
    logErrorMock.mockClear();
    logSuccessMock.mockClear();
    noteMock.mockClear();
    spinnerStartMock.mockClear();
    spinnerStopMock.mockClear();
    spinnerMock.mockClear();
    detectInstallMethodMock.mockClear();
    getLatestReleaseMock.mockClear();
    getReleaseByTagMock.mockClear();
    downloadAssetFromUrlMock.mockClear();
    verifyChecksumMock.mockClear();
    isNewerMock.mockClear();
    normalizeVersionMock.mockClear();
    getInstallPathsMock.mockClear();
    copyBinaryMock.mockClear();
    cleanupOldArtifactsMock.mockClear();

    // Reset defaults
    detectInstallMethodResult = { kind: "unknown" };
    getLatestReleaseMock.mockImplementation(async () => FAKE_RELEASE);
    getReleaseByTagMock.mockImplementation(async (_tag: string) => FAKE_RELEASE);
    downloadAssetFromUrlMock.mockImplementation(async (_url: string, _dest: string) => {});
    verifyChecksumMock.mockImplementation(async () => {});
    isNewerMock.mockImplementation(() => true);
    normalizeVersionMock.mockImplementation((input: string) => {
        const t = input.trim();
        if (t.toLowerCase() === "latest") return "latest";
        return t.replace(/^v/, "");
    });
    getInstallPathsMock.mockImplementation(() => FAKE_PATHS);
    copyBinaryMock.mockImplementation(() => {});
    cleanupOldArtifactsMock.mockImplementation(() => ({ oldBinariesRemoved: 0, tempFilesRemoved: 0 }));
});

// ── describe block ────────────────────────────────────────────────────────────

describe("updateCommand", () => {
    test("binary up-to-date short-circuit", async () => {
        detectInstallMethodResult = { kind: "binary", binPath: FAKE_PATHS.binPath };
        isNewerMock.mockImplementation(() => false);

        const spawnSpy = spyOn(Bun, "spawn");

        try {
            const code = await updateCommand({});
            expect(code).toBe(0);
            expect(spawnSpy).not.toHaveBeenCalled();
            const allInfoCalls = logInfoMock.mock.calls.map((c) => String(c[0]));
            expect(allInfoCalls.some((m) => m.includes("Already up to date"))).toBe(true);
        } finally {
            spawnSpy.mockRestore();
        }
    });

    test("binary --check prints metadata note", async () => {
        detectInstallMethodResult = { kind: "binary", binPath: FAKE_PATHS.binPath };
        isNewerMock.mockImplementation(() => true);

        const code = await updateCommand({ check: true });
        expect(code).toBe(0);
        expect(noteMock).toHaveBeenCalledTimes(1);
        // note text should contain version metadata
        const noteArgs = noteMock.mock.calls[0] as [string, string?];
        expect(noteArgs[0]).toContain("current=");
        expect(downloadAssetFromUrlMock).not.toHaveBeenCalled();
    });

    test("binary happy path", async () => {
        detectInstallMethodResult = { kind: "binary", binPath: FAKE_PATHS.binPath };
        isNewerMock.mockImplementation(() => true);

        // downloadAssetFromUrl for manifest writes real JSON so readFileSync can parse it
        downloadAssetFromUrlMock.mockImplementation(async (_url: string, dest: string) => {
            if (dest.endsWith("manifest.json")) {
                writeFileSync(dest, makeManifestContent());
            }
            // binary dest: leave as empty file (verifyChecksum is mocked)
        });

        const spawnSyncSpy = spyOn(Bun, "spawnSync").mockReturnValue({
            exitCode: 0,
            stdout: Buffer.from("atomic 0.9.0"),
            stderr: Buffer.from(""),
            success: true,
        } as ReturnType<typeof Bun.spawnSync>);

        try {
            const code = await updateCommand({});
            expect(code).toBe(0);
            expect(copyBinaryMock).toHaveBeenCalledTimes(1);
            // copyBinary first arg is paths, second is assetDest
            const [, assetDest] = copyBinaryMock.mock.calls[0] as [InstallPaths, string];
            expect(assetDest).toContain(HOST_ASSET);
        } finally {
            spawnSyncSpy.mockRestore();
        }
    });

    // ── PM-managed installs: atomic update is intentionally NOT dispatched
    //    to the PM. Users are told to run `<pm> update -g` themselves so the
    //    PM remains the single source of truth for global packages.
    type PmCase = { kind: "bun" | "npm" | "pnpm" | "yarn"; hint: string };
    const PM_CASES: readonly PmCase[] = [
        { kind: "bun",  hint: "bun update -g @bastani/atomic" },
        { kind: "npm",  hint: "npm update -g @bastani/atomic" },
        { kind: "pnpm", hint: "pnpm update -g @bastani/atomic" },
        { kind: "yarn", hint: "yarn global upgrade @bastani/atomic" },
    ];

    for (const { kind, hint } of PM_CASES) {
        test(`${kind} install: rejects update with PM hint, never spawns`, async () => {
            detectInstallMethodResult = { kind, binPath: `/fake/${kind}/atomic` };
            const spawnSpy = spyOn(Bun, "spawn");
            try {
                const code = await updateCommand({});
                expect(code).toBe(1);
                expect(spawnSpy).not.toHaveBeenCalled();
                const errorCalls = logErrorMock.mock.calls.map((c) => String(c[0]));
                const infoCalls = logInfoMock.mock.calls.map((c) => String(c[0]));
                const allLogs = [...errorCalls, ...infoCalls].join("\n");
                expect(allLogs).toContain(`not available for ${kind}`);
                expect(allLogs).toContain(hint);
            } finally {
                spawnSpy.mockRestore();
            }
        });

        test(`${kind} install: --check renders PM hint, exits 0, never spawns`, async () => {
            detectInstallMethodResult = { kind, binPath: `/fake/${kind}/atomic` };
            const spawnSpy = spyOn(Bun, "spawn");
            try {
                const code = await updateCommand({ check: true });
                expect(code).toBe(0);
                expect(spawnSpy).not.toHaveBeenCalled();
                const noteCalls = noteMock.mock.calls.map((c) => String(c[0]));
                expect(noteCalls.some((m) => m.includes(`installed via ${kind}`) && m.includes(hint))).toBe(true);
            } finally {
                spawnSpy.mockRestore();
            }
        });
    }

    test("source exits non-zero with guidance", async () => {
        detectInstallMethodResult = { kind: "source" };

        const spawnSpy = spyOn(Bun, "spawn");

        try {
            const code = await updateCommand({});
            expect(code).toBe(1);
            expect(spawnSpy).not.toHaveBeenCalled();
            const errorCalls = logErrorMock.mock.calls.map((c) => String(c[0]));
            const infoCalls = logInfoMock.mock.calls.map((c) => String(c[0]));
            const allLogs = [...errorCalls, ...infoCalls].join("\n");
            expect(allLogs).toContain("git pull && bun install");
        } finally {
            spawnSpy.mockRestore();
        }
    });

    test("unknown emits installer guidance, not git hint", async () => {
        detectInstallMethodResult = { kind: "unknown" };

        const spawnSpy = spyOn(Bun, "spawn");

        try {
            const code = await updateCommand({});
            expect(code).toBe(1);
            expect(spawnSpy).not.toHaveBeenCalled();
            const errorCalls = logErrorMock.mock.calls.map((c) => String(c[0]));
            const infoCalls = logInfoMock.mock.calls.map((c) => String(c[0]));
            const allLogs = [...errorCalls, ...infoCalls].join("\n");
            expect(allLogs).toMatch(/installer|package manager/i);
            expect(allLogs).not.toContain("git pull");
        } finally {
            spawnSpy.mockRestore();
        }
    });

    test("binary path: missing host asset returns 1 with error", async () => {
        detectInstallMethodResult = { kind: "binary", binPath: FAKE_PATHS.binPath };
        isNewerMock.mockImplementation(() => true);
        // Replace release with one that is missing the host asset.
        getLatestReleaseMock.mockImplementation(async () => ({
            tag_name: "v0.9.0",
            assets: [{ name: "manifest.json", browser_download_url: "https://example.com/manifest.json" }],
        }));

        const code = await updateCommand({});
        expect(code).toBe(1);
        const errorCalls = logErrorMock.mock.calls.map((c) => String(c[0]));
        expect(errorCalls.some((m) => m.includes(HOST_ASSET) && m.includes("not found"))).toBe(true);
    });

    test("binary path: missing manifest asset returns 1 with error", async () => {
        detectInstallMethodResult = { kind: "binary", binPath: FAKE_PATHS.binPath };
        isNewerMock.mockImplementation(() => true);
        getLatestReleaseMock.mockImplementation(async () => ({
            tag_name: "v0.9.0",
            assets: [{ name: HOST_ASSET, browser_download_url: `https://example.com/${HOST_ASSET}` }],
        }));

        const code = await updateCommand({});
        expect(code).toBe(1);
        const errorCalls = logErrorMock.mock.calls.map((c) => String(c[0]));
        expect(errorCalls.some((m) => m.includes("manifest.json") && m.includes("not found"))).toBe(true);
    });

    test("--version 0.7.5 pinned skips isNewer", async () => {
        detectInstallMethodResult = { kind: "binary", binPath: FAKE_PATHS.binPath };
        // isNewer returns false (would short-circuit if pinned check is absent)
        isNewerMock.mockImplementation(() => false);
        normalizeVersionMock.mockImplementation((input: string) => {
            const t = input.trim();
            if (t.toLowerCase() === "latest") return "latest";
            return t.replace(/^v/, "");
        });

        downloadAssetFromUrlMock.mockImplementation(async (_url: string, dest: string) => {
            if (dest.endsWith("manifest.json")) {
                writeFileSync(dest, makeManifestContent());
            }
        });

        const spawnSyncSpy = spyOn(Bun, "spawnSync").mockReturnValue({
            exitCode: 0,
            stdout: Buffer.from("atomic 0.7.5"),
            stderr: Buffer.from(""),
            success: true,
        } as ReturnType<typeof Bun.spawnSync>);

        try {
            const code = await updateCommand({ version: "0.7.5" });
            expect(code).toBe(0);
            // copyBinary must have been called — pinned version skips isNewer
            expect(copyBinaryMock).toHaveBeenCalledTimes(1);
        } finally {
            spawnSyncSpy.mockRestore();
        }
    });

    test("sanity check failure surfaces error", async () => {
        detectInstallMethodResult = { kind: "binary", binPath: FAKE_PATHS.binPath };
        isNewerMock.mockImplementation(() => true);

        downloadAssetFromUrlMock.mockImplementation(async (_url: string, dest: string) => {
            if (dest.endsWith("manifest.json")) {
                writeFileSync(dest, makeManifestContent());
            }
        });

        const spawnSyncSpy = spyOn(Bun, "spawnSync").mockReturnValue({
            exitCode: 1,
            stdout: Buffer.from(""),
            stderr: Buffer.from("error"),
            success: false,
        } as ReturnType<typeof Bun.spawnSync>);

        try {
            const code = await updateCommand({});
            expect(code).toBe(1);
            const errorCalls = logErrorMock.mock.calls.map((c) => String(c[0]));
            expect(errorCalls.some((m) => m.includes("Sanity check failed"))).toBe(true);
        } finally {
            spawnSyncSpy.mockRestore();
        }
    });

});
