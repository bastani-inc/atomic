/**
 * Win32 branch coverage for detectInstallMethod().
 *
 * Uses the `platform` field of DetectOptions to inject "win32" without
 * mocking node:os, so isolation is per-call and never leaks across files.
 *
 * LOCALAPPDATA is set/restored around each test so the win32 binDir path
 * (`process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")`)
 * yields the known fixture value.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { detectInstallMethod, _resetInstallMethodCache } from "./install-method.ts";

const FIX_LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local";
const ORIGINAL_LOCALAPPDATA = process.env.LOCALAPPDATA;

describe("detectInstallMethod (win32 platform mock)", () => {
    beforeEach(() => {
        _resetInstallMethodCache();
        process.env.LOCALAPPDATA = FIX_LOCALAPPDATA;
    });

    afterEach(() => {
        if (ORIGINAL_LOCALAPPDATA === undefined) {
            delete process.env.LOCALAPPDATA;
        } else {
            process.env.LOCALAPPDATA = ORIGINAL_LOCALAPPDATA;
        }
    });

    test("LOCALAPPDATA/atomic/bin/atomic.exe (win32) → binary", () => {
        const execPath = "C:\\Users\\test\\AppData\\Local\\atomic\\bin\\atomic.exe";
        expect(detectInstallMethod({ execPath, platform: "win32" })).toBe("binary");
    });

    test("execPath outside binDir falls through to unknown", () => {
        const execPath = "C:\\some\\random\\path\\atomic.exe";
        expect(detectInstallMethod({ execPath, platform: "win32" })).toBe("unknown");
    });

    test("LOCALAPPDATA/atomic/bin-other/atomic.exe (win32) → unknown (separator-anchored match)", () => {
        const execPath = "C:\\Users\\test\\AppData\\Local\\atomic\\bin-other\\atomic.exe";
        expect(detectInstallMethod({ execPath, platform: "win32" })).toBe("unknown");
    });
});
