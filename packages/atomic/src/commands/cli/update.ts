/**
 * `atomic update` — self-update entry point.
 *
 * Dispatches to the appropriate upgrade path based on how atomic was
 * installed (binary download, bun, npm, pnpm, yarn, or source checkout).
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirm, spinner, log, note } from "@clack/prompts";

import { VERSION } from "../../version.ts";
import { detectInstallMethod } from "../../services/system/install-method.ts";
import {
    getLatestRelease,
    getReleaseByTag,
    downloadAsset,
    verifyChecksum,
    isNewer,
    normalizeVersion,
    type Manifest,
} from "../../services/system/release-fetch.ts";
import {
    getInstallPaths,
    copyBinary,
    cleanupOldArtifacts,
} from "./install.ts";
/** Mirrors `hostTarget()` from `script/targets.ts` — inlined to stay within src/ rootDir. */
function hostTarget(): string {
    const plat = process.platform === "win32" ? "windows" : process.platform;
    return `${plat}-${process.arch}`;
}

export interface UpdateOptions {
    readonly yes?: boolean;
    readonly check?: boolean;
    readonly version?: string;
}

// ── PM-delegate helper ────────────────────────────────────────────────────────

type PmKind = "bun" | "npm" | "pnpm" | "yarn";

function buildArgv(pm: PmKind, packageSpec: string): string[] {
    switch (pm) {
        case "bun":  return ["bun",  "add",    "-g",        packageSpec];
        case "npm":  return ["npm",  "install", "-g",        packageSpec];
        case "pnpm": return ["pnpm", "add",    "-g",        packageSpec];
        case "yarn": return ["yarn", "global",  "add",      packageSpec];
    }
}

async function runPmUpgrade(pm: PmKind, target: string): Promise<number> {
    const packageSpec = `@bastani/atomic@${target}`;
    const argv = buildArgv(pm, packageSpec);
    try {
        const proc = Bun.spawn({ cmd: argv, stdio: ["inherit", "inherit", "inherit"] });
        return await proc.exited;
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
            log.error(`${pm} not found on PATH; reinstall it or run ${pm} add -g @bastani/atomic manually`);
        } else {
            log.error(`Failed to run ${pm}: ${(err as Error).message}`);
        }
        return 1;
    }
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

export async function updateCommand(opts?: UpdateOptions): Promise<number> {
    const target = normalizeVersion(opts?.version ?? "latest");
    const method = await detectInstallMethod();

    // ── --check for PM-delegate methods ──────────────────────────────────────
    // RFC §5.4 simplification: for PM methods we just print current + method.
    // A full `npm view @bastani/atomic version` lookup is non-trivial (network,
    // cross-pm), so we skip it for v1 and document the gap here.
    if (opts?.check) {
        if (method.kind !== "binary") {
            log.info(`current=${VERSION} method=${method.kind}`);
            return 0;
        }
        // binary --check handled below after target resolution
    }

    // ── PM-delegate ───────────────────────────────────────────────────────────
    const pmKinds: PmKind[] = ["bun", "npm", "pnpm", "yarn"];
    if (pmKinds.includes(method.kind as PmKind)) {
        const pm = method.kind as PmKind;
        if (opts?.check) {
            log.info(`current=${VERSION} method=${pm}`);
            return 0;
        }
        log.info(`Updating via ${pm}...`);
        return runPmUpgrade(pm, target);
    }

    // ── source | unknown ──────────────────────────────────────────────────────
    if (method.kind === "source" || method.kind === "unknown") {
        log.error("Cannot auto-update: atomic is running from a source checkout or unknown install method.");
        log.info("To update: git pull && bun install");
        log.info(`Detected execPath: ${process.execPath}`);
        return 1;
    }

    // ── binary ────────────────────────────────────────────────────────────────
    // method.kind === "binary"
    const s = spinner();

    // Resolve release
    s.start("Checking for updates...");
    let release: Awaited<ReturnType<typeof getLatestRelease>>;
    try {
        release = target === "latest"
            ? await getLatestRelease()
            : await getReleaseByTag("v" + target);
    } catch (err) {
        s.stop("Failed to fetch release info");
        log.error((err as Error).message);
        return 1;
    }
    s.stop(`Found release ${release.tag_name}`);

    // Version comparison (skip when a specific version is pinned by the user)
    const pinned = opts?.version !== undefined && opts.version !== "latest";
    if (!pinned && !isNewer(release.tag_name, VERSION)) {
        log.info(`Already up to date (${VERSION})`);
        return 0;
    }

    // --check: print info and exit without downloading
    if (opts?.check) {
        note(
            `current=${VERSION}  target=${release.tag_name}  method=binary`,
            "atomic update --check",
        );
        return 0;
    }

    // Confirmation prompt (skipped when --yes)
    if (!opts?.yes) {
        const ok = await confirm({
            message: `Update atomic from ${VERSION} to ${release.tag_name}?`,
        });
        if (!ok || typeof ok !== "boolean") {
            log.info("Update cancelled.");
            return 0;
        }
    }

    // Download
    const tmpDir = mkdtempSync(join(tmpdir(), "atomic-update-"));
    const ext = process.platform === "win32" ? ".exe" : "";
    const ht = hostTarget();
    const assetName = `atomic-${ht}${ext}`;
    const assetDest = join(tmpDir, assetName);
    const manifestDest = join(tmpDir, "manifest.json");

    s.start(`Downloading ${assetName}...`);
    try {
        await downloadAsset(release.tag_name, assetName, assetDest);
    } catch (err) {
        s.stop("Download failed");
        log.error((err as Error).message);
        return 1;
    }
    s.stop("Downloaded binary");

    s.start("Downloading manifest...");
    try {
        await downloadAsset(release.tag_name, "manifest.json", manifestDest);
    } catch (err) {
        s.stop("Manifest download failed");
        log.error((err as Error).message);
        return 1;
    }
    s.stop("Downloaded manifest");

    // Verify checksum
    s.start("Verifying checksum...");
    let manifest: Manifest;
    try {
        manifest = JSON.parse(readFileSync(manifestDest, "utf8")) as Manifest;
    } catch (err) {
        s.stop("Failed to parse manifest");
        log.error((err as Error).message);
        return 1;
    }

    const platformEntry = manifest.platforms[ht];
    if (!platformEntry) {
        s.stop("Checksum lookup failed");
        log.error(`No manifest entry for platform "${ht}"`);
        return 1;
    }

    try {
        await verifyChecksum(assetDest, platformEntry.checksum);
    } catch (err) {
        s.stop("Checksum verification failed");
        log.error((err as Error).message);
        return 1;
    }
    s.stop("Checksum verified");

    // Copy binary into install location
    const paths = getInstallPaths();
    const binDir = paths.binDir;
    const binPath = paths.binPath;

    s.start("Installing updated binary...");
    try {
        copyBinary(paths, assetDest);
    } catch (err) {
        s.stop("Installation failed");
        log.error((err as Error).message);
        return 1;
    }
    s.stop("Binary installed");

    // Fire-and-forget reaper for prior artifacts
    queueMicrotask(() => cleanupOldArtifacts(binDir));

    // Sanity check: verify the new binary runs
    const check = Bun.spawnSync({ cmd: [binPath, "--version"], stdout: "pipe", stderr: "pipe" });
    if (check.exitCode !== 0) {
        log.error(`Sanity check failed: ${binPath} --version returned exit code ${check.exitCode}`);
        return 1;
    }

    log.success(`atomic updated to ${release.tag_name} (${check.stdout.toString().trim()})`);
    return 0;
}
