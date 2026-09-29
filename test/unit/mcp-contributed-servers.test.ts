import assert from "node:assert/strict";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext, McpServerContribution } from "@bastani/atomic";
import { afterEach, beforeEach, test, vi } from "vitest";
import { getPiGlobalConfigPath, getServerProvenance, loadMcpConfig } from "../../packages/mcp/config.js";
import { initializeMcp } from "../../packages/mcp/init.js";
import { createMcpPanel } from "../../packages/mcp/mcp-panel.js";
import { McpServerManager } from "../../packages/mcp/server-manager.js";
import type { McpPanelCallbacks, ServerProvenance } from "../../packages/mcp/types.js";
import { makeTempDirectory, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";

let root = "";
let cwd = "";
const originalConnect = McpServerManager.prototype.connect;
const originalCloseAll = McpServerManager.prototype.closeAll;

beforeEach(() => {
	root = makeTempDirectory("mcp-contributed-");
	cwd = join(root, "project");
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(root, "agent"));
});

afterEach(() => {
	McpServerManager.prototype.connect = originalConnect;
	McpServerManager.prototype.closeAll = originalCloseAll;
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	removeTempDirectory(root);
});

function packageContribution(name: string, config: McpServerContribution["config"]): McpServerContribution {
	return {
		name,
		config,
		origin: "package",
		sourceInfo: { path: "/pkgs/acme/package.json", source: "npm:@acme/tools", scope: "user", origin: "package" },
	};
}

function extensionContribution(
	name: string,
	config: McpServerContribution["config"],
	sourceInfo: Partial<McpServerContribution["sourceInfo"]> = {},
): McpServerContribution {
	return {
		name,
		config,
		origin: "extension",
		sourceInfo: {
			path: "/home/me/.atomic/agent/extensions/local.ts",
			source: "auto",
			scope: "user",
			origin: "top-level",
			...sourceInfo,
		},
	};
}

test("contributed MCP servers are the lowest layer that user and project configs replace by name (#3355)", async () => {
	await writeFileEnsuringDir(
		join(root, "agent", "mcp.json"),
		JSON.stringify({ mcpServers: { "user-wins": { url: "https://user.test/mcp" } } }),
	);
	await writeFileEnsuringDir(
		join(cwd, ".mcp.json"),
		JSON.stringify({ mcpServers: { "project-wins": { command: "project-server" } } }),
	);

	const config = loadMcpConfig(undefined, cwd, [
		packageContribution("user-wins", { url: "https://package.test/mcp", lifecycle: "eager", timeoutMs: 1000 }),
		extensionContribution("project-wins", { url: "http://127.0.0.1:4318/mcp" }),
		packageContribution("contributed-only", {
			url: `https://\${ACME_HOST}/mcp`,
			auth: "bearer",
			bearerTokenEnv: "ACME_TOKEN",
		}),
	]);

	assert.deepEqual(config.mcpServers["user-wins"], { url: "https://user.test/mcp" });
	assert.deepEqual(config.mcpServers["project-wins"], { command: "project-server" });
	assert.deepEqual(config.mcpServers["contributed-only"], {
		url: `https://\${ACME_HOST}/mcp`,
		auth: "bearer",
		bearerTokenEnv: "ACME_TOKEN",
	});
});

test("a disabled entry in any MCP config drops the server, contributed or configured (#3355)", async () => {
	await writeFileEnsuringDir(
		join(cwd, ".atomic", "mcp.json"),
		JSON.stringify({
			mcpServers: {
				contributed: { disabled: true },
				configured: { command: "configured-server", disabled: true },
				kept: { command: "kept-server", disabled: false },
			},
		}),
	);

	const config = loadMcpConfig(undefined, cwd, [packageContribution("contributed", { url: "https://c.test/mcp" })]);

	assert.equal("contributed" in config.mcpServers, false);
	assert.equal("configured" in config.mcpServers, false);
	assert.deepEqual(config.mcpServers.kept, { command: "kept-server", disabled: false });
});

test("an invalid contributed server is dropped with a warning naming its source (#3355)", () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

	const config = loadMcpConfig(undefined, cwd, [
		packageContribution("broken", { url: "https://broken.test/mcp", timeoutMs: -5 }),
		extensionContribution("healthy", { command: "healthy-server" }),
	]);

	assert.equal("broken" in config.mcpServers, false);
	assert.deepEqual(config.mcpServers.healthy, { command: "healthy-server" });
	const messages = warn.mock.calls.map((call) => call.map(String).join(" "));
	assert.ok(
		messages.some(
			(message) =>
				message.includes('"broken"') &&
				message.includes("package npm:@acme/tools") &&
				message.includes("timeoutMs"),
		),
		messages.join("\n"),
	);
});

test("provenance marks contributed servers with their source until a config file overrides them (#3355)", async () => {
	await writeFileEnsuringDir(
		join(cwd, ".mcp.json"),
		JSON.stringify({ mcpServers: { overridden: { command: "mine" } } }),
	);

	const provenance = getServerProvenance(undefined, cwd, [
		packageContribution("overridden", { url: "https://overridden.test/mcp" }),
		packageContribution("from-package", { url: "https://package.test/mcp" }),
		extensionContribution("from-extension", { url: "http://127.0.0.1:4318/mcp" }),
		extensionContribution(
			"from-package-extension",
			{ command: "node" },
			{ path: "/pkgs/acme/extensions/index.ts", source: "npm:@acme/tools", origin: "package" },
		),
	]);

	const userPath = getPiGlobalConfigPath();
	assert.deepEqual(provenance.get("from-package"), {
		path: userPath,
		kind: "contributed",
		source: "package npm:@acme/tools",
	});
	assert.deepEqual(provenance.get("from-extension"), {
		path: userPath,
		kind: "contributed",
		source: "extension /home/me/.atomic/agent/extensions/local.ts",
	});
	assert.deepEqual(provenance.get("from-package-extension"), {
		path: userPath,
		kind: "contributed",
		source: "extension from package npm:@acme/tools",
	});
	assert.equal(provenance.get("overridden")?.kind, "project");
});

test("the /mcp panel shows each contributed server's source (#3355)", () => {
	const callbacks: McpPanelCallbacks = {
		reconnect: async () => false,
		canAuthenticate: () => false,
		authenticate: async () => ({ ok: false }),
		getConnectionStatus: () => "idle",
		refreshCacheAfterReconnect: () => null,
	};
	const provenance = new Map<string, ServerProvenance>([
		["acme", { path: "/agent/mcp.json", kind: "contributed", source: "package npm:@acme/tools" }],
		["mine", { path: "/agent/mcp.json", kind: "user" }],
	]);
	const panel = createMcpPanel(
		{ mcpServers: { acme: { url: "https://acme.test/mcp" }, mine: { command: "mine" } } },
		null,
		provenance,
		callbacks,
		{ requestRender() {} },
		() => {},
	);
	try {
		const lines = panel.render(100).map((line) => stripVTControlCharacters(line));
		assert.ok(
			lines.some((line) => line.includes("acme (package npm:@acme/tools)")),
			lines.join("\n"),
		);
		assert.ok(
			lines.some((line) => /mine\s+\(not cached\)/.test(line)),
			lines.join("\n"),
		);
	} finally {
		panel.dispose();
	}
});

test("a startup connection failure for a contributed server names its source (#3355)", async () => {
	McpServerManager.prototype.connect = async function connect() {
		throw new Error("connection refused");
	};
	McpServerManager.prototype.closeAll = async function closeAll() {};
	const notifications: string[] = [];
	const pi = {
		getFlag: () => undefined,
		getMcpServerContributions: () => [
			extensionContribution("local-service", { url: "http://127.0.0.1:1/mcp", lifecycle: "eager" }),
		],
		sendMessage() {},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd,
		hasUI: true,
		signal: new AbortController().signal,
		ui: {
			setStatus() {},
			notify(message: string) {
				notifications.push(message);
			},
		},
	} as unknown as ExtensionContext;

	const state = await initializeMcp(pi, ctx);
	await state.lifecycle.gracefulShutdown();

	assert.ok(
		notifications.includes(
			"MCP: Failed to connect to local-service (extension /home/me/.atomic/agent/extensions/local.ts): connection refused",
		),
		notifications.join("\n"),
	);
});
