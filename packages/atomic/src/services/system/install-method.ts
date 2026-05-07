/**
 * Detect how the running `atomic` binary was installed.
 *
 * Two-stage: cheap path-shape heuristics first, then a `<pm> list -g`
 * probe via `Bun.spawn` (skipped when `opts.skipProbe` is set).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { getInstallPaths } from "../../commands/cli/install.ts";

export const ATOMIC_PACKAGE_NAME = "@bastani/atomic";

export type InstallMethod =
    | { kind: "binary"; binPath: string }
    | { kind: "bun"; binPath: string }
    | { kind: "npm" | "pnpm" | "yarn"; binPath: string }
    | { kind: "source" }
    | { kind: "unknown" };

export interface DetectOptions {
    /** Override `process.execPath` for tests. */
    readonly execPath?: string;
    /** Override `process.cwd()` for the source-checkout walk. */
    readonly cwd?: string;
    /** Skip the `<pm> list -g` fallback probe. */
    readonly skipProbe?: boolean;
}

type SpawnResult = { exitCode: number | null; stdout: string };
type SpawnFn = (cmd: string[]) => Promise<SpawnResult>;

const PROBE_TIMEOUT_MS = 5_000;

const defaultSpawn: SpawnFn = async (cmd) => {
    const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), PROBE_TIMEOUT_MS);
    try {
        const stdout = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;
        return { exitCode, stdout };
    } catch {
        return { exitCode: null, stdout: "" };
    } finally {
        clearTimeout(timer);
    }
};

// ── Path helpers (case-insensitive to tolerate Windows + symlink quirks) ──

function samePath(a: string, b: string): boolean {
    return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

function isUnder(child: string, parent: string): boolean {
    const parentR = (resolve(parent) + sep).toLowerCase();
    return resolve(child).toLowerCase().startsWith(parentR);
}

// ── PM listing probes ─────────────────────────────────────────────────────

export async function pmListsAtomic(
    pm: "bun" | "npm" | "pnpm" | "yarn",
    spawn: SpawnFn = defaultSpawn,
): Promise<boolean> {
    try {
        if (pm === "bun") {
            const { exitCode, stdout } = await spawn(["bun", "pm", "ls", "-g"]);
            return exitCode === 0 && stdout.includes(ATOMIC_PACKAGE_NAME);
        }
        if (pm === "npm") {
            const { exitCode, stdout } = await spawn(["npm", "ls", "-g", "--depth=0", "--json"]);
            if (exitCode !== 0) return false;
            const parsed = JSON.parse(stdout) as { dependencies?: Record<string, unknown> };
            return ATOMIC_PACKAGE_NAME in (parsed.dependencies ?? {});
        }
        if (pm === "pnpm") {
            const { exitCode, stdout } = await spawn(["pnpm", "ls", "-g", "--depth=0", "--json"]);
            if (exitCode !== 0) return false;
            // pnpm emits an array of project entries.
            const parsed = JSON.parse(stdout) as Array<{ dependencies?: Record<string, unknown> }>;
            return parsed.some((entry) => ATOMIC_PACKAGE_NAME in (entry.dependencies ?? {}));
        }
        // yarn — NDJSON, one JSON object per line. The package name only ever
        // appears as a JSON string value, so a substring scan is sufficient.
        const { exitCode, stdout } = await spawn(["yarn", "global", "list", "--json"]);
        if (exitCode !== 0) return false;
        return stdout.split("\n").some((line) => line.includes(ATOMIC_PACKAGE_NAME));
    } catch {
        return false;
    }
}

// ── node_modules PM heuristic ─────────────────────────────────────────────

function inferPmFromNodeModules(execPath: string): "npm" | "pnpm" | "yarn" | null {
    const marker = `${sep}node_modules${sep}`;
    const idx = execPath.indexOf(marker);
    if (idx === -1) return null;

    const nmRoot = execPath.slice(0, idx + marker.length - 1);

    if (existsSync(`${nmRoot}${sep}.pnpm`)) return "pnpm";
    if (existsSync(`${nmRoot}${sep}.yarn-state.yml`)) return "yarn";
    return "npm";
}

// ── Source checkout detection ─────────────────────────────────────────────

const MAX_WALK_DEPTH = 20;

export function isInsideRepoCheckout(cwd: string = process.cwd()): boolean {
    let dir = resolve(cwd);
    for (let i = 0; i < MAX_WALK_DEPTH; i++) {
        try {
            if (existsSync(join(dir, ".git"))) {
                const pkgPath = join(dir, "package.json");
                if (existsSync(pkgPath)) {
                    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
                        name?: string;
                        workspaces?: string[];
                    };
                    // Accept legacy synthetic name + real monorepo name.
                    if (pkg.name === "atomic") return true;
                    if (pkg.name === "@bastani/atomic-monorepo") return true;
                    if (pkg.name?.endsWith("/atomic-monorepo")) return true;

                    // Workspace globs: a literal "packages/atomic" entry OR a glob whose
                    // prefix matches "packages/*" (e.g. "packages/*").
                    if (pkg.workspaces?.some(
                        (w) => w.includes("packages/atomic") || w.startsWith("packages/*"),
                    )) {
                        return true;
                    }
                    // .git found but pkg doesn't match — stop walking.
                    return false;
                }
            }
            const parent = resolve(dir, "..");
            if (parent === dir) return false;
            dir = parent;
        } catch {
            return false;
        }
    }
    return false;
}

// ── Main detector ─────────────────────────────────────────────────────────

export async function detectInstallMethod(opts: DetectOptions = {}): Promise<InstallMethod> {
    const execPath = resolve(opts.execPath ?? process.execPath);

    // 1a. Standalone binary install.
    const installPaths = getInstallPaths();
    if (samePath(execPath, installPaths.binPath)) {
        return { kind: "binary", binPath: execPath };
    }

    // 1b. Bun global — `bun add -g` lays the platform binary under
    //     `~/.bun/install/global/node_modules/...`, NOT `~/.bun/bin`, so accept
    //     the whole `.bun` tree plus `$BUN_INSTALL` (not just its bin/).
    const bunHome = join(homedir(), ".bun");
    const bunRoots = [
        join(bunHome, "bin"),
        join(bunHome, "install"),
        process.env.BUN_INSTALL,
    ].filter((root): root is string => root !== undefined);
    if (bunRoots.some((root) => isUnder(execPath, root))) {
        return { kind: "bun", binPath: execPath };
    }

    // 1c. node_modules tree (npm/pnpm/yarn). Must run AFTER 1b — bun-global
    //     paths also contain `node_modules/`. New install channels whose paths
    //     cross a `node_modules/` boundary must be detected before this step.
    const nmPm = inferPmFromNodeModules(execPath);
    if (nmPm) return { kind: nmPm, binPath: execPath };

    // 2. Fallback: ask each PM whether it owns the package.
    if (!opts.skipProbe) {
        for (const pm of ["bun", "pnpm", "npm", "yarn"] as const) {
            if (await pmListsAtomic(pm)) {
                return { kind: pm, binPath: execPath };
            }
        }
    }

    // 3. Source checkout vs unrecognised.
    return isInsideRepoCheckout(opts.cwd) ? { kind: "source" } : { kind: "unknown" };
}
