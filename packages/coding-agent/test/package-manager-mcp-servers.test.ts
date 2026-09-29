import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("package manifest MCP servers", () => {
	let tempDir: string;
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;
	let previousOfflineEnv: string | undefined;

	beforeEach(() => {
		previousOfflineEnv = process.env.ATOMIC_OFFLINE;
		delete process.env.ATOMIC_OFFLINE;
		tempDir = join(tmpdir(), `pm-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager });
	});

	afterEach(() => {
		if (previousOfflineEnv === undefined) delete process.env.ATOMIC_OFFLINE;
		else process.env.ATOMIC_OFFLINE = previousOfflineEnv;
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writePackage(name: string, manifest: Record<string, object>): string {
		const pkgDir = join(tempDir, name);
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name, ...manifest }));
		return pkgDir;
	}

	it("resolves a manifest mcpServers file relative to the package root (#3355)", async () => {
		const pkgDir = writePackage("mcp-file-pkg", { atomic: { mcpServers: "./config/mcp.json" } });
		const github = {
			url: "https://example.test/mcp",
			auth: "bearer",
			bearerTokenEnv: "GITHUB_TOKEN",
			headers: { "X-Org": `\${ORG}` },
			lifecycle: "lazy",
			timeoutMs: 5000,
		};
		mkdirSync(join(pkgDir, "config"));
		writeFileSync(join(pkgDir, "config", "mcp.json"), JSON.stringify({ mcpServers: { github } }));
		settingsManager.setPackages([pkgDir]);

		const result = await packageManager.resolve();

		expect(result.mcpServers).toEqual([
			{
				name: "github",
				config: github,
				enabled: true,
				path: join(pkgDir, "config", "mcp.json"),
				metadata: expect.objectContaining({
					source: pkgDir,
					scope: "user",
					origin: "package",
					packageRoot: pkgDir,
				}),
			},
		]);
	});

	it("resolves inline manifest mcpServers under the atomic or pi key (#3355)", async () => {
		const atomicPkg = writePackage("atomic-inline", {
			atomic: { mcpServers: { local: { command: "node", args: ["server.js"], env: { TOKEN: `\${TOKEN}` } } } },
		});
		const piPkg = writePackage("pi-inline", { pi: { mcpServers: { remote: { url: "https://remote.test/mcp" } } } });
		settingsManager.setPackages([atomicPkg, piPkg]);

		const result = await packageManager.resolve();

		expect(result.mcpServers.map(({ name, config, path, enabled }) => ({ name, config, path, enabled }))).toEqual([
			{
				name: "local",
				config: { command: "node", args: ["server.js"], env: { TOKEN: `\${TOKEN}` } },
				path: join(atomicPkg, "package.json"),
				enabled: true,
			},
			{
				name: "remote",
				config: { url: "https://remote.test/mcp" },
				path: join(piPkg, "package.json"),
				enabled: true,
			},
		]);
	});

	it("resolves a relative stdio cwd against the package root (#3355)", async () => {
		const pkgDir = writePackage("cwd-pkg", {
			atomic: {
				mcpServers: {
					root: { command: "node", args: ["./server.js"], cwd: "." },
					nested: { command: "node", cwd: "bin" },
					home: { command: "node", cwd: "~/tools" },
					variable: { command: "node", cwd: `\${TOOLS_DIR}` },
					inherited: { command: "node" },
				},
			},
		});
		settingsManager.setPackages([pkgDir]);

		const result = await packageManager.resolve();

		expect(Object.fromEntries(result.mcpServers.map((server) => [server.name, server.config.cwd]))).toEqual({
			root: pkgDir,
			nested: join(pkgDir, "bin"),
			home: "~/tools",
			variable: `\${TOOLS_DIR}`,
			inherited: undefined,
		});
	});

	describe("package filter mcpServers patterns", () => {
		function writeFourServerPackage(): string {
			const url = "https://example.test/mcp";
			return writePackage("filtered", {
				atomic: {
					mcpServers: { github: { url }, "github-legacy": { url }, slack: { url }, linear: { url } },
				},
			});
		}

		async function resolvedStates(): Promise<Record<string, boolean>> {
			const result = await packageManager.resolve();
			return Object.fromEntries(result.mcpServers.map((server) => [server.name, server.enabled]));
		}

		it("selects servers by name with include, ! exclude and + force-include patterns (#3355)", async () => {
			const pkgDir = writeFourServerPackage();
			settingsManager.setPackages([{ source: pkgDir, mcpServers: ["github*", "!github-legacy", "+linear"] }]);

			expect(await resolvedStates()).toEqual({
				github: true,
				"github-legacy": false,
				slack: false,
				linear: true,
			});
		});

		it("disables every server for an empty list and keeps only listed servers without autoload (#3355)", async () => {
			const pkgDir = writeFourServerPackage();
			settingsManager.setPackages([{ source: pkgDir, mcpServers: [] }]);
			expect(await resolvedStates()).toEqual({
				github: false,
				"github-legacy": false,
				slack: false,
				linear: false,
			});

			settingsManager.setPackages([{ source: pkgDir, autoload: false, mcpServers: ["+slack"] }]);
			expect(await resolvedStates()).toEqual({ slack: true });
		});

		it("keeps every server when the filter object omits mcpServers (#3355)", async () => {
			const pkgDir = writeFourServerPackage();
			settingsManager.setPackages([{ source: pkgDir, extensions: [] }]);

			expect(await resolvedStates()).toEqual({
				github: true,
				"github-legacy": true,
				slack: true,
				linear: true,
			});
		});
	});
});
