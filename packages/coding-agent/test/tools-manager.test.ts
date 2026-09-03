import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnSyncReturns } from "child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, ENV_OFFLINE } from "../src/config.ts";

const mocks = vi.hoisted(() => ({
	spawnSync: vi.fn<(command: string, args?: readonly string[]) => SpawnSyncReturns<Buffer>>(),
}));

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
		mocks.spawnSync.mockReset();
		mocks.spawnSync.mockReturnValue({ error: new Error("not found") } as SpawnSyncReturns<Buffer>);
		vi.resetModules();
		({ ensureTool, getLatestVersion } = await import("../src/utils/tools-manager.ts"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("retries transient release metadata errors before downloading a managed tool", async () => {
		const releaseUrl = "https://github.com/BurntSushi/ripgrep/releases/latest";
		let releaseAttempts = 0;
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			if (String(input) === releaseUrl) {
				releaseAttempts += 1;
				return releaseAttempts < 3
					? new Response("busy", { status: 503 })
					: new Response(null, { status: 302, headers: { location: "/BurntSushi/ripgrep/releases/tag/14.1.1" } });
			}
			return new Response("download unavailable", { status: 404 });
		});

		await expect(ensureTool("rg")).resolves.toBeUndefined();

		expect(releaseAttempts).toBe(3);
		expect(fetchMock.mock.calls.filter(([input]) => String(input) === releaseUrl)).toHaveLength(3);
	});

	it("retries transient archive download errors after release metadata succeeds", async () => {
		const releaseUrl = "https://github.com/BurntSushi/ripgrep/releases/latest";
		const archiveUrlPrefix = "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/";
		let archiveAttempts = 0;
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url === releaseUrl)
				return new Response(null, {
					status: 302,
					headers: { location: "/BurntSushi/ripgrep/releases/tag/14.1.1" },
				});
			if (url.startsWith(archiveUrlPrefix)) {
				archiveAttempts += 1;
				return archiveAttempts < 3 ? new Response("busy", { status: 503 }) : new Response("archive");
			}
			return new Response("unexpected request", { status: 404 });
		});
		await expect(ensureTool("rg")).resolves.toBeUndefined();

		expect(archiveAttempts).toBe(3);
		expect(fetchMock.mock.calls.filter(([input]) => String(input) === releaseUrl)).toHaveLength(1);
		expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith(archiveUrlPrefix))).toHaveLength(3);
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

	it("no longer contains any console write, silent flag or not", () => {
		// The fullscreen alternate screen makes any console write here a frame
		// corruption; guard the whole function against reintroduction.
		expect(ensureTool.toString()).not.toContain("console.");
	});
});
