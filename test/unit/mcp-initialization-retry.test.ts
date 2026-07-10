import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import mcpAdapter from "../../packages/mcp/index.js";

interface RegisteredTool {
  readonly name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<Record<string, unknown>>>;
}

type SessionHandler = (event: Record<string, never>, ctx: ExtensionContext) => Promise<void> | void;

const originalArgv = [...process.argv];
const originalAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const originalDirectTools = process.env.MCP_DIRECT_TOOLS;
let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "atomic-mcp-init-retry-"));
  process.env.ATOMIC_CODING_AGENT_DIR = join(tempDir, "agent");
  process.env.MCP_DIRECT_TOOLS = "__none__";
});

afterEach(() => {
  process.argv = [...originalArgv];
  if (originalAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
  else process.env.ATOMIC_CODING_AGENT_DIR = originalAgentDir;
  if (originalDirectTools === undefined) delete process.env.MCP_DIRECT_TOOLS;
  else process.env.MCP_DIRECT_TOOLS = originalDirectTools;
  rmSync(tempDir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for MCP initialization state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("failed background MCP initialization retries once for concurrent same-generation callers", async () => {
  const configPath = join(tempDir, "mcp.json");
  writeFileSync(configPath, JSON.stringify({ mcpServers: {} }), "utf8");
  process.argv = [...originalArgv, "--mcp-config", configPath];

  const tools: RegisteredTool[] = [];
  const handlers = new Map<string, SessionHandler>();
  const errors: string[] = [];
  let getFlagCalls = 0;
  const originalConsoleError = console.error;
  console.error = (...parts: Parameters<typeof console.error>) => {
    errors.push(parts.map(String).join(" "));
  };

  const api = {
    registerFlag() {},
    registerCommand() {},
    registerTool(tool: RegisteredTool) { tools.push(tool); },
    getAllTools() { return []; },
    getFlag(name: string) {
      getFlagCalls += 1;
      if (getFlagCalls === 1) throw new Error("simulated default initializer rejection");
      return name === "mcp-config" ? configPath : undefined;
    },
    refreshTools() {},
    on(event: string, handler: SessionHandler) { handlers.set(event, handler); },
  } as unknown as ExtensionAPI;
  const ctx = { cwd: tempDir, hasUI: false } as ExtensionContext;

  try {
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, ctx);
    await waitFor(() => errors.some((line) => line.includes("MCP initialization failed")));
    assert.equal(getFlagCalls, 1);

    const proxy = tools.find((tool) => tool.name === "mcp");
    assert.ok(proxy, "fallback MCP proxy should be registered");

    const signal = new AbortController().signal;
    const [first, second] = await Promise.all([
      proxy.execute("first", {}, signal, undefined, ctx),
      proxy.execute("second", {}, signal, undefined, ctx),
    ]);

    assert.equal(getFlagCalls, 2, "concurrent callers should share one replacement attempt");
    assert.equal(first.details.mode, "status");
    assert.equal(second.details.mode, "status");
    assert.ok(
      errors.some((line) => line.includes("later MCP call will retry")),
      `background failure should explain retry behavior: ${JSON.stringify(errors)}`,
    );
  } finally {
    console.error = originalConsoleError;
  }
});

test("UI publication failure rolls back the MCP candidate and retries on the next call", async () => {
  const configPath = join(tempDir, "mcp.json");
  writeFileSync(configPath, JSON.stringify({ mcpServers: {} }), "utf8");
  process.argv = [...originalArgv, "--mcp-config", configPath];
  const tools: RegisteredTool[] = [];
  const handlers = new Map<string, SessionHandler>();
  const errors: string[] = [];
  let getFlagCalls = 0;
  let statusCalls = 0;
  const originalConsoleError = console.error;
  console.error = (...parts: Parameters<typeof console.error>) => { errors.push(parts.map(String).join(" ")); };
  const api = {
    registerFlag() {}, registerCommand() {}, getAllTools() { return []; }, refreshTools() {},
    registerTool(tool: RegisteredTool) { tools.push(tool); },
    getFlag(name: string) { getFlagCalls += 1; return name === "mcp-config" ? configPath : undefined; },
    on(event: string, handler: SessionHandler) { handlers.set(event, handler); },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: tempDir, hasUI: true,
    ui: { notify() {}, setStatus() { statusCalls += 1; if (statusCalls === 1) throw new Error("status UI failed once"); } },
  } as unknown as ExtensionContext;
  try {
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, ctx);
    await waitFor(() => errors.some((line) => line.includes("status UI failed once")));
    const proxy = tools.find((tool) => tool.name === "mcp");
    assert.ok(proxy);
    const result = await proxy.execute("retry", {}, new AbortController().signal, undefined, ctx);
    assert.equal(result.details.mode, "status");
    assert.equal(getFlagCalls, 2);
    assert.equal(statusCalls, 2);
  } finally {
    console.error = originalConsoleError;
  }
});

test("pre-aborted proxy calls do not wait for or execute MCP initialization", async () => {
  const configPath = join(tempDir, "mcp.json");
  writeFileSync(configPath, JSON.stringify({ mcpServers: {} }), "utf8");
  process.argv = [...originalArgv, "--mcp-config", configPath];
  const tools: RegisteredTool[] = [];
  const handlers = new Map<string, SessionHandler>();
  let getFlagCalls = 0;
  const api = {
    registerFlag() {},
    registerCommand() {},
    registerTool(tool: RegisteredTool) { tools.push(tool); },
    getAllTools() { return []; },
    getFlag(name: string) {
      getFlagCalls += 1;
      return name === "mcp-config" ? configPath : undefined;
    },
    refreshTools() {},
    on(event: string, handler: SessionHandler) { handlers.set(event, handler); },
  } as unknown as ExtensionAPI;
  const ctx = { cwd: tempDir, hasUI: false } as ExtensionContext;
  mcpAdapter(api);
  await handlers.get("session_start")?.({}, ctx);
  const proxy = tools.find((tool) => tool.name === "mcp");
  assert.ok(proxy);
  const controller = new AbortController();
  const reason = new Error("proxy cancelled before readiness");
  controller.abort(reason);

  await assert.rejects(
    proxy.execute("pre-abort", {}, controller.signal, undefined, ctx),
    (error) => error === reason,
  );
  assert.ok(getFlagCalls <= 1, "aborted caller must not create an additional initializer");
});

test("aborting one proxy caller during cold readiness does not cancel the shared initializer", async () => {
  const configPath = join(tempDir, "mcp.json");
  writeFileSync(configPath, JSON.stringify({ mcpServers: {} }), "utf8");
  process.argv = [...originalArgv, "--mcp-config", configPath];
  const tools: RegisteredTool[] = [];
  const handlers = new Map<string, SessionHandler>();
  let getFlagCalls = 0;
  const api = {
    registerFlag() {},
    registerCommand() {},
    registerTool(tool: RegisteredTool) { tools.push(tool); },
    getAllTools() { return []; },
    getFlag(name: string) {
      getFlagCalls += 1;
      return name === "mcp-config" ? configPath : undefined;
    },
    refreshTools() {},
    on(event: string, handler: SessionHandler) { handlers.set(event, handler); },
  } as unknown as ExtensionAPI;
  const ctx = { cwd: tempDir, hasUI: false } as ExtensionContext;
  mcpAdapter(api);
  await handlers.get("session_start")?.({}, ctx);
  const proxy = tools.find((tool) => tool.name === "mcp");
  assert.ok(proxy);
  const controller = new AbortController();
  const reason = new Error("one proxy caller cancelled during readiness");

  const cancelled = proxy.execute("cancelled", {}, controller.signal, undefined, ctx);
  const survivor = proxy.execute("survivor", {}, new AbortController().signal, undefined, ctx);
  controller.abort(reason);

  await assert.rejects(cancelled, (error) => error === reason);
  const result = await survivor;
  assert.equal(result.details.mode, "status");
  assert.equal(getFlagCalls, 1, "both callers should join the same cold initialization");
});

test("shutdown during a same-generation retry prevents stale state publication and later revival", async () => {
  const configPath = join(tempDir, "mcp.json");
  writeFileSync(configPath, JSON.stringify({ mcpServers: {} }), "utf8");
  process.argv = [...originalArgv, "--mcp-config", configPath];
  const tools: RegisteredTool[] = [];
  const handlers = new Map<string, SessionHandler>();
  const errors: string[] = [];
  let getFlagCalls = 0;
  const originalConsoleError = console.error;
  console.error = (...parts: Parameters<typeof console.error>) => {
    errors.push(parts.map(String).join(" "));
  };
  const api = {
    registerFlag() {},
    registerCommand() {},
    registerTool(tool: RegisteredTool) { tools.push(tool); },
    getAllTools() { return []; },
    getFlag(name: string) {
      getFlagCalls += 1;
      if (getFlagCalls === 1) throw new Error("fail startup before shutdown retry");
      return name === "mcp-config" ? configPath : undefined;
    },
    refreshTools() {},
    on(event: string, handler: SessionHandler) { handlers.set(event, handler); },
  } as unknown as ExtensionAPI;
  const ctx = { cwd: tempDir, hasUI: false } as ExtensionContext;

  try {
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, ctx);
    await waitFor(() => errors.some((line) => line.includes("MCP initialization failed")));
    const proxy = tools.find((tool) => tool.name === "mcp");
    assert.ok(proxy);

    const retry = proxy.execute("retry", {}, new AbortController().signal, undefined, ctx);
    await handlers.get("session_shutdown")?.({}, ctx);
    const staleResult = await retry;
    const afterShutdown = await proxy.execute("after", {}, new AbortController().signal, undefined, ctx);

    assert.equal(staleResult.details.error, "init_failed");
    assert.equal(afterShutdown.details.error, "init_failed");
    assert.equal(getFlagCalls, 1, "shutdown must invalidate retry before it reaches initialization");
  } finally {
    console.error = originalConsoleError;
  }
});
