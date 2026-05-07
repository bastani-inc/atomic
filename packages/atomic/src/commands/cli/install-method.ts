import { homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";

export type InstallMethod =
    | "binary"
    | "bun"
    | "npm"
    | "pnpm"
    | "yarn"
    | "source"
    | "unknown";

export interface DetectOptions {
    /** override for tests */
    readonly execPath?: string;
    /** override for tests; default `Bun.spawnSync` */
    readonly probe?: (cmd: string[]) => { exitCode: number; stdout: string };
    /** override for tests — platform string (e.g. "win32", "linux", "darwin") */
    readonly platform?: string;
}

const PKG_PATH_RE = /\/node_modules\/@bastani\/atomic(?:-[a-z0-9-]+)?\//;

const PM_PROBE_CMD: Record<"bun" | "pnpm" | "yarn" | "npm", string[]> = {
    bun:  ["bun",  "pm",     "ls", "-g"],
    pnpm: ["pnpm", "list",   "-g", "--depth=0"],
    yarn: ["yarn", "global", "list"],
    npm:  ["npm",  "list",   "-g", "--depth=0"],
};

let cached: InstallMethod | null = null;

/** True when no test seams are injected — gates both cache read and write. */
function hasNoOverrides(opts: DetectOptions): boolean {
    return opts.execPath === undefined
        && opts.platform === undefined
        && opts.probe === undefined;
}

/** Lowercase + forward-slash so a single substring works on Unix and Windows. */
function normalize(p: string): string {
    return p.toLowerCase().replaceAll("\\", "/");
}

export function detectInstallMethod(opts: DetectOptions = {}): InstallMethod {
    const pristine = hasNoOverrides(opts);
    if (pristine && cached !== null) return cached;

    const method = computeInstallMethod(opts);
    if (pristine) cached = method;
    return method;
}

function computeInstallMethod(opts: DetectOptions): InstallMethod {
    const exec = normalize(opts.execPath ?? process.execPath);
    const currentPlatform = opts.platform ?? osPlatform();

    // 1. Binary install — canonical install dirs from `getInstallPaths()`.
    const binDir = currentPlatform === "win32"
        ? join(
            process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
            "atomic",
            "bin",
        )
        : join(homedir(), ".local", "bin");
    // `normalize` collapses both `\` and `/` to `/`, so anchor on `/`
    // regardless of platform — a platform-native `\` separator here would
    // never match a post-normalize `exec` on a POSIX runtime.
    const norm = normalize(binDir);
    if (exec === norm || exec.startsWith(`${norm}/`)) return "binary";

    // 2. Pkg-manager install — `node_modules/@bastani/atomic` or per-platform variant.
    if (PKG_PATH_RE.test(exec)) {
        // Cheap path heuristics first; fall back to `<pm> ls -g` probes.
        if (exec.includes("/.bun/install/global/")) return "bun";
        if (exec.includes("/pnpm/global/")) return "pnpm";
        if (exec.includes("/.config/yarn/global/")) return "yarn";

        const probe = opts.probe ?? defaultProbe;
        for (const pm of ["bun", "pnpm", "yarn", "npm"] as const) {
            const r = probe(PM_PROBE_CMD[pm]);
            if (r.exitCode === 0 && r.stdout.includes("@bastani/atomic")) return pm;
        }
        // Default to npm — most common pkg manager and canonical npm-cli prefix.
        return "npm";
    }

    // 3. Source checkout — repo `bun link` or local dev script.
    if (exec.endsWith("/bun") || exec.endsWith("/bun.exe")) return "source";

    return "unknown";
}

function defaultProbe(cmd: string[]): { exitCode: number; stdout: string } {
    try {
        const r = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
        return { exitCode: r.exitCode ?? 1, stdout: r.stdout.toString() };
    } catch {
        return { exitCode: 1, stdout: "" };
    }
}

/** test-only — reset memoized result between cases */
export function _resetInstallMethodCache(): void { cached = null; }
