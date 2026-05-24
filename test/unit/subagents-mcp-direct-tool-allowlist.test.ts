import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  computeMcpServerHash,
  parseMcpDirectToolSelections,
  resolveMcpDirectToolNamesFromConfig,
  type McpConfig,
  type MetadataCache,
  type ToolPrefix,
} from "../../packages/subagents/src/runs/shared/mcp-direct-tool-allowlist.js";

const originalToken = process.env.SUBAGENT_TEST_MCP_TOKEN;

afterEach(() => {
  if (originalToken === undefined) delete process.env.SUBAGENT_TEST_MCP_TOKEN;
  else process.env.SUBAGENT_TEST_MCP_TOKEN = originalToken;
});

function cacheFor(config: McpConfig, serverName: string, tools: string[], resources: Array<{ name: string; uri: string }> = []): MetadataCache {
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
    const cache = cacheFor(config, "chrome-devtools", ["click", "close_page", "read"], [
      { name: "Page Snapshot", uri: "mcp://page" },
    ]);

    assert.deepEqual(
      resolveMcpDirectToolNamesFromConfig(config, cache, "server", ["chrome-devtools"]),
      ["chrome_devtools_click", "chrome_devtools_read", "chrome_devtools_get_page_snapshot"],
    );
  });

  test("supports short and none prefixes for selected tools", () => {
    const config: McpConfig = {
      mcpServers: {
        "github-mcp": { command: "github-mcp" },
      },
    };
    const cache = cacheFor(config, "github-mcp", ["search_code"]);

    assert.deepEqual(resolveMcpDirectToolNamesFromConfig(config, cache, "short", ["github-mcp/search_code"]), ["github_search_code"]);
    assert.deepEqual(resolveMcpDirectToolNamesFromConfig(config, cache, "none", ["github-mcp/search_code"]), ["search_code"]);
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
