/**
 * RFC §8.3 branch tests for uninstallCommand().
 *
 * TEST ISOLATION CONTRACT (RFC §5.4):
 * Any test in this file that imports `./install.ts` (directly or via
 * loadUninstall) MUST run inside the env-redirect block established by
 * the top-level beforeAll/afterAll. The redirect points HOME, USERPROFILE,
 * and LOCALAPPDATA at a per-suite mkdtempSync(...) directory, so every
 * homedir() callsite in install.ts and install-method.ts lands inside the
 * tmp dir. The binary-branch describe additionally mocks fs.unlinkSync /
 * appendFileSync / writeFileSync / renameSync / existsSync / rmSync so
 * the run is deterministic regardless of stray sentinel files inside
 * tmpHome.
 *
 * Each describe re-imports uninstallCommand via `loadUninstall(method)` so
 * the mocked `detectInstallMethod` takes effect for that module load.
 */

import {
    describe,
    test,
    expect,
    afterAll,
    beforeEach,
    afterEach,
    spyOn,
    mock,
} from "bun:test";
import * as fs from "node:fs";
import * as nodeOs from "node:os";
import { join } from "node:path";
import type { InstallMethod } from "./install-method.ts";

// ─── tmp HOME isolation (RFC §5.4) ────────────────────────────────────────────
// Bun's native homedir() caches the OS value at startup and ignores $HOME
// mutations. We intercept it via mock.module("node:os") so every callsite
// (install.ts, install-method.ts, and test bodies) sees the tmp dir.
//
// Bootstrapped at module evaluation time so mock.module takes effect before
// the first dynamic import in loadUninstall — no beforeAll needed.

const tmpHome = fs.mkdtempSync(join(nodeOs.tmpdir(), "atomic-uninstall-test-"));
const origHome = process.env.HOME;
const origUserProfile = process.env.USERPROFILE;
const origLocalAppData = process.env.LOCALAPPDATA;
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.LOCALAPPDATA = join(tmpHome, "AppData", "Local");

// Override homedir() for every module loaded in this test file.
// The proxy forwards every other os export unchanged.
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

// ─── self-check (RFC §5.4): env-redirect must be active before any test ───────

test("env-redirect: HOME and homedir() both point at tmpHome", () => {
    // Fails loud if a future refactor short-circuits the redirect.
    expect(process.env.HOME).toBe(tmpHome);
    expect(nodeOs.homedir()).toBe(tmpHome);
});

// ─── helpers ──────────────────────────────────────────────────────────────────

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

interface SpawnStub {
    readonly spy: ReturnType<typeof spyOn<typeof Bun, "spawn">>;
    readonly calls: { cmd: string[] }[];
}

function makeSpawnStub(exitCode: number): SpawnStub {
    const calls: { cmd: string[] }[] = [];
    const spy = spyOn(Bun, "spawn").mockImplementation(((opts: { cmd: string[] }) => {
        calls.push(opts);
        return { exited: Promise.resolve(exitCode) } as { exited: Promise<number> };
    }) as unknown as typeof Bun.spawn);
    return { spy, calls };
}

interface FsMocksOpts {
    /** Exit code for the Bun.spawn stub. */
    readonly exitCode: number;
    /** When true, also spy on fs.unlinkSync / appendFileSync / writeFileSync / renameSync / existsSync. */
    readonly binaryBranch?: boolean;
    /** Custom impl for fs.rmSync; defaults to no-op. */
    readonly rmImpl?: (path: fs.PathLike) => void;
}

interface FsMocksCtx {
    io: CapturedIO;
    spawn: SpawnStub;
    rm: ReturnType<typeof spyOn<typeof fs, "rmSync">>;
    /** Extra spies active when binaryBranch === true */
    fsSpy?: {
        unlink: ReturnType<typeof spyOn<typeof fs, "unlinkSync">>;
        append: ReturnType<typeof spyOn<typeof fs, "appendFileSync">>;
        write: ReturnType<typeof spyOn<typeof fs, "writeFileSync">>;
        rename: ReturnType<typeof spyOn<typeof fs, "renameSync">>;
        exists: ReturnType<typeof spyOn<typeof fs, "existsSync">>;
    };
}

/**
 * Unified fs-mocks lifecycle helper.
 *
 * Always mocks Bun.spawn (configurable exit code) and fs.rmSync (configurable
 * impl, defaults to no-op). When binaryBranch is true, also mocks
 * fs.unlinkSync / appendFileSync / writeFileSync / renameSync / existsSync so
 * the binary branch runs deterministically without touching real HOME.
 *
 * All spies are restored in afterEach. Returns a live ctx object whose fields
 * are populated in beforeEach and readable from test bodies.
 */
function withFsMocks(opts: FsMocksOpts): FsMocksCtx {
    const rmImpl = opts.rmImpl ?? (() => {});
    const ctx = {} as FsMocksCtx;

    beforeEach(() => {
        ctx.io = captureIO();
        ctx.spawn = makeSpawnStub(opts.exitCode);
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
        ctx.spawn.spy.mockRestore();
        ctx.rm.mockRestore();
        if (ctx.fsSpy) {
            for (const spy of Object.values(ctx.fsSpy)) spy.mockRestore();
        }
    });

    return ctx;
}

/**
 * Returns a bound uninstallCommand that injects the given install method via
 * the `detectInstall` option — no global mock.module() needed.  This keeps
 * install-method.ts uncontaminated so install-method.win32.test.ts (and any
 * other file that imports the real module) sees the actual implementation.
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

// ─── binary branch ────────────────────────────────────────────────────────────

describe("uninstallCommand — binary branch", () => {
    // binaryBranch: also mock unlinkSync/writeFileSync/etc so real HOME is untouched
    const ctx = withFsMocks({ exitCode: 0, binaryBranch: true });

    test("binary: key step lines present in stdout", async () => {
        const { uninstallCommand } = await loadUninstall("binary");
        expect(await uninstallCommand({})).toBe(0);
        const out = ctx.io.stdout.join("");
        expect(out).toContain("Uninstalling atomic (install method: binary)");
        expect(out).toContain("Atomic uninstalled");
    });
});

// ─── pkg-manager branches (bun / npm / pnpm / yarn) ──────────────────────────

const pmBranches: ReadonlyArray<{ method: InstallMethod; cmd: string[] }> = [
    { method: "bun",  cmd: ["bun",  "remove",    "-g",     "@bastani/atomic"] },
    { method: "npm",  cmd: ["npm",  "uninstall", "-g",     "@bastani/atomic"] },
    { method: "pnpm", cmd: ["pnpm", "remove",    "-g",     "@bastani/atomic"] },
    { method: "yarn", cmd: ["yarn", "global",    "remove", "@bastani/atomic"] },
];

for (const { method, cmd } of pmBranches) {
    describe(`uninstallCommand — ${method} branch`, () => {
        const ctx = withFsMocks({ exitCode: 0 });

        test(`${method}: spawns ${cmd.join(" ")}`, async () => {
            const { uninstallCommand } = await loadUninstall(method);
            expect(await uninstallCommand({})).toBe(0);
            expect(ctx.spawn.calls.length).toBeGreaterThanOrEqual(1);
            expect(ctx.spawn.calls[0]?.cmd).toEqual(cmd);
        });
    });
}

// ─── pm non-zero exit ────────────────────────────────────────────────────────

describe("uninstallCommand — pm non-zero exit", () => {
    const ctx = withFsMocks({ exitCode: 1 });

    test("pm exit 1: stderr has manual-run hint; uninstallCommand returns 1", async () => {
        const { uninstallCommand } = await loadUninstall("npm");
        expect(await uninstallCommand({})).toBe(1);
        expect(ctx.io.stderr.join("")).toContain("You may need to run manually:");
    });
});

// ─── source / unknown branches ───────────────────────────────────────────────

for (const method of ["source", "unknown"] as const) {
    describe(`uninstallCommand — ${method} branch`, () => {
        const ctx = withFsMocks({ exitCode: 0 });

        test(`${method}: no spawn; stdout contains skipping package removal; returns 0`, async () => {
            const { uninstallCommand } = await loadUninstall(method);
            expect(await uninstallCommand({})).toBe(0);
            expect(ctx.spawn.calls.length).toBe(0);
            expect(ctx.io.stdout.join("")).toContain("skipping package removal");
        });
    });
}

// ─── --purge flag ────────────────────────────────────────────────────────────

describe("uninstallCommand — --purge flag", () => {
    // join(nodeOs.homedir(), ".atomic") resolves to tmpHome/.atomic because beforeAll redirected HOME
    const atomicHome = join(nodeOs.homedir(), ".atomic");
    const ctx = withFsMocks({ exitCode: 0 });

    test("purge: rmSync called with ~/.atomic when --purge set", async () => {
        const { uninstallCommand } = await loadUninstall("bun");
        expect(await uninstallCommand({ purge: true })).toBe(0);
        const purgeCall = ctx.rm.mock.calls.find((args) => String(args[0]) === atomicHome);
        expect(purgeCall).toBeDefined();
        expect(purgeCall?.[1]).toMatchObject({ recursive: true, force: true });
    });

    test("no purge: rmSync NOT called with ~/.atomic when --purge absent", async () => {
        const { uninstallCommand } = await loadUninstall("bun");
        expect(await uninstallCommand({})).toBe(0);
        const purgeCall = ctx.rm.mock.calls.find((args) => String(args[0]) === atomicHome);
        expect(purgeCall).toBeUndefined();
    });
});

// ─── --purge failure + pm non-zero exit ──────────────────────────────────────

describe("uninstallCommand — --purge failure + pm non-zero", () => {
    // join(nodeOs.homedir(), ".atomic") resolves to tmpHome/.atomic because beforeAll redirected HOME
    const atomicHome = join(nodeOs.homedir(), ".atomic");
    const ctx = withFsMocks({
        exitCode: 1,
        rmImpl: (path) => {
            if (String(path) === atomicHome) {
                throw new Error("EACCES: permission denied");
            }
        },
    });

    test("purge throws + pm exits 1: both errors surfaced; pm exit code wins", async () => {
        const { uninstallCommand } = await loadUninstall("npm");
        expect(await uninstallCommand({ purge: true })).toBe(1);
        const errOut = ctx.io.stderr.join("");
        expect(errOut).toContain("You may need to run manually:");
        expect(errOut).toContain("could not purge");
    });
});

// ─── Bun.spawn throws synchronously ──────────────────────────────────────────

describe("uninstallCommand — Bun.spawn throws synchronously", () => {
    let io: CapturedIO;
    let spawnSpy: ReturnType<typeof spyOn<typeof Bun, "spawn">>;

    beforeEach(() => {
        io = captureIO();
        spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => {
            throw new Error("Executable not found in $PATH: \"bun\"");
        }) as unknown as typeof Bun.spawn);
    });

    afterEach(() => {
        io.restore();
        spawnSpy.mockRestore();
    });

    test("bun spawn throw: returns 1, stderr contains hint, does not unhandled-reject", async () => {
        const { uninstallCommand } = await loadUninstall("bun");
        expect(await uninstallCommand({})).toBe(1);
        expect(io.stderr.join("")).toContain(
            "You may need to run manually: bun remove -g @bastani/atomic",
        );
    });
});

// ─── completions cleanup hoist ───────────────────────────────────────────────

describe("uninstallCommand — completions cleanup hoist", () => {
    // join(nodeOs.homedir(), ".atomic", "completions") resolves to tmpHome/.atomic/completions
    const completionsDir = join(nodeOs.homedir(), ".atomic", "completions");
    const ctx = withFsMocks({ exitCode: 0 });

    const methods: ReadonlyArray<InstallMethod> = [
        "binary", "bun", "npm", "pnpm", "yarn", "source", "unknown",
    ];
    for (const method of methods) {
        test(`${method}: rmSync called with completionsDir + {recursive,force}`, async () => {
            const { uninstallCommand } = await loadUninstall(method);
            expect(await uninstallCommand({})).toBe(0);
            const completionsCall = ctx.rm.mock.calls.find(
                (args) => String(args[0]) === completionsDir,
            );
            expect(completionsCall).toBeDefined();
            expect(completionsCall?.[1]).toMatchObject({ recursive: true, force: true });
        });
    }
});

// ─── --purge subsumes completions cleanup ────────────────────────────────────

describe("uninstallCommand --purge: completions cleanup subsumed by purge", () => {
    // join(homedir(), ...) resolves to tmpHome/... because beforeAll redirected HOME
    const completionsDir = join(nodeOs.homedir(), ".atomic", "completions");
    const atomicHome = join(nodeOs.homedir(), ".atomic");
    const ctx = withFsMocks({ exitCode: 0 });

    test("bun + --purge: rmSync called with ~/.atomic; NOT called with completionsDir explicitly", async () => {
        const { uninstallCommand } = await loadUninstall("bun");
        expect(await uninstallCommand({ purge: true })).toBe(0);
        expect(ctx.rm.mock.calls.find((args) => String(args[0]) === atomicHome)).toBeDefined();
        expect(ctx.rm.mock.calls.find((args) => String(args[0]) === completionsDir)).toBeUndefined();
    });
});

// ─── terminal success line: per-method ───────────────────────────────────────

const successMethods: ReadonlyArray<InstallMethod> = [
    "bun", "npm", "pnpm", "yarn", "source", "unknown",
];

for (const method of successMethods) {
    describe(`uninstallCommand — terminal success line (${method})`, () => {
        const ctx = withFsMocks({ exitCode: 0 });

        test(`${method}: stdout ends with \\nAtomic uninstalled.\\n`, async () => {
            const { uninstallCommand } = await loadUninstall(method);
            expect(await uninstallCommand({})).toBe(0);
            const out = ctx.io.stdout.join("");
            expect(out).toContain("\nAtomic uninstalled.\n");
        });
    });
}

// ─── terminal success line: --purge variant ───────────────────────────────────

describe("uninstallCommand — terminal success line with --purge (bun)", () => {
    const ctx = withFsMocks({ exitCode: 0 });

    test("purge=true + bun: stdout still contains \\nAtomic uninstalled.\\n", async () => {
        const { uninstallCommand } = await loadUninstall("bun");
        expect(await uninstallCommand({ purge: true })).toBe(0);
        const out = ctx.io.stdout.join("");
        expect(out).toContain("\nAtomic uninstalled.\n");
    });
});

// ─── terminal success line suppressed on pm non-zero exit ────────────────────

describe("uninstallCommand — terminal success line suppressed on pm exit 1 (npm)", () => {
    const ctx = withFsMocks({ exitCode: 1 });

    test("npm exit 1: stdout does NOT contain \\nAtomic uninstalled.\\n; returns 1", async () => {
        const { uninstallCommand } = await loadUninstall("npm");
        const code = await uninstallCommand({});
        expect(code).toBe(1);
        const out = ctx.io.stdout.join("");
        expect(out).not.toContain("\nAtomic uninstalled.\n");
    });
});
