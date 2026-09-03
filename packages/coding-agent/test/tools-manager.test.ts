import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnSyncReturns } from "child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, ENV_OFFLINE } from "../src/config.ts";

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
		({ ensureTool } = await import("../src/utils/tools-manager.ts"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("retries transient release metadata errors before downloading a managed tool", async () => {
		const releaseUrl = "https://api.github.com/repos/sharkdp/fd/releases/latest";
		let releaseAttempts = 0;
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			if (String(input) === releaseUrl) {
				releaseAttempts += 1;
				return releaseAttempts < 3 ? new Response("busy", { status: 503 }) : Response.json({ tag_name: "v10.2.0" });
			}
			return new Response("download unavailable", { status: 404 });
		});

		await expect(ensureTool("fd")).resolves.toBeUndefined();

		expect(releaseAttempts).toBe(3);
		expect(fetchMock.mock.calls.filter(([input]) => String(input) === releaseUrl)).toHaveLength(3);
	});

	it("retries transient archive download errors after release metadata succeeds", async () => {
		const releaseUrl = "https://api.github.com/repos/sharkdp/fd/releases/latest";
		const archiveUrlPrefix = "https://github.com/sharkdp/fd/releases/download/v10.2.0/";
		let archiveAttempts = 0;
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url === releaseUrl) return Response.json({ tag_name: "v10.2.0" });
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
		const releaseUrl = `https://api.github.com/repos/${repo}/releases/latest`;
		const archiveUrl = `https://github.com/${repo}/releases/download/${tagPrefix}${version}/${assetName}`;
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			if (String(input) === releaseUrl) {
				return Response.json({ tag_name: `${tagPrefix}${version}` });
			}
			return new Response("download unavailable", { status: 404 });
		});

		await expect(ensureTool(tool)).resolves.toBeUndefined();

		expect(fetchMock.mock.calls.some(([input]) => String(input) === archiveUrl)).toBe(true);
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

	it("no longer contains any console write, silent flag or not", () => {
		// The fullscreen alternate screen makes any console write here a frame
		// corruption; guard the whole function against reintroduction.
		expect(ensureTool.toString()).not.toContain("console.");
	});
});
