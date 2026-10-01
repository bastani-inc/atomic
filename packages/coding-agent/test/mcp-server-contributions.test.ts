import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import type { McpServerContribution } from "../src/core/mcp-servers.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("MCP server contributions", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `mcp-contrib-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeMcpPackage(name: string, servers: Record<string, object>): string {
		const pkgDir = join(tempDir, name);
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name, atomic: { mcpServers: servers } }));
		return pkgDir;
	}

	function contributionReader(): {
		factory: (pi: ExtensionAPI) => void;
		read: () => McpServerContribution[];
	} {
		let api: ExtensionAPI | undefined;
		return {
			factory: (pi) => {
				api = pi;
			},
			read: () => {
				if (!api?.getMcpServerContributions) throw new Error("expected getMcpServerContributions on the API");
				return api.getMcpServerContributions();
			},
		};
	}

	it("exposes enabled package MCP servers to extensions with their package source (#3355)", async () => {
		const pkgDir = writeMcpPackage("docs-pkg", {
			docs: { url: "https://docs.test/mcp" },
			hidden: { url: "https://hidden.test/mcp" },
		});
		const reader = contributionReader();
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory({ packages: [{ source: pkgDir, mcpServers: ["!hidden"] }] }),
			extensionFactories: [reader.factory],
		});

		await loader.reload();

		expect(reader.read()).toEqual([
			{
				name: "docs",
				config: { url: "https://docs.test/mcp" },
				origin: "package",
				sourceInfo: expect.objectContaining({
					path: join(pkgDir, "package.json"),
					source: pkgDir,
					scope: "user",
					origin: "package",
				}),
			},
		]);
	});

	it("untrusted project packages contribute no MCP servers (#3355)", async () => {
		const userPkg = writeMcpPackage("user-pkg", { "user-server": { url: "https://user.test/mcp" } });
		const projectPkg = writeMcpPackage("project-pkg", { "project-server": { url: "https://project.test/mcp" } });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [userPkg] }));
		mkdirSync(join(cwd, ".atomic"), { recursive: true });
		writeFileSync(join(cwd, ".atomic", "settings.json"), JSON.stringify({ packages: [projectPkg] }));

		const contributedNames = async (trusted: boolean): Promise<string[]> => {
			const reader = contributionReader();
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
				extensionFactories: [reader.factory],
			});
			await loader.reload({ resolveProjectTrust: () => trusted });
			return reader
				.read()
				.map((contribution) => contribution.name)
				.sort();
		};

		expect(await contributedNames(false)).toEqual(["user-server"]);
		expect(await contributedNames(true)).toEqual(["project-server", "user-server"]);
	});

	it("factory registrations reach extensions loaded earlier, override packages and roll back with a failed factory (#3355)", async () => {
		const pkgDir = writeMcpPackage("shadowed-pkg", {
			shared: { url: "https://package.test/mcp" },
			packaged: { url: "https://packaged.test/mcp" },
		});
		const reader = contributionReader();
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory({ packages: [pkgDir] }),
			extensionFactories: [
				{ name: "reader", factory: reader.factory },
				{
					name: "registrar",
					factory: (pi) => {
						pi.registerMcpServer("shared", { url: "http://127.0.0.1:4318/mcp", lifecycle: "eager" });
						pi.registerMcpServer("runtime", { command: "node", args: ["server.js"] });
					},
				},
				{
					name: "broken",
					factory: (pi) => {
						pi.registerMcpServer("abandoned", { url: "https://abandoned.test/mcp" });
						throw new Error("factory failed after registering");
					},
				},
			],
		});

		await loader.reload();

		expect(reader.read()).toEqual([
			{
				name: "shared",
				config: { url: "http://127.0.0.1:4318/mcp", lifecycle: "eager" },
				origin: "extension",
				sourceInfo: expect.objectContaining({ path: "<inline:registrar>" }),
			},
			expect.objectContaining({ name: "packaged", origin: "package" }),
			{
				name: "runtime",
				config: { command: "node", args: ["server.js"] },
				origin: "extension",
				sourceInfo: expect.objectContaining({ path: "<inline:registrar>" }),
			},
		]);
	});
});
