import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mcpAdapter from "../../packages/mcp/index.ts";
import { initializeMcp } from "../../packages/mcp/init.ts";
import { computeServerHash, saveMetadataCache } from "../../packages/mcp/metadata-cache.ts";
import { McpServerManager } from "../../packages/mcp/server-manager.ts";
import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import type { McpConfig } from "../../packages/mcp/types.ts";

const originalEnv = process.env.ATOMIC_CODING_AGENT_DIR;
const originalDirectTools = process.env.MCP_DIRECT_TOOLS;
let tmpRoot = "";
let originalConnect: McpServerManager["connect"];

function context(): ExtensionContext {
  return {
    cwd: tmpRoot,
    hasUI: false,
    signal: new AbortController().signal,
  } as ExtensionContext;
}

function pi(configPath: string): ExtensionAPI {
  return {
    getFlag(name: string) {
      return name === "mcp-config" ? configPath : undefined;
    },
    sendMessage() {},
  } as unknown as ExtensionAPI;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "atomic-mcp-lazy-startup-"));
  process.env.ATOMIC_CODING_AGENT_DIR = join(tmpRoot, "agent");
  delete process.env.MCP_DIRECT_TOOLS;
  originalConnect = McpServerManager.prototype.connect;
});

afterEach(() => {
  McpServerManager.prototype.connect = originalConnect;
  if (originalEnv === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
  else process.env.ATOMIC_CODING_AGENT_DIR = originalEnv;
  if (originalDirectTools === undefined) delete process.env.MCP_DIRECT_TOOLS;
  else process.env.MCP_DIRECT_TOOLS = originalDirectTools;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("MCP lazy startup", () => {
  test("first-run metadata cache creation does not connect default lazy servers during initializeMcp", async () => {
    const configPath = join(tmpRoot, "mcp.json");
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        lazy: { command: "bun", args: ["--version"] },
      },
    }), "utf8");
    let connectCalls = 0;
    McpServerManager.prototype.connect = async function connect() {
      connectCalls += 1;
      throw new Error("startup should not connect lazy server");
    };

    await initializeMcp(pi(configPath), context());

    assert.equal(connectCalls, 0);
  });

  test("explicit eager lifecycle servers still connect during initializeMcp", async () => {
    const configPath = join(tmpRoot, "mcp.json");
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        eager: { command: "bun", args: ["--version"], lifecycle: "eager" },
      },
    }), "utf8");
    const connected: string[] = [];
    McpServerManager.prototype.connect = async function connect(name, definition) {
      connected.push(name);
      return {
        client: {},
        transport: {},
        definition,
        tools: [],
        resources: [],
        lastUsedAt: Date.now(),
        inFlight: 0,
        status: "connected",
      } as unknown as Awaited<ReturnType<McpServerManager["connect"]>>;
    };

    await initializeMcp(pi(configPath), context());

    assert.deepEqual(connected, ["eager"]);
  });

  test("env-selected direct tool cache misses keep the proxy fallback registered", async () => {
    process.env.MCP_DIRECT_TOOLS = "cached/search_code,missing/search_code";
    const config: McpConfig = {
      settings: { disableProxyTool: true },
      mcpServers: {
        cached: { command: "bun", args: ["--version"] },
        missing: { command: "bun", args: ["--version"] },
      },
    };
    writeFileSync(join(tmpRoot, ".mcp.json"), JSON.stringify(config), "utf8");
    saveMetadataCache({
      version: 1,
      servers: {
        cached: {
          configHash: computeServerHash(config.mcpServers.cached!),
          cachedAt: Date.now(),
          tools: [{ name: "search_code", description: "search", inputSchema: { type: "object", properties: {} } }],
          resources: [],
        },
      },
    });
    const handlers = new Map<string, (event: Record<string, never>, ctx: ExtensionContext) => Promise<void>>();
    const registeredTools: string[] = [];
    const api = {
      getFlag() { return undefined; },
      registerFlag() {},
      on(event: string, handler: (event: Record<string, never>, ctx: ExtensionContext) => Promise<void>) {
        handlers.set(event, handler);
      },
      registerCommand() {},
      registerTool(tool: { name: string }) {
        registeredTools.push(tool.name);
      },
      getAllTools() { return []; },
      refreshTools() {},
    } as unknown as ExtensionAPI;

    mcpAdapter(api);
    await handlers.get("session_start")?.({}, context());

    assert.equal(registeredTools.includes("cached_search_code"), true);
    assert.equal(registeredTools.includes("mcp"), true);
  });
});
