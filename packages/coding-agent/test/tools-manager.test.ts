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

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "atomic-tools-manager-"));
		vi.stubEnv(ENV_AGENT_DIR, join(tempDir, "agent"));
		vi.stubEnv(ENV_OFFLINE, "");
		vi.stubEnv("PI_OFFLINE", "");
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

		await expect(ensureTool("fd", true)).resolves.toBeUndefined();

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

		await expect(ensureTool("fd", true)).resolves.toBeUndefined();

		expect(archiveAttempts).toBe(3);
		expect(fetchMock.mock.calls.filter(([input]) => String(input) === releaseUrl)).toHaveLength(1);
		expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith(archiveUrlPrefix))).toHaveLength(3);
	});
});
