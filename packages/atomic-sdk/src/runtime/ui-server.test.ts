/**
 * Tests for UIServer — TCP loopback JSON-RPC server.
 *
 * Two test layers:
 *   1. In-memory (Duplex stream pairs, no real sockets) — unit tests.
 *   2. Loopback integration — real `net.createServer` / `net.connect`.
 *
 * §8.2.1, §8.2.2 of specs/2026-05-09-ui-server-bun-native.md
 */

import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import { Duplex } from "node:stream";
import * as net from "node:net";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import { UIServer, type UIServerOptions } from "./ui-server.ts";
import type { IRunManager, ISupervisor } from "./ui-protocol/methods.ts";
import type { WorkflowRegistry } from "./registry.ts";
import { AtomicErrorCode } from "./ui-protocol/errors.ts";

// ---------------------------------------------------------------------------
// Helpers: in-memory connected MessageConnection pair
// ---------------------------------------------------------------------------

/**
 * Create a bidirectional in-memory pipe between two `MessageConnection`s.
 * Whatever [client] writes arrives at [server] and vice-versa.
 *
 * Uses the Duplex pair pattern from §8.2.1 of the spec.
 */
function makePair(): [MessageConnection, MessageConnection] {
  const a = new Duplex({ read() {}, write(chunk, _enc, cb) { b.push(chunk); cb(); } });
  const b = new Duplex({ read() {}, write(chunk, _enc, cb) { a.push(chunk); cb(); } });
  return [
    createMessageConnection(new StreamMessageReader(a), new StreamMessageWriter(a)),
    createMessageConnection(new StreamMessageReader(b), new StreamMessageWriter(b)),
  ];
}

// ---------------------------------------------------------------------------
// Helpers: stub dependencies
// ---------------------------------------------------------------------------

function makeRunManager(overrides: Partial<IRunManager> = {}): IRunManager {
  return {
    start: mock(() => Promise.resolve({ runId: "run-1" })),
    stop: mock(() => Promise.resolve()),
    list: mock(() => []),
    get: mock(() => null),
    getState: mock(() => null),
    getTranscript: mock(() => Promise.resolve([])),
    subscribe: mock(() => "sub-1"),
    unsubscribe: mock(() => {}),
    ...overrides,
  };
}

function makeSupervisor(overrides: Partial<ISupervisor> = {}): ISupervisor {
  return {
    sendInput: mock(() => {}),
    getScrollback: mock(() => ({ data: "", headOffset: 0 })),
    spawn: mock(() => Promise.resolve({ pid: 1234 })),
    kill: mock(() => {}),
    ...overrides,
  };
}

function makeWorkflowRegistry(): WorkflowRegistry {
  return {
    list: mock(() => []),
    refresh: mock(() => Promise.resolve({ count: 0, broken: [] })),
    get: mock(() => null),
    getDescriptor: mock(() => null),
  } as unknown as WorkflowRegistry;
}

function makeServerOpts(overrides: Partial<UIServerOptions> = {}): UIServerOptions {
  return {
    workflows: makeWorkflowRegistry(),
    runs: makeRunManager(),
    supervisor: makeSupervisor(),
    atomicVersion: "2.0.0",
    sdkVersion: "0.7.13",
    token: "test-secret",
    onWarn: () => {},
    onLog: () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: send connect request on a real MessageConnection
// ---------------------------------------------------------------------------

async function connectClient(
  client: MessageConnection,
  token: string,
  clientName = "test-client",
): Promise<{ ok: boolean }> {
  return client.sendRequest("connect", { token, clientName }) as Promise<{ ok: boolean }>;
}

// ---------------------------------------------------------------------------
// §8.2.1 — Unit tests using in-memory Duplex stream pairs
// ---------------------------------------------------------------------------

describe("UIServer — in-memory unit tests", () => {
  /**
   * Wire a real MethodDispatcher (via UIServer's internal dispatcher) to a
   * manually-created [serverConn, clientConn] pair. This exercises dispatch +
   * error mapping without any real TCP socket.
   */
  function makeInMemoryServer(optsOverride: Partial<UIServerOptions> = {}): {
    server: UIServer;
    clientConn: MessageConnection;
    serverConn: MessageConnection;
  } {
    const opts = makeServerOpts(optsOverride);
    const server = new UIServer(opts);

    // Grab the internal dispatcher via a trick: expose via a protected accessor.
    // Since TypeScript doesn't expose privates, we access it via `as any`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dispatcher = (server as unknown as { dispatcher: { dispatch: (...a: unknown[]) => Promise<unknown> } }).dispatcher;

    const [serverConn, clientConn] = makePair();

    // Replicate the server's per-connection setup on serverConn.
    serverConn.onRequest((method, params) => {
      return dispatcher.dispatch(method, params, serverConn).catch((err: unknown) => {
        // Re-throw as ResponseError so vscode-jsonrpc sends a proper error response.
        const { AtomicRpcError } = require("./ui-protocol/errors.ts") as typeof import("./ui-protocol/errors.ts");
        if (err instanceof AtomicRpcError) throw err.toResponseError();
        throw err;
      });
    });
    serverConn.listen();
    clientConn.listen();

    return { server, clientConn, serverConn };
  }

  test("protocol/getVersion returns correct versions without auth", async () => {
    const { clientConn, serverConn } = makeInMemoryServer();
    try {
      const result = await clientConn.sendRequest("protocol/getVersion", {}) as {
        protocolVersion: string;
        sdkVersion: string;
        atomicVersion: string;
      };
      expect(result.atomicVersion).toBe("2.0.0");
      expect(result.sdkVersion).toBe("0.7.13");
      expect(typeof result.protocolVersion).toBe("string");
    } finally {
      serverConn.dispose();
      clientConn.dispose();
    }
  });

  test("connect with correct token succeeds", async () => {
    const { clientConn, serverConn } = makeInMemoryServer({ token: "secret" });
    try {
      const result = await clientConn.sendRequest("connect", { token: "secret", clientName: "tester" });
      expect(result).toEqual({ ok: true });
    } finally {
      serverConn.dispose();
      clientConn.dispose();
    }
  });

  test("connect with wrong token returns AUTHENTICATION_REQUIRED error", async () => {
    const { clientConn, serverConn } = makeInMemoryServer({ token: "secret" });
    try {
      await expect(
        clientConn.sendRequest("connect", { token: "wrong", clientName: "tester" }),
      ).rejects.toMatchObject({ code: AtomicErrorCode.AUTHENTICATION_REQUIRED });
    } finally {
      serverConn.dispose();
      clientConn.dispose();
    }
  });

  test("unauthenticated request (non-exempt method) returns AUTHENTICATION_REQUIRED", async () => {
    const { clientConn, serverConn } = makeInMemoryServer({ token: "secret" });
    try {
      await expect(
        clientConn.sendRequest("workflow/list", {}),
      ).rejects.toMatchObject({ code: AtomicErrorCode.AUTHENTICATION_REQUIRED });
    } finally {
      serverConn.dispose();
      clientConn.dispose();
    }
  });

  test("after connect, workflow/list succeeds", async () => {
    const { clientConn, serverConn } = makeInMemoryServer({ token: "secret" });
    try {
      await clientConn.sendRequest("connect", { token: "secret", clientName: "tester" });
      const result = await clientConn.sendRequest("workflow/list", {});
      expect(Array.isArray(result)).toBe(true);
    } finally {
      serverConn.dispose();
      clientConn.dispose();
    }
  });

  test("no-token mode: any token accepted (onWarn called)", async () => {
    const warns: string[] = [];
    const { clientConn, serverConn } = makeInMemoryServer({
      token: undefined,
      onWarn: (m) => warns.push(m),
    });
    try {
      const result = await clientConn.sendRequest("connect", {
        token: "anything",
        clientName: "tester",
      });
      expect(result).toEqual({ ok: true });
      // Warning should have been emitted during construction
      expect(warns.length).toBeGreaterThan(0);
      expect(warns[0]).toContain("ATOMIC_UI_SERVER_TOKEN");
    } finally {
      serverConn.dispose();
      clientConn.dispose();
    }
  });

  test("no-token mode: no token field also accepted", async () => {
    const { clientConn, serverConn } = makeInMemoryServer({ token: undefined, onWarn: () => {} });
    try {
      const result = await clientConn.sendRequest("connect", { clientName: "tester" });
      expect(result).toEqual({ ok: true });
    } finally {
      serverConn.dispose();
      clientConn.dispose();
    }
  });

  test("unknown method returns -32601 after auth", async () => {
    const { clientConn, serverConn } = makeInMemoryServer({ token: "secret" });
    try {
      await clientConn.sendRequest("connect", { token: "secret", clientName: "tester" });
      await expect(
        clientConn.sendRequest("doesNotExist", {}),
      ).rejects.toMatchObject({ code: -32601 });
    } finally {
      serverConn.dispose();
      clientConn.dispose();
    }
  });

  test("invalid params return -32602", async () => {
    const { clientConn, serverConn } = makeInMemoryServer({ token: "secret" });
    try {
      await clientConn.sendRequest("connect", { token: "secret", clientName: "tester" });
      // workflow/start requires source, workflowName, agent, inputs
      await expect(
        clientConn.sendRequest("workflow/start", { bad: "param" }),
      ).rejects.toMatchObject({ code: -32602 });
    } finally {
      serverConn.dispose();
      clientConn.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// §8.2.2 — Integration tests over a real loopback TCP socket
// ---------------------------------------------------------------------------

describe("UIServer — TCP loopback integration tests", () => {
  let server: UIServer;

  function freshServer(optsOverride: Partial<UIServerOptions> = {}): UIServer {
    return new UIServer(makeServerOpts(optsOverride));
  }

  /** Connect a real TCP client and return a `MessageConnection`. */
  function tcpClient(port: number): Promise<{ conn: MessageConnection; socket: net.Socket }> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        const conn = createMessageConnection(
          new StreamMessageReader(socket),
          new StreamMessageWriter(socket),
        );
        conn.listen();
        resolve({ conn, socket });
      });
      socket.once("error", reject);
    });
  }

  afterEach(async () => {
    if (server) {
      await server.stop().catch(() => {});
    }
  });

  test("server starts and returns a valid address", async () => {
    server = freshServer();
    await server.start();
    const addr = server.address();
    expect(addr).not.toBeNull();
    expect(addr!.address).toBe("127.0.0.1");
    expect(addr!.port).toBeGreaterThan(0);
  });

  test("client can connect and call protocol/getVersion without auth", async () => {
    server = freshServer();
    await server.start();
    const { conn, socket } = await tcpClient(server.address()!.port);
    try {
      const result = await conn.sendRequest("protocol/getVersion", {}) as {
        atomicVersion: string;
        sdkVersion: string;
        protocolVersion: string;
      };
      expect(result.atomicVersion).toBe("2.0.0");
    } finally {
      conn.dispose();
      socket.destroy();
    }
  });

  test("connect with valid token succeeds", async () => {
    server = freshServer({ token: "mytoken" });
    await server.start();
    const { conn, socket } = await tcpClient(server.address()!.port);
    try {
      const result = await connectClient(conn, "mytoken");
      expect(result).toEqual({ ok: true });
    } finally {
      conn.dispose();
      socket.destroy();
    }
  });

  test("connect with invalid token is rejected with AUTHENTICATION_REQUIRED", async () => {
    server = freshServer({ token: "correct" });
    await server.start();
    const { conn, socket } = await tcpClient(server.address()!.port);
    try {
      await expect(connectClient(conn, "wrong")).rejects.toMatchObject({
        code: AtomicErrorCode.AUTHENTICATION_REQUIRED,
      });
    } finally {
      conn.dispose();
      socket.destroy();
    }
  });

  test("unauthenticated workflow/list is rejected", async () => {
    server = freshServer({ token: "secret" });
    await server.start();
    const { conn, socket } = await tcpClient(server.address()!.port);
    try {
      await expect(
        conn.sendRequest("workflow/list", {}),
      ).rejects.toMatchObject({ code: AtomicErrorCode.AUTHENTICATION_REQUIRED });
    } finally {
      conn.dispose();
      socket.destroy();
    }
  });

  test("authenticated workflow/list returns array", async () => {
    server = freshServer({ token: "t" });
    await server.start();
    const { conn, socket } = await tcpClient(server.address()!.port);
    try {
      await connectClient(conn, "t");
      const result = await conn.sendRequest("workflow/list", {});
      expect(Array.isArray(result)).toBe(true);
    } finally {
      conn.dispose();
      socket.destroy();
    }
  });

  test("server/closing notification received by all clients on stop()", async () => {
    server = freshServer({ token: "t" });
    await server.start();
    const port = server.address()!.port;

    const c1 = await tcpClient(port);
    const c2 = await tcpClient(port);

    // Authenticate both
    await Promise.all([connectClient(c1.conn, "t"), connectClient(c2.conn, "t")]);

    const notifications1: unknown[] = [];
    const notifications2: unknown[] = [];

    c1.conn.onNotification((method, params) => {
      notifications1.push({ method, params });
    });
    c2.conn.onNotification((method, params) => {
      notifications2.push({ method, params });
    });

    // Stop — should broadcast server/closing to both clients
    await server.stop("shutdown");

    // Give event loop a tick to process incoming notifications
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(notifications1.some((n) => (n as { method: string }).method === "server/closing")).toBe(true);
    expect(notifications2.some((n) => (n as { method: string }).method === "server/closing")).toBe(true);

    c1.conn.dispose();
    c2.conn.dispose();
    c1.socket.destroy();
    c2.socket.destroy();
  });

  test("multi-client: two clients both get workflow/list responses", async () => {
    server = freshServer({ token: "t" });
    await server.start();
    const port = server.address()!.port;

    const c1 = await tcpClient(port);
    const c2 = await tcpClient(port);

    try {
      await Promise.all([connectClient(c1.conn, "t"), connectClient(c2.conn, "t")]);
      const [r1, r2] = await Promise.all([
        c1.conn.sendRequest("workflow/list", {}),
        c2.conn.sendRequest("workflow/list", {}),
      ]);
      expect(Array.isArray(r1)).toBe(true);
      expect(Array.isArray(r2)).toBe(true);
    } finally {
      c1.conn.dispose();
      c2.conn.dispose();
      c1.socket.destroy();
      c2.socket.destroy();
    }
  });

  test("empty ATOMIC_UI_SERVER_TOKEN: server accepts any token, emits warning", async () => {
    const warns: string[] = [];
    server = new UIServer(
      makeServerOpts({ token: undefined, onWarn: (m) => warns.push(m) }),
    );
    await server.start();

    const { conn, socket } = await tcpClient(server.address()!.port);
    try {
      const result = await connectClient(conn, "random-token");
      expect(result).toEqual({ ok: true });
      expect(warns.some((w) => w.includes("ATOMIC_UI_SERVER_TOKEN"))).toBe(true);
    } finally {
      conn.dispose();
      socket.destroy();
    }
  });

  test("stop() is idempotent (second call is no-op)", async () => {
    server = freshServer();
    await server.start();
    await server.stop();
    await expect(server.stop()).resolves.toBeUndefined();
  });

  test("address() returns null before start()", () => {
    server = freshServer();
    expect(server.address()).toBeNull();
  });

  test("run/list returns empty array after auth", async () => {
    server = freshServer({ token: "t" });
    await server.start();
    const { conn, socket } = await tcpClient(server.address()!.port);
    try {
      await connectClient(conn, "t");
      const result = await conn.sendRequest("run/list", { scope: "all" });
      expect(Array.isArray(result)).toBe(true);
    } finally {
      conn.dispose();
      socket.destroy();
    }
  });
});
