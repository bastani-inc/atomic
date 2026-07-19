import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { handlePackageCommand, refreshModelCatalogs } from "../src/package-manager-cli.ts";
import { parsePackageCommand } from "../src/package-manager-cli-parser.ts";

describe("atomic update --models", () => {
	let agentDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		agentDir = join(tmpdir(), `atomic-model-refresh-${process.pid}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(agentDir, { recursive: true });
		previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		process.exitCode = 0;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		rmSync(agentDir, { recursive: true, force: true });
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		process.exitCode = 0;
	});

	it("parses models as an exclusive update target", () => {
		expect(parsePackageCommand(["update", "--models"])?.updateTarget).toEqual({ type: "models" });
		expect(parsePackageCommand(["update", "--models", "--self"])?.conflictingOptions).toContain(
			"--models cannot be combined",
		);
	});

	it("force-refreshes model catalogs without running a package update", async () => {
		const refresh = vi.fn(async () => {});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await expect(handlePackageCommand(["update", "--models"], { refreshModelCatalogs: refresh })).resolves.toBe(true);
		expect(refresh).toHaveBeenCalledWith(agentDir);
		expect(log.mock.calls.flat().join("\n")).toContain("Model catalogs refreshed");
		expect(process.exitCode ?? 0).toBe(0);
	});

	it("uses Atomic's remote-catalog wrappers in the real forced refresh", async () => {
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({ anthropic: { type: "api_key", key: "test-key" } }),
		);
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unavailable", { status: 501 }));

		await refreshModelCatalogs(agentDir);

		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url.toString()).toBe("https://pi.dev/api/models/providers/anthropic");
		expect(init?.signal?.aborted).toBe(false);
	});

	it("loads and force-refreshes Atomic extension providers", async () => {
		let factoryCalls = 0;
		let refreshCalls = 0;
		let observedOptions: { allowNetwork: boolean; force?: boolean } | undefined;
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await expect(handlePackageCommand(["update", "--models"], {
			extensionFactories: [
				(pi) => {
					factoryCalls += 1;
					pi.registerProvider("extension-catalog", {
						refreshModels: async ({ allowNetwork, force }) => {
							refreshCalls += 1;
							observedOptions = { allowNetwork, force };
							return [];
						},
					});
				},
			],
		})).resolves.toBe(true);

		expect(factoryCalls).toBeGreaterThanOrEqual(1);
		expect(refreshCalls).toBe(1);
		expect(observedOptions).toEqual({ allowNetwork: true, force: true });
		expect(log.mock.calls.flat().join("\n")).toContain("Model catalogs refreshed");
	});


	it("fails when an extension cannot load for model refresh", async () => {
		await expect(refreshModelCatalogs(agentDir, {
			extensionFactories: [() => { throw new Error("extension load failed"); }],
		})).rejects.toThrow("extension load failed");
	});

	it("bounds extension loading with the model refresh timeout", async () => {
		vi.useFakeTimers();
		const refresh = refreshModelCatalogs(agentDir, {
			extensionFactories: [async () => new Promise<void>(() => {})],
		});
		const rejected = expect(refresh).rejects.toThrow("timed out");

		await vi.advanceTimersByTimeAsync(15_000);
		await rejected;
	});
	it("enforces the forced refresh timeout when a provider ignores abort", async () => {
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({ anthropic: { type: "api_key", key: "test-key" } }),
		);
		vi.useFakeTimers();
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Promise<Response>(() => {}));
		const refresh = refreshModelCatalogs(agentDir);
		const rejected = expect(refresh).rejects.toThrow("timed out");

		await vi.advanceTimersByTimeAsync(15_000);

		await rejected;
	});

	it("surfaces a forced catalog refresh failure", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(
			handlePackageCommand(["update", "--models"], {
				refreshModelCatalogs: async () => {
					throw new Error("catalog offline");
				},
			}),
		).resolves.toBe(true);
		expect(error.mock.calls.flat().join("\n")).toContain("catalog offline");
		expect(process.exitCode).toBe(1);
	});
});
