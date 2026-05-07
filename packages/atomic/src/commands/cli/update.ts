/**
 * `atomic update` — self-update entry point.
 *
 * Dispatches to the appropriate upgrade path based on how atomic was
 * installed (binary download, bun, npm, pnpm, yarn, or source checkout).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirm, spinner, log, note } from "@clack/prompts";

import { VERSION } from "../../version.ts";
import { detectInstallMethod } from "../../services/system/install-method.ts";
import {
    getLatestRelease,
    getReleaseByTag,
    downloadAssetFromUrl,
    verifyChecksum,
    isNewer,
    normalizeVersion,
    type Manifest,
    type ReleaseInfo,
} from "../../services/system/release-fetch.ts";
import {
    getInstallPaths,
    copyBinary,
    cleanupOldArtifacts,
} from "./install.ts";

export interface UpdateOptions {
    readonly yes?: boolean;
    readonly check?: boolean;
    readonly version?: string;
}

const PACKAGE_NAME = "@bastani/atomic";

// ── Platform helpers ─────────────────────────────────────────────────────────

const IS_WINDOWS = process.platform === "win32";

/** Mirrors `hostTarget()` from `script/targets.ts` — inlined to stay within src/ rootDir. */
function hostTarget(): string {
    const plat = IS_WINDOWS ? "windows" : process.platform;
    return `${plat}-${process.arch}`;
}

// ── PM-delegate helper ────────────────────────────────────────────────────────

type PmKind = "bun" | "npm" | "pnpm" | "yarn";

function buildPmViewArgv(pm: PmKind): string[] {
    switch (pm) {
        case "bun":  return ["bun", "pm", "view", PACKAGE_NAME, "version"];
        case "npm":  return ["npm", "view", PACKAGE_NAME, "version"];
        case "pnpm": return ["pnpm", "view", PACKAGE_NAME, "version"];
        case "yarn": return ["yarn", "info", PACKAGE_NAME, "version", "--json"];
    }
}

async function fetchPmUpstreamVersion(pm: PmKind): Promise<string> {
    const argv = buildPmViewArgv(pm);
    const proc = Bun.spawn({
        cmd: argv,
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(5000),
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(stderr.trim() || `${pm} view exited with code ${exitCode}`);
    }
    const stdout = await new Response(proc.stdout).text();
    if (pm === "yarn") {
        // yarn --json outputs `{"type":"inspect","data":"<version>"}` per line
        for (const line of stdout.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const parsed = JSON.parse(trimmed) as { data?: string };
                if (parsed.data) return parsed.data.trim();
            } catch {
                // not JSON, skip
            }
        }
        throw new Error("yarn info: could not parse version from JSON output");
    }
    return stdout.trim();
}

function buildPmArgv(pm: PmKind, packageSpec: string): string[] {
    switch (pm) {
        case "bun":  return ["bun", "add", "-g", packageSpec];
        case "npm":  return ["npm", "install", "-g", packageSpec];
        case "pnpm": return ["pnpm", "add", "-g", packageSpec];
        case "yarn": return ["yarn", "global", "add", packageSpec];
    }
}

async function runPmUpgrade(pm: PmKind, target: string): Promise<number> {
    const argv = buildPmArgv(pm, `${PACKAGE_NAME}@${target}`);
    try {
        const proc = Bun.spawn({ cmd: argv, stdio: ["inherit", "inherit", "inherit"] });
        return await proc.exited;
    } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") {
            // Match the actual upgrade command per PM (yarn → "yarn global add").
            const manualHint = buildPmArgv(pm, PACKAGE_NAME).join(" ");
            log.error(`${pm} not found on PATH; reinstall it or run: ${manualHint}`);
        } else {
            log.error(`Failed to run ${pm}: ${e.message}`);
        }
        return 1;
    }
}

// ── Spinner step helper ───────────────────────────────────────────────────────

type Spinner = ReturnType<typeof spinner>;

/**
 * Run an async step under a spinner. Logs the underlying error and rethrows
 * on failure so callers can fail-fast with a single try/catch around a
 * sequence of steps.
 */
async function step<T>(
    s: Spinner,
    startMsg: string,
    successMsg: string | ((result: T) => string),
    failMsg: string,
    fn: () => Promise<T> | T,
): Promise<T> {
    s.start(startMsg);
    try {
        const result = await fn();
        s.stop(typeof successMsg === "function" ? successMsg(result) : successMsg);
        return result;
    } catch (err) {
        s.stop(failMsg);
        log.error((err as Error).message);
        throw err;
    }
}

// ── Binary update path ────────────────────────────────────────────────────────

async function runBinaryUpdate(opts: UpdateOptions, target: string): Promise<number> {
    const s = spinner();

    let release: ReleaseInfo;
    try {
        release = await step(
            s,
            "Checking for updates...",
            (r) => `Found release ${r.tag_name}`,
            "Failed to fetch release info",
            () => target === "latest" ? getLatestRelease() : getReleaseByTag(`v${target}`),
        );
    } catch {
        return 1;
    }

    if (opts.check) {
        const upToDate = target === "latest" && !isNewer(release.tag_name, VERSION);
        note(
            `current=${VERSION}  target=${release.tag_name}  method=binary${upToDate ? "  (up to date)" : ""}`,
            "atomic update --check",
        );
        return 0;
    }

    // Skip the up-to-date check when the user pinned a specific version.
    if (target === "latest" && !isNewer(release.tag_name, VERSION)) {
        log.info(`Already up to date (${VERSION})`);
        return 0;
    }

    if (!opts.yes) {
        const ok = await confirm({
            message: `Update atomic from ${VERSION} to ${release.tag_name}?`,
        });
        if (ok !== true) {
            log.info("Update cancelled.");
            return 0;
        }
    }

    const host = hostTarget();
    const assetName = `atomic-${host}${IS_WINDOWS ? ".exe" : ""}`;
    const binaryAsset = release.assets.find((a) => a.name === assetName);
    if (!binaryAsset) {
        log.error(`Asset "${assetName}" not found in release ${release.tag_name}`);
        return 1;
    }
    const manifestAsset = release.assets.find((a) => a.name === "manifest.json");
    if (!manifestAsset) {
        log.error(`Asset "manifest.json" not found in release ${release.tag_name}`);
        return 1;
    }

    const paths = getInstallPaths();
    const tmpDir = mkdtempSync(join(tmpdir(), "atomic-update-"));
    try {
        const assetDest = join(tmpDir, assetName);
        const manifestDest = join(tmpDir, "manifest.json");

        await step(
            s,
            `Downloading ${assetName}...`,
            "Downloaded binary",
            "Download failed",
            () => downloadAssetFromUrl(binaryAsset.browser_download_url, assetDest),
        );
        await step(
            s,
            "Downloading manifest...",
            "Downloaded manifest",
            "Manifest download failed",
            () => downloadAssetFromUrl(manifestAsset.browser_download_url, manifestDest),
        );
        await step(
            s,
            "Verifying checksum...",
            "Checksum verified",
            "Checksum verification failed",
            async () => {
                const manifest = JSON.parse(readFileSync(manifestDest, "utf8")) as Manifest;
                const entry = manifest.platforms[host];
                if (!entry) throw new Error(`No manifest entry for platform "${host}"`);
                await verifyChecksum(assetDest, entry.checksum);
            },
        );
        await step(
            s,
            "Installing updated binary...",
            "Binary installed",
            "Installation failed",
            () => copyBinary(paths, assetDest),
        );

        queueMicrotask(() => cleanupOldArtifacts(paths.binDir));

        // Sanity check: verify the new binary runs.
        const check = Bun.spawnSync({ cmd: [paths.binPath, "--version"], stdout: "pipe", stderr: "pipe" });
        if (check.exitCode !== 0) {
            log.error(`Sanity check failed: ${paths.binPath} --version returned exit code ${check.exitCode}`);
            return 1;
        }

        log.success(`atomic updated to ${release.tag_name} (${check.stdout.toString().trim()})`);
        return 0;
    } catch {
        // step() already logged the underlying error; just propagate non-zero.
        return 1;
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

export async function updateCommand(opts: UpdateOptions = {}): Promise<number> {
    const target = normalizeVersion(opts.version ?? "latest");
    const method = await detectInstallMethod();

    switch (method.kind) {
        case "binary":
            return runBinaryUpdate(opts, target);

        case "bun":
        case "npm":
        case "pnpm":
        case "yarn":
            if (opts.check) {
                let pmTarget: string | undefined;
                let reason: string | undefined;
                try {
                    pmTarget = await fetchPmUpstreamVersion(method.kind);
                } catch (err) {
                    reason = err instanceof Error ? err.message : String(err);
                }
                if (pmTarget !== undefined) {
                    const upToDate = !isNewer(pmTarget, VERSION);
                    note(
                        `current=${VERSION}  target=${pmTarget}  method=${method.kind}${upToDate ? "  (up to date)" : ""}`,
                        "atomic update --check",
                    );
                } else {
                    note(
                        `current=${VERSION}  method=${method.kind}  (target lookup failed: ${reason})`,
                        "atomic update --check",
                    );
                }
                return 0;
            }
            log.info(`Updating via ${method.kind}...`);
            return runPmUpgrade(method.kind, target);

        case "source":
            log.error("Cannot auto-update: atomic is running from a source checkout.");
            log.info("To update: git pull && bun install");
            log.info(`Detected execPath: ${process.execPath}`);
            return 1;

        case "unknown":
            log.error("Cannot auto-update: install method could not be determined.");
            log.info("Reinstall via the official installer (https://raw.githubusercontent.com/flora131/atomic/main/install.sh) or your package manager.");
            log.info(`Detected execPath: ${process.execPath}`);
            return 1;
    }
}
