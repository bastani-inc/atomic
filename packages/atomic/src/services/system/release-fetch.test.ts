/**
 * Tests for release-fetch.ts
 *
 * Uses spyOn(globalThis, "fetch") to intercept HTTP calls without network.
 */

import {
    describe,
    test,
    expect,
    beforeEach,
    afterEach,
    mock,
    spyOn,
} from "bun:test";
import type { Mock } from "bun:test";
import * as realNodeFs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    getLatestRelease,
    getReleaseByTag,
    downloadAsset,
    downloadAssetFromUrl,
    verifyChecksum,
    isNewer,
    normalizeVersion,
} from "./release-fetch.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeRelease(tag: string) {
    return {
        tag_name: tag,
        assets: [
            {
                name: "atomic-linux-x64",
                browser_download_url: `https://example.com/${tag}/atomic-linux-x64`,
            },
        ],
    };
}

function fakeJsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "Content-Type": "application/json",
            ...extraHeaders,
        },
    });
}

function fakeStreamResponse(bytes: Uint8Array, status = 200): Response {
    return new Response(bytes.buffer as ArrayBuffer, { status });
}

// ── setup / teardown ──────────────────────────────────────────────────────────

let fetchSpy: Mock<typeof fetch>;
let savedGithubToken: string | undefined;

beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch");
    savedGithubToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
});

afterEach(() => {
    fetchSpy.mockRestore();
    if (savedGithubToken !== undefined) {
        process.env.GITHUB_TOKEN = savedGithubToken;
    } else {
        delete process.env.GITHUB_TOKEN;
    }
});

// ── getLatestRelease ──────────────────────────────────────────────────────────

describe("getLatestRelease", () => {
    test("happy path — correct URL, headers, and parsed shape", async () => {
        const release = makeRelease("v0.7.8");
        fetchSpy.mockResolvedValueOnce(fakeJsonResponse(release));

        const result = await getLatestRelease();

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://api.github.com/repos/flora131/atomic/releases/latest");

        const headers = init.headers as Record<string, string>;
        expect(headers["Accept"]).toBe("application/vnd.github+json");
        expect(headers["User-Agent"]).toBe("atomic-cli");
        expect(headers["Authorization"]).toBeUndefined();

        expect(result.tag_name).toBe("v0.7.8");
        expect(result.assets).toHaveLength(1);
        expect(result.assets[0]?.name).toBe("atomic-linux-x64");
    });

    test("includes Authorization header when GITHUB_TOKEN is set", async () => {
        process.env.GITHUB_TOKEN = "ghp_testtoken";
        fetchSpy.mockResolvedValueOnce(fakeJsonResponse(makeRelease("v0.7.8")));

        await getLatestRelease();

        const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        const headers = init.headers as Record<string, string>;
        expect(headers["Authorization"]).toBe("Bearer ghp_testtoken");
    });

    test("rate-limited 403 — throws exact message", async () => {
        fetchSpy.mockResolvedValueOnce(
            fakeJsonResponse({ message: "rate limit exceeded" }, 403, {
                "X-RateLimit-Remaining": "0",
            }),
        );

        let msg = "";
        try {
            await getLatestRelease();
        } catch (e) {
            msg = (e as Error).message;
        }
        expect(msg).toContain(
            "Set GITHUB_TOKEN to lift the 60 req/h anonymous limit",
        );
    });

    test("403 without rate-limit header — throws generic error", async () => {
        fetchSpy.mockResolvedValueOnce(
            fakeJsonResponse({ message: "forbidden" }, 403),
        );

        let msg = "";
        try {
            await getLatestRelease();
        } catch (e) {
            msg = (e as Error).message;
        }
        expect(msg).toContain("GitHub API error 403");
    });
});

// ── getReleaseByTag ───────────────────────────────────────────────────────────

describe("getReleaseByTag", () => {
    test("encodes tag in URL and returns release info", async () => {
        const release = makeRelease("v0.7.8");
        fetchSpy.mockResolvedValueOnce(fakeJsonResponse(release));

        const result = await getReleaseByTag("v0.7.8");

        const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(
            "https://api.github.com/repos/flora131/atomic/releases/tags/v0.7.8",
        );
        expect(result.tag_name).toBe("v0.7.8");
    });

    test("URL-encodes special characters in tag", async () => {
        fetchSpy.mockResolvedValueOnce(fakeJsonResponse(makeRelease("v0.7.8-0")));

        await getReleaseByTag("v0.7.8-0");

        const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(url).toContain("/releases/tags/v0.7.8-0");
    });
});

// ── downloadAsset ─────────────────────────────────────────────────────────────

describe("downloadAsset", () => {
    test("writes asset bytes to destPath", async () => {
        const bytes = new Uint8Array([0x41, 0x42, 0x43, 0x44]); // ABCD
        const release = makeRelease("v0.7.8");

        // First call: getReleaseByTag
        fetchSpy.mockResolvedValueOnce(fakeJsonResponse(release));
        // Second call: actual asset download
        fetchSpy.mockResolvedValueOnce(fakeStreamResponse(bytes));

        const dir = mkdtempSync(join(tmpdir(), "release-fetch-test-"));
        const destPath = join(dir, "atomic-linux-x64");

        try {
            await downloadAsset("v0.7.8", "atomic-linux-x64", destPath);

            const written = await Bun.file(destPath).bytes();
            expect(written).toEqual(bytes);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("throws when asset not found in release", async () => {
        fetchSpy.mockResolvedValueOnce(fakeJsonResponse(makeRelease("v0.7.8")));

        const dir = mkdtempSync(join(tmpdir(), "release-fetch-test-"));
        try {
            let msg = "";
            try {
                await downloadAsset(
                    "v0.7.8",
                    "nonexistent-asset",
                    join(dir, "out"),
                );
            } catch (e) {
                msg = (e as Error).message;
            }
            expect(msg).toContain(
                'Asset "nonexistent-asset" not found in release v0.7.8',
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ── downloadAssetFromUrl ──────────────────────────────────────────────────────

describe("downloadAssetFromUrl", () => {
    test("writes bytes from URL to destPath without extra fetch", async () => {
        const bytes = new Uint8Array([0x61, 0x62, 0x63]); // abc
        fetchSpy.mockResolvedValueOnce(fakeStreamResponse(bytes));

        const dir = mkdtempSync(join(tmpdir(), "release-fetch-url-"));
        const destPath = join(dir, "asset");

        try {
            await downloadAssetFromUrl("https://example.com/asset", destPath);

            expect(fetchSpy).toHaveBeenCalledTimes(1);
            const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
            expect(url).toBe("https://example.com/asset");

            const written = await Bun.file(destPath).bytes();
            expect(written).toEqual(bytes);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("throws on non-ok HTTP response", async () => {
        fetchSpy.mockResolvedValueOnce(new Response(null, { status: 404 }));

        const dir = mkdtempSync(join(tmpdir(), "release-fetch-url-"));
        try {
            let msg = "";
            try {
                await downloadAssetFromUrl("https://example.com/missing", join(dir, "out"));
            } catch (e) {
                msg = (e as Error).message;
            }
            expect(msg).toContain("Failed to download asset: HTTP 404");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("downloadAsset delegates to downloadAssetFromUrl (2 fetch calls total)", async () => {
        const bytes = new Uint8Array([0x78, 0x79]); // xy
        const release = makeRelease("v0.7.8");

        fetchSpy.mockResolvedValueOnce(fakeJsonResponse(release));
        fetchSpy.mockResolvedValueOnce(fakeStreamResponse(bytes));

        const dir = mkdtempSync(join(tmpdir(), "release-fetch-delegate-"));
        const destPath = join(dir, "atomic-linux-x64");

        try {
            await downloadAsset("v0.7.8", "atomic-linux-x64", destPath);

            expect(fetchSpy).toHaveBeenCalledTimes(2);
            const [, assetUrl] = fetchSpy.mock.calls.map((c) => (c as [string])[0]);
            expect(assetUrl).toBe("https://example.com/v0.7.8/atomic-linux-x64");

            const written = await Bun.file(destPath).bytes();
            expect(written).toEqual(bytes);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // ── Cluster C — atomic download cleanup on rename failure ─────────────────

    describe("rename failure cleanup", () => {
        const renameSyncMock = mock((_src: string, _dst: string) => {});
        const copyFileSyncMock = mock((_src: string, _dst: string) => {});
        const unlinkSyncMock = mock((_path: string) => {});

        beforeEach(async () => {
            renameSyncMock.mockReset();
            copyFileSyncMock.mockReset();
            unlinkSyncMock.mockReset();

            await mock.module("node:fs", () => ({
                ...realNodeFs,
                renameSync: renameSyncMock,
                copyFileSync: copyFileSyncMock,
                unlinkSync: unlinkSyncMock,
            }));
        });

        afterEach(async () => {
            // Restore real node:fs so outer tests keep passing.
            await mock.module("node:fs", () => ({ ...realNodeFs }));
        });

        test("cleans up tmpPath on EXDEV via copyFileSync fallback", async () => {
            renameSyncMock.mockImplementation((_src: string, _dst: string) => {
                throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
            });

            const bytes = new Uint8Array([0x41, 0x42]);
            fetchSpy.mockResolvedValueOnce(fakeStreamResponse(bytes));

            const dir = mkdtempSync(join(tmpdir(), "release-fetch-exdev-"));
            const destPath = join(dir, "atomic-out");

            try {
                await downloadAssetFromUrl("https://example.com/asset", destPath);

                // copyFileSync used as EXDEV fallback
                expect(copyFileSyncMock).toHaveBeenCalledTimes(1);
                const [copySrc, copyDst] = copyFileSyncMock.mock.calls[0] as [string, string];
                expect(copyDst).toBe(destPath);

                // unlinkSync called with the same tmpPath used as copySrc
                expect(unlinkSyncMock).toHaveBeenCalledTimes(1);
                const [unlinkPath] = unlinkSyncMock.mock.calls[0] as [string];
                expect(unlinkPath).toBe(copySrc);

                // function did not throw
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        test("rethrows non-EXDEV rename errors but still cleans up tmpPath", async () => {
            const eacces = Object.assign(new Error("EACCES"), { code: "EACCES" });
            renameSyncMock.mockImplementation((_src: string, _dst: string) => {
                throw eacces;
            });

            const bytes = new Uint8Array([0x43, 0x44]);
            fetchSpy.mockResolvedValueOnce(fakeStreamResponse(bytes));

            const dir = mkdtempSync(join(tmpdir(), "release-fetch-eacces-"));
            const destPath = join(dir, "atomic-out");

            let thrown: Error | null = null;
            try {
                await downloadAssetFromUrl("https://example.com/asset", destPath);
            } catch (e) {
                thrown = e as Error;
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }

            // must rethrow the EACCES error
            expect(thrown).not.toBeNull();
            expect((thrown as NodeJS.ErrnoException).code).toBe("EACCES");

            // cleanup still happened
            expect(unlinkSyncMock).toHaveBeenCalledTimes(1);
            // copyFileSync must NOT have been called (EACCES is not EXDEV)
            expect(copyFileSyncMock).toHaveBeenCalledTimes(0);
        });
    });
});

// ── verifyChecksum ────────────────────────────────────────────────────────────

describe("verifyChecksum", () => {
    test("no throw when checksum matches", async () => {
        const content = new Uint8Array([1, 2, 3, 4, 5]);
        const hasher = new Bun.CryptoHasher("sha256");
        hasher.update(content);
        const expected = hasher.digest("hex");

        const dir = mkdtempSync(join(tmpdir(), "release-fetch-cksum-"));
        const filePath = join(dir, "testfile");
        try {
            writeFileSync(filePath, content);
            const result = await verifyChecksum(filePath, expected);
            expect(result).toBeUndefined();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("throws Checksum mismatch on wrong expected hash", async () => {
        const content = new Uint8Array([1, 2, 3, 4, 5]);

        const dir = mkdtempSync(join(tmpdir(), "release-fetch-cksum-"));
        const filePath = join(dir, "testfile");
        try {
            writeFileSync(filePath, content);
            let msg = "";
            try {
                await verifyChecksum(filePath, "0".repeat(64));
            } catch (e) {
                msg = (e as Error).message;
            }
            expect(msg).toContain("Checksum mismatch");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("thrown message includes file path and both hashes", async () => {
        const content = new Uint8Array([9, 8, 7]);
        const wrong = "a".repeat(64);

        const dir = mkdtempSync(join(tmpdir(), "release-fetch-cksum-"));
        const filePath = join(dir, "testfile2");
        try {
            writeFileSync(filePath, content);
            let msg = "";
            try {
                await verifyChecksum(filePath, wrong);
            } catch (e) {
                msg = (e as Error).message;
            }
            expect(msg).toContain("Checksum mismatch");
            expect(msg).toContain(filePath);
            expect(msg).toContain(wrong);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ── isNewer ───────────────────────────────────────────────────────────────────

describe("isNewer", () => {
    test('("v0.8.0", "0.7.8") === true', () => {
        expect(isNewer("v0.8.0", "0.7.8")).toBe(true);
    });

    test('("0.7.8", "0.7.8") === false', () => {
        expect(isNewer("0.7.8", "0.7.8")).toBe(false);
    });

    test('("0.7.7", "0.7.8") === false', () => {
        expect(isNewer("0.7.7", "0.7.8")).toBe(false);
    });

    test('("v1.0.0", "0.9.9") === true', () => {
        expect(isNewer("v1.0.0", "0.9.9")).toBe(true);
    });

    test('prerelease "v0.7.9-0" vs "0.7.8" → true', () => {
        expect(isNewer("v0.7.9-0", "0.7.8")).toBe(true);
    });

    test("release is newer than same-version prerelease", () => {
        expect(isNewer("v0.7.9", "0.7.9-0")).toBe(true);
    });

    test("prerelease is not newer than release of same version", () => {
        expect(isNewer("v0.7.9-0", "0.7.9")).toBe(false);
    });

    test("unparseable target → false", () => {
        expect(isNewer("not-a-version", "0.7.8")).toBe(false);
    });

    test("unparseable current → false", () => {
        expect(isNewer("v0.8.0", "not-a-version")).toBe(false);
    });

    // ── Cluster B — numeric prerelease compare (SemVer 2.0.0 §11.3 + §11.4) ──

    test("numeric pre IDs compare numerically: 10 > 2 even though '10' < '2' lexically", () => {
        expect(isNewer("0.7.9-10", "0.7.9-2")).toBe(true);
    });

    test("numeric component within multi-id prerelease compares numerically: alpha.10 > alpha.2", () => {
        expect(isNewer("0.7.9-alpha.10", "0.7.9-alpha.2")).toBe(true);
    });

    test("alphanumeric pre ID > numeric pre ID per §11.4.1: alpha > 1", () => {
        expect(isNewer("0.7.9-alpha", "0.7.9-1")).toBe(true);
    });

    test("release > prerelease of same version per §11.3", () => {
        expect(isNewer("0.7.9", "0.7.9-rc.1")).toBe(true);
    });
});

// ── normalizeVersion ──────────────────────────────────────────────────────────

describe("normalizeVersion", () => {
    test('"latest" → "latest"', () => {
        expect(normalizeVersion("latest")).toBe("latest");
    });

    test('"v0.7.9" → "0.7.9"', () => {
        expect(normalizeVersion("v0.7.9")).toBe("0.7.9");
    });

    test('"0.7.9" → "0.7.9"', () => {
        expect(normalizeVersion("0.7.9")).toBe("0.7.9");
    });

    test('"  v1.0.0  " → "1.0.0"', () => {
        expect(normalizeVersion("  v1.0.0  ")).toBe("1.0.0");
    });

    test('"LATEST" → "latest" (case-insensitive)', () => {
        expect(normalizeVersion("LATEST")).toBe("latest");
    });
});
