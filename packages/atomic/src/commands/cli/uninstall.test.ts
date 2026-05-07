/**
 * Branch tests for uninstallCommand().
 *
 * Policy:
 *   - binary install         → full cleanup (launcher / rc / completions; --purge nukes ~/.atomic).
 *   - bun/npm/pnpm/yarn      → refuse with hint pointing at the pm's own remove command, exit 1.
 *   - source/unknown         → refuse with execPath hint, exit 1.
 *
 * Test isolation (RFC §5.4): a per-suite mkdtempSync HOME redirect plus
 * a node:os.homedir() override (via mock.module) keeps every fs touch
 * inside a tmp dir, so the binary branch can run without affecting the
 * real HOME. The pm and source/unknown branches must never touch the
 * filesystem at all — those tests assert `fs.rmSync` was never called.
 */

import {
    afterAll,
    afterEach,
    beforeEach,
    describe,
    expect,
    mock,
    spyOn,
    test,
} from "bun:test";
import * as fs from "node:fs";
import * as nodeOs from "node:os";
import { join } from "node:path";
import type { InstallMethod } from "./install-method.ts";

// ─── tmp HOME isolation ──────────────────────────────────────────────────────
// Bun's native homedir() caches the OS value at startup and ignores $HOME
// mutations. Intercept via mock.module("node:os") so install.ts and any
// test body see the tmp dir. Bootstrapped at module-eval time so the mock
// takes effect before the first dynamic import in loadUninstall().

const tmpHome = fs.mkdtempSync(join(nodeOs.tmpdir(), "atomic-uninstall-test-"));
const origHome = process.env.HOME;
const origUserProfile = process.env.USERPROFILE;
const origLocalAppData = process.env.LOCALAPPDATA;
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.LOCALAPPDATA = join(tmpHome, "AppData", "Local");

await mock.module("node:os", () => ({
    ...nodeOs,
    homedir: () => tmpHome,
}));

afterAll(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;
    if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = origLocalAppData;
});

test("env-redirect: HOME and homedir() both point at tmpHome", () => {
    expect(process.env.HOME).toBe(tmpHome);
    expect(nodeOs.homedir()).toBe(tmpHome);
});

// ─── helpers ─────────────────────────────────────────────────────────────────

interface CapturedIO {
    readonly stdout: string[];
    readonly stderr: string[];
    readonly restore: () => void;
}

function captureIO(): CapturedIO {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const outSpy = spyOn(process.stdout, "write").mockImplementation(
        (chunk: unknown) => { stdout.push(String(chunk)); return true; },
    );
    const errSpy = spyOn(process.stderr, "write").mockImplementation(
        (chunk: unknown) => { stderr.push(String(chunk)); return true; },
    );
    return {
        stdout,
        stderr,
        restore: () => { outSpy.mockRestore(); errSpy.mockRestore(); },
    };
}

interface FsMocksOpts {
    /** When true, also mock unlinkSync/append/write/rename/exists so the binary branch is deterministic. */
    readonly binaryBranch?: boolean;
    /** Custom impl for fs.rmSync; defaults to no-op. */
    readonly rmImpl?: (path: fs.PathLike) => void;
}

interface FsMocksCtx {
    io: CapturedIO;
    rm: ReturnType<typeof spyOn<typeof fs, "rmSync">>;
    fsSpy?: {
        unlink: ReturnType<typeof spyOn<typeof fs, "unlinkSync">>;
        append: ReturnType<typeof spyOn<typeof fs, "appendFileSync">>;
        write: ReturnType<typeof spyOn<typeof fs, "writeFileSync">>;
        rename: ReturnType<typeof spyOn<typeof fs, "renameSync">>;
        exists: ReturnType<typeof spyOn<typeof fs, "existsSync">>;
    };
}

function withFsMocks(opts: FsMocksOpts = {}): FsMocksCtx {
    const rmImpl = opts.rmImpl ?? (() => {});
    const ctx = {} as FsMocksCtx;

    beforeEach(() => {
        ctx.io = captureIO();
        ctx.rm = spyOn(fs, "rmSync").mockImplementation(
            ((path: fs.PathLike) => rmImpl(path)) as unknown as typeof fs.rmSync,
        );
        if (opts.binaryBranch) {
            ctx.fsSpy = {
                unlink: spyOn(fs, "unlinkSync").mockImplementation((() => {}) as unknown as typeof fs.unlinkSync),
                append: spyOn(fs, "appendFileSync").mockImplementation((() => {}) as unknown as typeof fs.appendFileSync),
                write: spyOn(fs, "writeFileSync").mockImplementation((() => {}) as unknown as typeof fs.writeFileSync),
                rename: spyOn(fs, "renameSync").mockImplementation((() => {}) as unknown as typeof fs.renameSync),
                exists: spyOn(fs, "existsSync").mockImplementation((() => false) as unknown as typeof fs.existsSync),
            };
        }
    });

    afterEach(() => {
        ctx.io.restore();
        ctx.rm.mockRestore();
        if (ctx.fsSpy) {
            for (const spy of Object.values(ctx.fsSpy)) spy.mockRestore();
        }
    });

    return ctx;
}

/**
 * Binds uninstallCommand to a fixed install method via the `detectInstall`
 * test seam. Avoids mock.module() pollution of install-method.ts so the
 * detector tests in install-method.test.ts see the real implementation.
 */
async function loadUninstall(method: InstallMethod): Promise<{
    uninstallCommand: (opts?: { purge?: boolean }) => Promise<number>;
}> {
    const mod = await import("./install.ts");
    const detectInstall = () => method;
    return {
        uninstallCommand: (opts = {}) => mod.uninstallCommand({ ...opts, detectInstall }),
    };
}

// ─── binary branch ───────────────────────────────────────────────────────────

describe("uninstallCommand — binary branch", () => {
    const ctx = withFsMocks({ binaryBranch: true });

    test("binary: prints uninstall lines + exits 0", async () => {
        const { uninstallCommand } = await loadUninstall("binary");
        expect(await uninstallCommand({})).toBe(0);
        const out = ctx.io.stdout.join("");
        expect(out).toContain("Uninstalling atomic (install method: binary)");
        expect(out).toContain("Atomic uninstalled");
    });

    test("binary: completions cache reaped when --purge absent", async () => {
        const completionsDir = join(nodeOs.homedir(), ".atomic", "completions");
        const { uninstallCommand } = await loadUninstall("binary");
        expect(await uninstallCommand({})).toBe(0);
        const completionsCall = ctx.rm.mock.calls.find(
            (args) => String(args[0]) === completionsDir,
        );
        expect(completionsCall).toBeDefined();
        expect(completionsCall?.[1]).toMatchObject({ recursive: true, force: true });
    });

    test("binary --purge: ~/.atomic wiped; completions not reaped explicitly (subsumed)", async () => {
        const atomicHome = join(nodeOs.homedir(), ".atomic");
        const completionsDir = join(atomicHome, "completions");
        const { uninstallCommand } = await loadUninstall("binary");
        expect(await uninstallCommand({ purge: true })).toBe(0);
        expect(ctx.rm.mock.calls.find((args) => String(args[0]) === atomicHome)).toBeDefined();
        expect(ctx.rm.mock.calls.find((args) => String(args[0]) === completionsDir)).toBeUndefined();
    });
});

// ── purge throws — needs its own describe to register a different rmImpl ────

describe("uninstallCommand — binary --purge: rmSync throws", () => {
    const atomicHome = join(nodeOs.homedir(), ".atomic");
    const ctx = withFsMocks({
        binaryBranch: true,
        rmImpl: (path) => {
            if (String(path) === atomicHome) throw new Error("EACCES: permission denied");
        },
    });

    test("rmSync(~/.atomic) throws → stderr has 'could not purge' hint, exit 0", async () => {
        const { uninstallCommand } = await loadUninstall("binary");
        expect(await uninstallCommand({ purge: true })).toBe(0);
        expect(ctx.io.stderr.join("")).toContain("could not purge");
    });
});

// ─── pm-managed installs: refuse with hint, exit 1 ───────────────────────────

const pmHints: ReadonlyArray<{ method: InstallMethod; hint: string }> = [
    { method: "bun",  hint: "bun remove -g @bastani/atomic" },
    { method: "npm",  hint: "npm uninstall -g @bastani/atomic" },
    { method: "pnpm", hint: "pnpm remove -g @bastani/atomic" },
    { method: "yarn", hint: "yarn global remove @bastani/atomic" },
];

for (const { method, hint } of pmHints) {
    describe(`uninstallCommand — ${method} branch (refuses)`, () => {
        const ctx = withFsMocks();

        test(`${method}: exit 1, stderr cites pm + hint, no fs.rmSync touches`, async () => {
            const { uninstallCommand } = await loadUninstall(method);
            expect(await uninstallCommand({})).toBe(1);
            const err = ctx.io.stderr.join("");
            expect(err).toContain(`atomic was installed via ${method}`);
            expect(err).toContain(hint);
            // Refusal must not touch ~/.atomic or completions cache.
            expect(ctx.rm.mock.calls.length).toBe(0);
        });

        test(`${method} + --purge: still refuses; ~/.atomic untouched`, async () => {
            const { uninstallCommand } = await loadUninstall(method);
            expect(await uninstallCommand({ purge: true })).toBe(1);
            expect(ctx.io.stderr.join("")).toContain(hint);
            expect(ctx.rm.mock.calls.length).toBe(0);
        });
    });
}

// ─── source / unknown: refuse with execPath hint, exit 1 ─────────────────────

for (const method of ["source", "unknown"] as const) {
    describe(`uninstallCommand — ${method} branch (refuses)`, () => {
        const ctx = withFsMocks();

        test(`${method}: exit 1, stderr cites execPath, no fs.rmSync touches`, async () => {
            const { uninstallCommand } = await loadUninstall(method);
            expect(await uninstallCommand({})).toBe(1);
            const err = ctx.io.stderr.join("");
            expect(err).toContain("atomic appears to run from");
            expect(err).toContain(process.execPath);
            expect(ctx.rm.mock.calls.length).toBe(0);
        });
    });
}
