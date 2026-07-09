import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeMcp } from "../../packages/mcp/init.ts";
import { McpServerManager } from "../../packages/mcp/server-manager.ts";
import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";

const originalEnv = process.env.ATOMIC_CODING_AGENT_DIR;
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
  originalConnect = McpServerManager.prototype.connect;
});

afterEach(() => {
  McpServerManager.prototype.connect = originalConnect;
  if (originalEnv === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
  else process.env.ATOMIC_CODING_AGENT_DIR = originalEnv;
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
});
