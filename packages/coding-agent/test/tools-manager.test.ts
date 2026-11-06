import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnSyncReturns } from "child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, ENV_OFFLINE, VERSION } from "../src/config.ts";
import { isManagedToolDownloadError, isManagedToolTimeoutError } from "../src/utils/managed-tool-errors.js";
import { getPiUserAgent } from "../src/utils/pi-user-agent.ts";
import type { ToolStatus } from "../src/utils/tools-manager.js";

const mocks = vi.hoisted(() => ({
	arch: vi.fn<typeof import("node:os").arch>(),
	platform: vi.fn<typeof import("node:os").platform>(),
	spawnSync: vi.fn<(command: string, args?: readonly string[]) => SpawnSyncReturns<Buffer>>(),
}));

vi.mock("os", async () => {
	const actual = await vi.importActual<typeof import("os")>("os");
	return { ...actual, arch: mocks.arch, platform: mocks.platform };
});

vi.mock("child_process", async () => {
	const actual = await vi.importActual<typeof import("child_process")>("child_process");
	return { ...actual, spawnSync: mocks.spawnSync };
});

describe("managed tool downloads", () => {
	let tempDir: string;
	let ensureTool: typeof import("../src/utils/tools-manager.ts").ensureTool;
	let getLatestVersion: typeof import("../src/utils/tools-manager.ts").getLatestVersion;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "atomic-tools-manager-"));
		vi.stubEnv(ENV_AGENT_DIR, join(tempDir, "agent"));
		vi.stubEnv(ENV_OFFLINE, "");
		vi.stubEnv("PI_OFFLINE", "");
		mocks.arch.mockReset();
		mocks.arch.mockReturnValue(process.arch);
		mocks.platform.mockReset();
		mocks.platform.mockReturnValue(process.platform);
		mocks.spawnSync.mockReset();
		mocks.spawnSync.mockReturnValue({ error: new Error("not found") } as SpawnSyncReturns<Buffer>);
		vi.resetModules();
		({ ensureTool, getLatestVersion } = await import("../src/utils/tools-manager.ts"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("retries transient release metadata errors before downloading a managed tool", async () => {
		const releaseUrl = "https://github.com/sharkdp/fd/releases/latest";
		let releaseAttempts = 0;
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			if (String(input) === releaseUrl) {
				releaseAttempts += 1;
				return releaseAttempts < 3
					? new Response("busy", { status: 503 })
					: new Response(null, { status: 302, headers: { location: "/sharkdp/fd/releases/tag/v10.2.0" } });
			}
			return new Response("download unavailable", { status: 404 });
		});

		await expect(ensureTool("fd")).resolves.toBeUndefined();

		expect(releaseAttempts).toBe(3);
		expect(fetchMock.mock.calls.filter(([input]) => String(input) === releaseUrl)).toHaveLength(3);
	});

	it("retries transient archive download errors after release metadata succeeds", async () => {
		const releaseUrl = "https://github.com/sharkdp/fd/releases/latest";
		const archiveUrlPrefix = "https://github.com/sharkdp/fd/releases/download/v10.2.0/";
		let archiveAttempts = 0;
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url === releaseUrl)
				return new Response(null, {
					status: 302,
					headers: { location: "/sharkdp/fd/releases/tag/v10.2.0" },
				});
			if (url.startsWith(archiveUrlPrefix)) {
				archiveAttempts += 1;
				return archiveAttempts < 3 ? new Response("busy", { status: 503 }) : new Response("archive");
			}
			return new Response("unexpected request", { status: 404 });
		});
		await expect(ensureTool("fd")).resolves.toBeUndefined();

		expect(archiveAttempts).toBe(3);
		expect(fetchMock.mock.calls.filter(([input]) => String(input) === releaseUrl)).toHaveLength(1);
		expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith(archiveUrlPrefix))).toHaveLength(3);
	});

	it.each([
		["fd", "x64", "fd-v10.2.0-x86_64-unknown-linux-musl.tar.gz"],
		["fd", "arm64", "fd-v10.2.0-aarch64-unknown-linux-musl.tar.gz"],
		["rg", "x64", "ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz"],
		["rg", "arm64", "ripgrep-15.2.0-aarch64-unknown-linux-musl.tar.gz"],
	] as const)("downloads the %s %s musl archive on Linux", async (tool, architecture, assetName) => {
		mocks.platform.mockReturnValue("linux");
		mocks.arch.mockReturnValue(architecture);
		const repo = tool === "fd" ? "sharkdp/fd" : "BurntSushi/ripgrep";
		const version = tool === "fd" ? "10.2.0" : "15.2.0";
		const tagPrefix = tool === "fd" ? "v" : "";
		const releaseUrl = `https://github.com/${repo}/releases/latest`;
		const archiveUrl = `https://github.com/${repo}/releases/download/${tagPrefix}${version}/${assetName}`;
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			if (String(input) === releaseUrl) {
				return new Response(null, {
					status: 302,
					headers: { location: `/${repo}/releases/tag/${tagPrefix}${version}` },
				});
			}
			return new Response("download unavailable", { status: 404 });
		});

		await expect(ensureTool(tool)).resolves.toBeUndefined();

		expect(fetchMock.mock.calls.some(([input]) => String(input) === archiveUrl)).toBe(true);
	});

	it("pins fd 10.3.0 on darwin/x64 without looking up the latest release", async () => {
		mocks.platform.mockReturnValue("darwin");
		mocks.arch.mockReturnValue("x64");
		const archiveUrl =
			"https://github.com/sharkdp/fd/releases/download/v10.3.0/fd-v10.3.0-x86_64-apple-darwin.tar.gz";
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			if (String(input) === archiveUrl) return new Response("archive");
			return new Response("unexpected request", { status: 404 });
		});

		await expect(ensureTool("fd")).resolves.toBeUndefined();

		expect(fetchMock.mock.calls.some(([input]) => String(input) === archiveUrl)).toBe(true);
		expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/releases/latest"))).toBe(false);
	});

	it.each([
		["rg", "darwin", "x64", "https://github.com/BurntSushi/ripgrep/releases/latest"],
		["fd", "darwin", "arm64", "https://github.com/sharkdp/fd/releases/latest"],
		["fd", "linux", "x64", "https://github.com/sharkdp/fd/releases/latest"],
	] as const)("looks up the latest %s release on %s/%s", async (tool, plat, architecture, releaseUrl) => {
		mocks.platform.mockReturnValue(plat);
		mocks.arch.mockReturnValue(architecture);
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unavailable", { status: 404 }));

		assert.equal(await ensureTool(tool), undefined);

		assert.deepEqual(
			fetchMock.mock.calls.map(([input]) => String(input)),
			[releaseUrl],
		);
	});

	it("resolves the version from the release page redirect", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(null, {
					status: 302,
					headers: { location: "https://github.com/sharkdp/fd/releases/tag/v10.4.2" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		assert.equal(await getLatestVersion("fd"), "10.4.2");
		assert.equal(fetchMock.mock.calls[0]?.[0], "https://github.com/sharkdp/fd/releases/latest");
		assert.equal((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.redirect, "manual");
	});

	it("discards the body of the release redirect", async () => {
		let discarded = false;
		const body = new ReadableStream({
			cancel() {
				discarded = true;
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () => new Response(body, { status: 302, headers: { location: "/sharkdp/fd/releases/tag/v10.4.2" } }),
			),
		);

		assert.equal(await getLatestVersion("fd"), "10.4.2");
		assert.equal(discarded, true);
	});

	it("identifies itself with Atomic's detailed User-Agent when resolving the version", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(null, {
					status: 302,
					headers: { location: "https://github.com/sharkdp/fd/releases/tag/v10.4.2" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await getLatestVersion("fd");
		const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as Record<string, string>;
		assert.equal(headers["User-Agent"], getPiUserAgent(VERSION));
	});

	it("resolves relative release redirects", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(null, { status: 302, headers: { location: "/BurntSushi/ripgrep/releases/tag/15.2.0" } }),
			),
		);
		assert.equal(await getLatestVersion("rg"), "15.2.0");
	});

	it("keeps a v inside the tag", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(null, { status: 302, headers: { location: "/sharkdp/fd/releases/tag/2.0.0-dev" } }),
			),
		);
		assert.equal(await getLatestVersion("fd"), "2.0.0-dev");
	});

	it.each([
		[299, false],
		[300, true],
		[399, true],
		[400, false],
	])("treats a release response with HTTP %d and a location as a redirect: %s", async (status, redirect) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status, headers: { location: "/sharkdp/fd/releases/tag/v10.4.2" } })),
		);
		const result = await getLatestVersion("fd").catch((caught: Error) => caught);
		if (redirect) assert.equal(result, "10.4.2");
		else assert.ok(isManagedToolDownloadError(result) && result.fields.detail === "no release redirect");
	});

	it("reports a non-redirect release response with the lookup URL (#4389)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("not found", { status: 404 })),
		);
		const error = await getLatestVersion("fd").catch((caught: Error) => caught);
		assert.ok(isManagedToolDownloadError(error));
		assert.deepEqual(error.fields, {
			tool: "fd",
			phase: "resolve-version",
			url: "https://github.com/sharkdp/fd/releases/latest",
			httpStatus: 404,
			detail: "no release redirect",
		});
		assert.equal(error.retryable, false);
		assert.equal(error.cause, undefined);
	});

	it.each([
		["/sharkdp/fd/issues", "redirected to /sharkdp/fd/issues"],
		["/sharkdp/fd/releases/tag/", "redirected to /sharkdp/fd/releases/tag/"],
	])("reports a release redirect to %s as unexpected (#4389)", async (location, detail) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 302, headers: { location } })),
		);
		const error = await getLatestVersion("fd").catch((caught: Error) => caught);
		assert.ok(isManagedToolDownloadError(error));
		assert.equal(error.fields.httpStatus, 302);
		assert.equal(error.fields.detail, detail);
	});

	it("reports an offline skip through onStatus and never writes to the console", async () => {
		vi.stubEnv(ENV_OFFLINE, "1");
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const statuses: import("../src/utils/tools-manager.ts").ToolStatus[] = [];

		await expect(ensureTool("fd", (status) => statuses.push(status))).resolves.toBeUndefined();

		expect(statuses).toEqual([
			{ type: "warning", message: "fd not found. Offline mode enabled, skipping download." },
		]);
		expect(consoleLog).not.toHaveBeenCalled();
		expect(consoleError).not.toHaveBeenCalled();
	});

	it.each(["arm", "ia32"] as const)("does not download x86-64 binaries on %s (pi #11209)", async (architecture) => {
		mocks.platform.mockReturnValue("linux");
		mocks.arch.mockReturnValue(architecture);
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const statuses: import("../src/utils/tools-manager.js").ToolStatus[] = [];

		const result = await ensureTool("rg", (status) => statuses.push(status));

		assert.equal(result, undefined);
		assert.equal(fetchMock.mock.calls.length, 0);
		assert.deepEqual(statuses, [
			{
				type: "warning",
				message: `ripgrep not found. Automatic download is not supported on linux/${architecture}. Install ripgrep with your system package manager.`,
			},
		]);
	});

	it("no longer contains any console write, silent flag or not", () => {
		// The fullscreen alternate screen makes any console write here a frame
		// corruption; guard the whole function against reintroduction.
		expect(ensureTool.toString()).not.toContain("console.");
	});

	describe("download failures keep their URL and cause (#4389)", () => {
		const releaseUrl = "https://github.com/BurntSushi/ripgrep/releases/latest";
		const archiveUrl =
			"https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz";
		const releaseRedirect = () =>
			new Response(null, { status: 302, headers: { location: "/BurntSushi/ripgrep/releases/tag/15.2.0" } });

		async function ensureRipgrep(): Promise<ToolStatus[]> {
			mocks.platform.mockReturnValue("linux");
			mocks.arch.mockReturnValue("x64");
			const statuses: ToolStatus[] = [];
			assert.equal(await ensureTool("rg", (status) => statuses.push(status)), undefined);
			return statuses;
		}

		it("reports a release lookup that fails before any response", async () => {
			const lookupFailure = new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND github.com") });
			const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(lookupFailure);

			const statuses = await ensureRipgrep();

			const failure = statuses.at(-1)?.error;
			assert.ok(isManagedToolDownloadError(failure));
			assert.equal(failure.code, "download-failed");
			assert.deepEqual(failure.fields, {
				tool: "rg",
				phase: "resolve-version",
				url: releaseUrl,
				detail: "fetch failed: getaddrinfo ENOTFOUND github.com",
			});
			assert.equal(failure.cause, lookupFailure);
			assert.equal(failure.retryable, true);
			assert.deepEqual(
				statuses.map(({ type, message }) => [type, message]),
				[
					["info", "ripgrep not found. Downloading..."],
					["warning", failure.message],
				],
			);
			assert.equal(fetchMock.mock.calls.length, 3);
		});

		it("reports a failed archive response with its URL and status", async () => {
			vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
				String(input) === releaseUrl ? releaseRedirect() : new Response("missing", { status: 404 }),
			);

			const failure = (await ensureRipgrep()).at(-1)?.error;

			assert.ok(isManagedToolDownloadError(failure));
			assert.deepEqual(failure.fields, { tool: "rg", phase: "download", url: archiveUrl, httpStatus: 404 });
			assert.equal(failure.cause, undefined);
			assert.equal(failure.retryable, false);
		});

		it("reports an archive request that fails before any response with its cause", async () => {
			const transferFailure = new TypeError("fetch failed", { cause: new Error("read ECONNRESET") });
			vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				if (String(input) === releaseUrl) return releaseRedirect();
				throw transferFailure;
			});

			const failure = (await ensureRipgrep()).at(-1)?.error;

			assert.ok(isManagedToolDownloadError(failure));
			assert.deepEqual(failure.fields, {
				tool: "rg",
				phase: "download",
				url: archiveUrl,
				detail: "fetch failed: read ECONNRESET",
			});
			assert.equal(failure.cause, transferFailure);
		});

		it("reports an archive response without a body", async () => {
			vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
				String(input) === releaseUrl ? releaseRedirect() : new Response(null, { status: 200 }),
			);

			const failure = (await ensureRipgrep()).at(-1)?.error;

			assert.ok(isManagedToolDownloadError(failure));
			assert.deepEqual(failure.fields, {
				tool: "rg",
				phase: "download",
				url: archiveUrl,
				httpStatus: 200,
				detail: "empty response body",
			});
		});

		it.each([
			["resolve-version", releaseUrl, 10_000],
			["download", archiveUrl, 120_000],
		] as const)(
			"reports a %s request to %s that outlives its %d ms limit as a timeout",
			async (phase, url, timeoutMs) => {
				const timedOut = new DOMException("The operation was aborted due to timeout", "TimeoutError");
				const limits: number[] = [];
				const deadlines: AbortController[] = [];
				vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
					limits.push(ms);
					const deadline = new AbortController();
					deadlines.push(deadline);
					return deadline.signal;
				});
				vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
					if (String(input) !== url) return releaseRedirect();
					return new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
						deadlines.at(-1)?.abort(timedOut);
					});
				});

				const failure = (await ensureRipgrep()).at(-1)?.error;

				assert.ok(isManagedToolTimeoutError(failure));
				assert.equal(failure.code, "download-timeout");
				assert.deepEqual({ ...failure.fields, elapsedMs: 0 }, { tool: "rg", phase, url, timeoutMs, elapsedMs: 0 });
				assert.ok(failure.fields.elapsedMs >= 0 && failure.fields.elapsedMs < 60_000);
				assert.equal(failure.cause, timedOut);
				assert.equal(failure.retryable, true);
				assert.equal(limits.at(-1), timeoutMs);
			},
		);

		const circularFailure = new Error("loop");
		Object.assign(circularFailure, { cause: circularFailure });
		const deepFailure = ["e5", "e4", "e3", "e2", "e1", "e0"].reduce<Error | undefined>(
			(cause, message) => new Error(message, { cause }),
			undefined,
		);

		it.each([
			["a rejection that is not an Error", "socket hang up", "socket hang up"],
			[
				"a cause that repeats its message once",
				new TypeError("fetch failed", { cause: new Error("fetch failed") }),
				"fetch failed",
			],
			["a circular cause chain", circularFailure, "loop"],
			["only the first five errors of a longer chain", deepFailure, "e0: e1: e2: e3: e4"],
		])("describes %s", async (_label, rejection, detail) => {
			vi.spyOn(globalThis, "fetch").mockRejectedValue(rejection);

			const failure = (await ensureRipgrep()).at(-1)?.error;

			assert.ok(isManagedToolDownloadError(failure));
			assert.equal(failure.fields.detail, detail);
			assert.equal(failure.cause, rejection);
		});

		it("keeps reporting a failure after the download in plain words", async () => {
			vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
				String(input) === releaseUrl ? releaseRedirect() : new Response("archive"),
			);

			const statuses = await ensureRipgrep();

			assert.deepEqual(statuses.at(-1), {
				type: "warning",
				message:
					"Failed to download ripgrep: Failed to extract ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz: tar: not found",
			});
		});
	});
});
