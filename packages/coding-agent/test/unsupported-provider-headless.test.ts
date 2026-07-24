import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { attachJsonlLineReader, serializeJsonLine } from "../src/modes/rpc/jsonl.ts";
import type { RpcCommand, RpcResponse } from "../src/modes/rpc/rpc-types.ts";
import { bunExecutable, cliPath, runCliProcess } from "./cli-test-helpers.ts";

const WARNING = "Configured default model is unavailable or unsupported. Update defaultProvider/defaultModel or use /model.";
const tempDirs: string[] = [];

type RpcCommandBody = RpcCommand extends infer T ? (T extends { id?: string } ? Omit<T, "id"> : never) : never;

interface RpcHarness {
  send(command: RpcCommandBody): Promise<RpcResponse>;
  stop(): Promise<void>;
  stderr(): string;
}

function writeIsolatedState(agentDir: string, baseUrl: string): void {
  const removedProvider = ["cur", "sor"].join("");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: removedProvider,
    defaultModel: ["composer", "-2"].join(""),
  }));
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
    [removedProvider]: { type: "api_key", key: "stale-proof" },
  }));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      recovery: {
        baseUrl,
        apiKey: "test-key",
        api: "openai-responses",
        models: [{
          id: "recovery-model",
          name: "Recovery model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 16_000,
          maxTokens: 1024,
        }],
      },
    },
  }));
}

function commonArgs(sessionFile?: string): string[] {
  return [
    ...(sessionFile ? ["--session", sessionFile] : ["--no-session"]),
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
  ];
}

function isolatedEnv(agentDir: string, sessionDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ATOMIC_CODING_AGENT_DIR: agentDir,
    ATOMIC_CODING_AGENT_SESSION_DIR: sessionDir,
    ATOMIC_OFFLINE: "1",
    ATOMIC_INTERACTIVE_ENGINE_CHILD: undefined,
    ATOMIC_INTERACTIVE_ENGINE_API_KEY: undefined,
    ATOMIC_INTERCOM_GROUP: undefined,
    PI_INTERCOM_GROUP: undefined,
    ATOMIC_SKIP_VERSION_CHECK: "1",
    NO_COLOR: "1",
  };
}

function startRpc(cwd: string, agentDir: string, sessionDir: string, sessionFile?: string): RpcHarness {
  const child = spawn(bunExecutable(), [cliPath, "--mode", "rpc", ...commonArgs(sessionFile)], {
    cwd,
    env: isolatedEnv(agentDir, sessionDir),
    stdio: "pipe",
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
  let stderr = "";
  let nextId = 0;
  const pending = new Map<string, { resolve(value: RpcResponse): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const detach = attachJsonlLineReader(child.stdout, (line) => {
    const parsed = JSON.parse(line) as RpcResponse;
    if (parsed.type !== "response" || !parsed.id) return;
    const request = pending.get(parsed.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(parsed.id);
    request.resolve(parsed);
  });
  child.once("exit", (code, signal) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`RPC exited code=${code} signal=${signal}: ${stderr}`));
    }
    pending.clear();
  });
  return {
    send(command) {
      const id = `unsupported_${++nextId}`;
      return new Promise<RpcResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for ${command.type}: ${stderr}`));
        }, 10_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(serializeJsonLine({ ...command, id } as RpcCommand));
      });
    },
    async stop() {
      detach();
      if (child.exitCode !== null || child.killed) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 1_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    },
    stderr: () => stderr,
  };
}

function responseSuccess(response: RpcResponse): boolean {
  return response.type === "response" && response.success;
}

function responseError(response: RpcResponse): string | undefined {
  return response.type === "response" && !response.success ? response.error : undefined;
}

describe("unsupported provider in headless modes", () => {
  let root: string;
  let cwd: string;
  let agentDir: string;
  let sessionDir: string;
  let persistedSessionFile: string;
  let server: Server | undefined;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "atomic-unsupported-headless-"));
    tempDirs.push(root);
    cwd = join(root, "cwd");
    agentDir = join(root, "agent");
    sessionDir = join(root, "sessions");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    server = createServer((_request, response) => {
      const event = { type: "response.completed", response: {
        id: "resp_recovered", status: "completed",
        usage: { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, total_tokens: 0 },
      } };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    writeIsolatedState(agentDir, `http://127.0.0.1:${address.port}/v1`);
    const removedProvider = ["cur", "sor"].join("");
    const persisted = SessionManager.create(cwd, sessionDir);
    persisted.appendModelChange(removedProvider, ["composer", "-2"].join(""));
    persisted.appendMessage({
      role: "user",
      content: [{ type: "text", text: "persisted stale model" }],
      timestamp: Date.now(),
    });
    persisted.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "persisted stale response" }],
      api: "anthropic-messages",
      provider: removedProvider,
      model: ["composer", "-2"].join(""),
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const createdFile = persisted.getSessionFile();
    if (!createdFile) throw new Error("persisted session fixture did not create a file");
    persistedSessionFile = createdFile;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  for (const mode of ["text", "json"] as const) {
    it(`${mode} print fails before prompting and keeps stdout clean`, async () => {
      const args = mode === "text"
        ? ["-p", "do not send", ...commonArgs()]
        : ["--mode", "json", "do not send", ...commonArgs()];
      const result = await runCliProcess(args, { cwd, env: isolatedEnv(agentDir, sessionDir) });
      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(WARNING);
      expect(result.stderr).not.toContain("API key");
      expect(result.stdout).toBe("");
      for (const line of result.stdout.split("\n").filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();
    });
  }

  for (const mode of ["text", "json"] as const) {
    it(`${mode} print classifies a persisted stale model plus unsupported default before prompting`, async () => {
      const args = mode === "text"
        ? ["-p", "do not send", ...commonArgs(persistedSessionFile)]
        : ["--mode", "json", "do not send", ...commonArgs(persistedSessionFile)];
      const result = await runCliProcess(args, { cwd, env: isolatedEnv(agentDir, sessionDir) });
      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(WARNING);
      expect(result.stderr).not.toContain("API key");
      expect(result.stdout).toBe("");
    });
  }

  it("RPC keeps persisted stale state recoverable through explicit set_model", async () => {
    const rpc = startRpc(cwd, agentDir, sessionDir, persistedSessionFile);
    try {
      const blocked = await rpc.send({ type: "prompt", message: "blocked persisted prompt" });
      expect(responseError(blocked)).toBe(WARNING);
      expect(responseError(blocked)).not.toContain("API key");
      expect(responseSuccess(await rpc.send({ type: "get_available_models" }))).toBe(true);
      expect(responseSuccess(await rpc.send({ type: "set_model", provider: "recovery", modelId: "recovery-model" }))).toBe(true);
      expect(responseSuccess(await rpc.send({ type: "prompt", message: "recovered" }))).toBe(true);
      expect(rpc.stderr()).not.toContain("API key");
    } finally {
      await rpc.stop();
    }
  });
  it("RPC remains live and accepts set_model recovery before prompting", async () => {
    const rpc = startRpc(cwd, agentDir, sessionDir);
    try {
      const blocked = await rpc.send({ type: "prompt", message: "blocked" });
      expect(responseError(blocked)).toBe(WARNING);
      expect(responseError(blocked)).not.toContain("API key");
      const catalog = await rpc.send({ type: "get_available_models" });
      expect(responseSuccess(catalog)).toBe(true);
      const recovered = await rpc.send({ type: "set_model", provider: "recovery", modelId: "recovery-model" });
      expect(responseSuccess(recovered)).toBe(true);
      const prompt = await rpc.send({ type: "prompt", message: "recovered" });
      expect(responseSuccess(prompt)).toBe(true);
      expect(rpc.stderr()).not.toContain("API key");
    } finally {
      await rpc.stop();
    }
  });
});
