import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import type { ExtensionAPI, ExtensionError } from "../src/core/extensions/index.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

it("reports unhandled MCP servers once per name at startup, reload and later registration", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-unhandled-mcp-"));
	const agentDir = join(cwd, "agent");
	const settingsManager = SettingsManager.inMemory();
	const errors: ExtensionError[] = [];
	let api: ExtensionAPI | undefined;
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		disabledBuiltinExtensions: ["mcp"],
		extensionFactories: [
			{
				name: "registrar",
				factory: (pi) => {
					api = pi;
					pi.registerMcpServer("initial", { url: "https://initial.test/mcp" });
					pi.on("session_start", () => pi.registerMcpServer("startup", { url: "https://startup.test/mcp" }));
				},
			},
		],
	});
	try {
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settingsManager,
			resourceLoader,
			builtins: { mcp: false },
			sessionManager: SessionManager.inMemory(cwd),
			extensionBindings: { onError: (error) => errors.push(error) },
		});
		try {
			assert.ok(api);
			assert.deepEqual(
				api.getMcpServerContributions!().map((server) => server.name),
				["initial", "startup"],
			);
			assert.deepEqual(
				errors.map((error) => error.event),
				["register_mcp_server", "register_mcp_server"],
			);
			assert.ok(errors.every((error) => error.extensionPath === "<inline:registrar>"));
			assert.match(
				errors[0].error,
				/MCP server "initial" is registered, but no loaded extension connects MCP servers/,
			);
			api!.registerMcpServer("later", { url: "https://later.test/mcp" });
			api!.registerMcpServer("later", { url: "https://replacement.test/mcp" });
			assert.equal(errors.length, 3);
			assert.match(errors[2].error, /MCP server "later"/);
			await session.bindExtensions({});
			assert.equal(errors.length, 3);
			await session.reload();
			assert.equal(errors.length, 5);
			assert.match(errors[3].error, /MCP server "initial"/);
			assert.match(errors[4].error, /MCP server "startup"/);
			api!.registerMcpServer("after-reload", { url: "https://reload.test/mcp" });
			assert.equal(errors.length, 6);
		} finally {
			await session.dispose();
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

it("suppresses MCP contribution warnings when an extension subscribes during startup", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-consumed-mcp-"));
	const agentDir = join(cwd, "agent");
	const settingsManager = SettingsManager.inMemory();
	const errors: ExtensionError[] = [];
	const snapshots: string[][] = [];
	let api: ExtensionAPI | undefined;
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		disabledBuiltinExtensions: ["mcp"],
		extensionFactories: [
			{
				name: "registrar",
				factory: (pi) => {
					api = pi;
					pi.registerMcpServer("initial", { url: "https://initial.test/mcp" });
				},
			},
			{
				name: "consumer",
				factory: (pi) => {
					pi.on("session_start", () => {
						const consume = () => snapshots.push(pi.getMcpServerContributions!().map((server) => server.name));
						consume();
						pi.onMcpServerContributionsChanged!(consume);
					});
				},
			},
		],
	});
	try {
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settingsManager,
			resourceLoader,
			builtins: { mcp: false },
			sessionManager: SessionManager.inMemory(cwd),
			extensionBindings: { onError: (error) => errors.push(error) },
		});
		try {
			assert.deepEqual(snapshots, [["initial"]]);
			api!.registerMcpServer("later", { url: "https://later.test/mcp" });
			await session.extensionRunner.drainWork();
			assert.deepEqual(snapshots, [["initial"], ["initial", "later"]]);
			assert.deepEqual(errors, []);
			await session.reload();
			api!.registerMcpServer("after-reload", { url: "https://reload.test/mcp" });
			await session.extensionRunner.drainWork();
			assert.deepEqual(snapshots.slice(2), [["initial"], ["initial", "after-reload"]]);
			assert.deepEqual(errors, []);
		} finally {
			await session.dispose();
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
