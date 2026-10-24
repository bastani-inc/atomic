import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnSyncReturns } from "child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, ENV_OFFLINE, VERSION } from "../src/config.ts";
import { getPiUserAgent } from "../src/utils/pi-user-agent.ts";

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

	it("resolves the version from the release page redirect", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(null, {
					status: 302,
					headers: { location: "https://github.com/sharkdp/fd/releases/tag/v10.4.2" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		assert.equal(await getLatestVersion("sharkdp/fd"), "10.4.2");
		assert.equal(fetchMock.mock.calls[0]?.[0], "https://github.com/sharkdp/fd/releases/latest");
		assert.equal((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.redirect, "manual");
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

		await getLatestVersion("sharkdp/fd");
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
		assert.equal(await getLatestVersion("BurntSushi/ripgrep"), "15.2.0");
	});

	it("reports a non-redirect release response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("not found", { status: 404 })),
		);
		await assert.rejects(
			getLatestVersion("sharkdp/fd"),
			/Failed to resolve latest sharkdp\/fd release: HTTP 404 without redirect/,
		);
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
		const statuses: import("../src/utils/tools-manager.ts").ToolStatus[] = [];

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
});
