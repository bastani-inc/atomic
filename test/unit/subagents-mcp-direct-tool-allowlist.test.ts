import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { resolveDirectTools } from "../../packages/mcp/direct-tools.js";
import { computeServerHash } from "../../packages/mcp/metadata-cache.js";
import {
	computeMcpServerHash,
	type McpConfig,
	type MetadataCache,
	parseMcpDirectToolSelections,
	resolveMcpDirectToolNamesFromConfig,
	type ToolPrefix,
} from "../../packages/subagents/src/runs/shared/mcp-direct-tool-allowlist.js";

const originalToken = process.env.SUBAGENT_TEST_MCP_TOKEN;

afterEach(() => {
	if (originalToken === undefined) delete process.env.SUBAGENT_TEST_MCP_TOKEN;
	else process.env.SUBAGENT_TEST_MCP_TOKEN = originalToken;
});

function cacheFor(
	config: McpConfig,
	serverName: string,
	tools: string[],
	resources: Array<{ name: string; uri: string }> = [],
): MetadataCache {
	return {
		version: 1,
		servers: {
			[serverName]: {
				configHash: computeMcpServerHash(config.mcpServers[serverName]!),
				cachedAt: Date.now(),
				tools: tools.map((name) => ({ name })),
				resources,
			},
		},
	};
}

describe("MCP direct-tool allowlist resolution", () => {
	test("parses server and server/tool selections", () => {
		const parsed = parseMcpDirectToolSelections(["chrome-devtools", "github/search_code", "github/"]);

		assert.equal(parsed.servers.has("chrome-devtools"), true);
		assert.equal(parsed.servers.has("github"), true);
		assert.equal(parsed.tools.get("github")?.has("search_code"), true);
	});

	test("resolves cached tools, resources, prefixes, exclusions, and builtins", () => {
		const config: McpConfig = {
			settings: { toolPrefix: "server" },
			mcpServers: {
				"chrome-devtools": {
					command: "chrome-mcp",
					directTools: true,
					excludeTools: ["chrome_devtools_close_page"],
				},
			},
		};
		const cache = cacheFor(
			config,
			"chrome-devtools",
			["click", "close_page", "read"],
			[{ name: "Page Snapshot", uri: "mcp://page" }],
		);

		assert.deepEqual(resolveMcpDirectToolNamesFromConfig(config, cache, "server", ["chrome-devtools"]), [
			"chrome_devtools_click",
			"chrome_devtools_read",
			"chrome_devtools_get_page_snapshot",
		]);
	});

	test("matches MCP resolver names for dashed and underscored tools (#10239)", () => {
		for (const tools of [
			["read-file", "read_file"],
			["read_file", "read-file"],
		]) {
			const config: McpConfig = { mcpServers: { "my-server": { command: "fixture", directTools: true } } };
			const cache = cacheFor(config, "my-server", tools);
			const subagentNames = resolveMcpDirectToolNamesFromConfig(config, cache, "server", ["my-server"]);
			const mcpCache = {
				version: 1,
				servers: {
					"my-server": {
						...cache.servers["my-server"]!,
						configHash: computeServerHash(config.mcpServers["my-server"]!),
					},
				},
			};
			const mcpNames = resolveDirectTools(config as never, mcpCache as never, "server").map(
				(spec) => spec.prefixedName,
			);
			assert.deepEqual(subagentNames, mcpNames);
			assert.equal(new Set(subagentNames).size, 2);
			for (const name of subagentNames) assert.match(name, /^my_server_read_file_[a-f0-9]{8}$/);
		}
	});

	test("ignores resources without a URI when matching MCP tool names (#10239)", () => {
		const config: McpConfig = { mcpServers: { "my-server-mcp": { command: "fixture", directTools: true } } };
		for (const resource of [{ name: "Page Snapshot", uri: "" }, { name: "Page Snapshot" }]) {
			const cache = cacheFor(
				config,
				"my-server-mcp",
				["get-page-snapshot", "get-schema"],
				[{ name: "Schema", uri: "mcp://schema" }],
			);
			cache.servers["my-server-mcp"]!.resources!.push(resource);
			const mcpCache = {
				version: 1,
				servers: {
					"my-server-mcp": {
						...cache.servers["my-server-mcp"]!,
						configHash: computeServerHash(config.mcpServers["my-server-mcp"]!),
					},
				},
			};
			for (const prefix of ["server", "short", "none"] as const) {
				for (const selections of [["my-server-mcp"], ["my-server-mcp/get-page-snapshot"]]) {
					const mcpNames = resolveDirectTools(config as never, mcpCache as never, prefix, selections).map(
						(spec) => spec.prefixedName,
					);
					const serverPrefix = prefix === "none" ? "" : prefix === "short" ? "my_server_" : "my_server_mcp_";
					assert.ok(mcpNames.includes(`${serverPrefix}get_page_snapshot`));
					assert.equal(mcpNames.length, selections[0]!.includes("/") ? 1 : 3);
					assert.deepEqual(resolveMcpDirectToolNamesFromConfig(config, cache, prefix, selections), mcpNames);
				}
			}
		}
	});

	test("supports short and none prefixes for selected tools", () => {
		const config: McpConfig = {
			mcpServers: {
				"github-mcp": { command: "github-mcp" },
			},
		};
		const cache = cacheFor(config, "github-mcp", ["search_code"]);

		assert.deepEqual(resolveMcpDirectToolNamesFromConfig(config, cache, "short", ["github-mcp/search_code"]), [
			"github_search_code",
		]);
		assert.deepEqual(resolveMcpDirectToolNamesFromConfig(config, cache, "none", ["github-mcp/search_code"]), [
			"search_code",
		]);
	});

	test("skips stale or hash-mismatched cache entries", () => {
		const config: McpConfig = { mcpServers: { github: { command: "old" } } };
		const staleCache: MetadataCache = {
			version: 1,
			servers: {
				github: {
					configHash: computeMcpServerHash(config.mcpServers.github!),
					cachedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
					tools: [{ name: "search_code" }],
				},
			},
		};
		const mismatchCache: MetadataCache = {
			version: 1,
			servers: {
				github: {
					configHash: computeMcpServerHash({ command: "new" }),
					cachedAt: Date.now(),
					tools: [{ name: "search_code" }],
				},
			},
		};

		assert.deepEqual(resolveMcpDirectToolNamesFromConfig(config, staleCache, "server", ["github"]), []);
		assert.deepEqual(resolveMcpDirectToolNamesFromConfig(config, mismatchCache, "server", ["github"]), []);
	});

	test("hashes bearer token presence without depending on token value", () => {
		const definition = { command: "secure", bearerTokenEnv: "SUBAGENT_TEST_MCP_TOKEN" };
		process.env.SUBAGENT_TEST_MCP_TOKEN = "token-one";
		const first = computeMcpServerHash(definition);
		process.env.SUBAGENT_TEST_MCP_TOKEN = "token-two";
		const second = computeMcpServerHash(definition);
		delete process.env.SUBAGENT_TEST_MCP_TOKEN;
		const absent = computeMcpServerHash(definition);

		assert.equal(first, second);
		assert.notEqual(first, absent);
	});

	test("type helper accepts explicit prefix values", () => {
		const prefix: ToolPrefix = "server";
		assert.equal(prefix, "server");
	});
});
