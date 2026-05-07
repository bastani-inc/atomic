/**
 * GitHub Releases helpers for the `atomic update` command.
 *
 * Fetches release metadata, downloads assets, verifies checksums, and
 * compares semver tags. All GitHub API calls respect `GITHUB_TOKEN` when
 * set and surface a clear error on anonymous rate-limit exhaustion.
 */

import { copyFileSync, renameSync, unlinkSync } from "node:fs";
import { pid } from "node:process";

// ── Public types ─────────────────────────────────────────────────────────────

export interface ReleaseInfo {
    readonly tag_name: string;
    readonly assets: ReadonlyArray<{ name: string; browser_download_url: string }>;
}

export interface PlatformChecksum {
    readonly checksum: string;
}

export interface Manifest {
    readonly version: string;
    readonly platforms: Readonly<Record<string, PlatformChecksum>>;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const GITHUB_API_BASE = "https://api.github.com/repos/flora131/atomic";

function buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "atomic-cli",
    };
    const token = process.env.GITHUB_TOKEN;
    if (token) headers["Authorization"] = `Bearer ${token}`;
    return headers;
}

async function githubGet(url: string): Promise<ReleaseInfo> {
    const res = await fetch(url, { headers: buildHeaders() });

    if (res.status === 403 && res.headers.get("X-RateLimit-Remaining") === "0") {
        throw new Error("Set GITHUB_TOKEN to lift the 60 req/h anonymous limit");
    }
    if (!res.ok) {
        throw new Error(`GitHub API error ${res.status}: ${url}`);
    }

    return res.json() as Promise<ReleaseInfo>;
}

// ── Exported functions ────────────────────────────────────────────────────────

/** Fetch the latest release from the flora131/atomic repo. */
export async function getLatestRelease(): Promise<ReleaseInfo> {
    return githubGet(`${GITHUB_API_BASE}/releases/latest`);
}

/** Fetch a specific release by tag name. */
export async function getReleaseByTag(tag: string): Promise<ReleaseInfo> {
    return githubGet(`${GITHUB_API_BASE}/releases/tags/${encodeURIComponent(tag)}`);
}

/**
 * Stream-download a pre-resolved asset URL to `destPath` — no release-tag fetch.
 *
 * Writes to a `.tmp.<pid>.<ts>` sibling first, then atomically renames to
 * `destPath` on success. Cleans up the partial file on any error.
 */
export async function downloadAssetFromUrl(url: string, destPath: string): Promise<void> {
    const res = await fetch(url, { headers: buildHeaders() });
    if (!res.ok) {
        throw new Error(`Failed to download asset: HTTP ${res.status}`);
    }

    const tmpPath = `${destPath}.tmp.${pid}.${Date.now()}`;
    let placed = false;
    try {
        await Bun.write(tmpPath, res);
        try {
            renameSync(tmpPath, destPath);
            placed = true;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "EXDEV") {
                copyFileSync(tmpPath, destPath);
                placed = true;
            } else {
                throw err;
            }
        }
    } finally {
        // best-effort cleanup. After successful rename tmpPath gone (ENOENT).
        // After EXDEV fallback we need to remove it. After throw before write we need to remove it.
        try { unlinkSync(tmpPath); } catch { /* swallow */ }
    }
    void placed;
}

/**
 * Stream-download a release asset to `destPath`.
 *
 * Resolves the asset URL via `getReleaseByTag`, then delegates to
 * `downloadAssetFromUrl`. Prefer passing the URL directly when you already
 * have the release info to avoid an extra GitHub API call.
 */
export async function downloadAsset(
    tag: string,
    assetName: string,
    destPath: string,
): Promise<void> {
    const release = await getReleaseByTag(tag);
    const asset = release.assets.find((a) => a.name === assetName);
    if (!asset) {
        throw new Error(`Asset "${assetName}" not found in release ${tag}`);
    }

    await downloadAssetFromUrl(asset.browser_download_url, destPath);
}

/**
 * Verify that `filePath` matches `expectedSha256`.
 * Throws with an informative message on mismatch.
 */
export async function verifyChecksum(
    filePath: string,
    expectedSha256: string,
): Promise<void> {
    const hasher = new Bun.CryptoHasher("sha256");
    for await (const chunk of Bun.file(filePath).stream()) {
        hasher.update(chunk);
    }

    const actual = hasher.digest("hex");
    const expected = expectedSha256.toLowerCase();
    if (actual !== expected) {
        throw new Error(
            `Checksum mismatch for ${filePath}: expected ${expected}, got ${actual}`,
        );
    }
}

// ── Semver compare ────────────────────────────────────────────────────────────

interface SemVer {
    major: number;
    minor: number;
    patch: number;
    pre: string[];
}

function parseSemver(s: string): SemVer | null {
    const m = s.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
    if (!m || !m[1] || !m[2] || !m[3]) return null;
    return {
        major: parseInt(m[1], 10),
        minor: parseInt(m[2], 10),
        patch: parseInt(m[3], 10),
        pre: m[4] ? m[4].split(".") : [],
    };
}

function comparePre(a: string[], b: string[]): number {
    if (a.length === 0 && b.length === 0) return 0;
    if (a.length === 0) return 1;
    if (b.length === 0) return -1;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        const ai = a[i]!, bi = b[i]!;
        const aNum = /^\d+$/.test(ai);
        const bNum = /^\d+$/.test(bi);
        if (aNum && !bNum) return -1;
        if (!aNum && bNum) return 1;
        if (aNum && bNum) {
            const an = parseInt(ai, 10), bn = parseInt(bi, 10);
            if (an !== bn) return an - bn;
        } else if (ai !== bi) {
            return ai < bi ? -1 : 1;
        }
    }
    return a.length - b.length;
}

/**
 * Return `true` when `targetTag` represents a semver newer than `currentVersion`.
 *
 * Both inputs are normalised (leading `v` stripped) before parsing.
 * Unparseable inputs → `false` (defensive).
 */
export function isNewer(targetTag: string, currentVersion: string): boolean {
    const target = parseSemver(targetTag);
    const current = parseSemver(currentVersion);
    if (!target || !current) return false;

    if (target.major !== current.major) return target.major > current.major;
    if (target.minor !== current.minor) return target.minor > current.minor;
    if (target.patch !== current.patch) return target.patch > current.patch;

    // Same X.Y.Z — release beats prerelease; prerelease compared per SemVer 2.0.0 §11.4.
    return comparePre(target.pre, current.pre) > 0;
}

/**
 * Normalise a version string:
 * - Trim whitespace.
 * - Return `"latest"` (case-insensitive) as `"latest"`.
 * - Otherwise strip a single leading `v`.
 */
export function normalizeVersion(input: string): string {
    const trimmed = input.trim();
    if (trimmed.toLowerCase() === "latest") return "latest";
    return trimmed.replace(/^v/, "");
}
