/**
 * TCP loopback JSON-RPC server for the atomic daemon UI surface.
 *
 * - Binds to 127.0.0.1 (loopback-only; no --host override in v1).
 * - One `MessageConnection` per TCP socket via vscode-jsonrpc SocketMessageReader/Writer.
 * - Auth gate: only `protocol/getVersion` and `connect` succeed before authentication.
 * - On shutdown: broadcasts `server/closing`, drains 100ms, disposes connections,
 *   closes `net.Server`.
 * - Exposes `start()`, `stop()`, `address()` for the daemon worker.
 *
 * Does NOT own daemon singleton enforcement or endpoint file I/O (§5.2).
 *
 * §5.1.5, §7.1 of specs/2026-05-09-ui-server-bun-native.md
 */

import * as net from "node:net";
import {
  createMessageConnection,
  SocketMessageReader,
  SocketMessageWriter,
} from "vscode-jsonrpc/node";
import type { MessageConnection } from "vscode-jsonrpc";
import { MethodDispatcher, type MethodDispatcherOptions } from "./ui-protocol/methods.ts";
import { AtomicRpcError } from "./ui-protocol/errors.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** JSON-RPC notification sent to every client before the server shuts down. */
const SERVER_CLOSING_METHOD = "server/closing";

/** Time (ms) to wait after sending `server/closing` before disposing connections. */
const CLOSE_DRAIN_MS = 100;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface UIServerOptions extends MethodDispatcherOptions {
  /**
   * Callback for warnings (e.g., no token configured).
   * Defaults to `console.warn`.
   */
  onWarn?: (msg: string) => void;

  /**
   * Callback for informational log messages.
   * Defaults to a no-op.
   */
  onLog?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Internal connection entry
// ---------------------------------------------------------------------------

interface ConnectionEntry {
  conn: MessageConnection;
  socket: net.Socket;
}

// ---------------------------------------------------------------------------
// UIServer
// ---------------------------------------------------------------------------

/**
 * TCP loopback JSON-RPC server.
 *
 * ```ts
 * const server = new UIServer({ workflows, runs, supervisor, atomicVersion, sdkVersion, token });
 * await server.start();          // binds to 127.0.0.1:0 (kernel-assigned port)
 * const { port } = server.address()!;
 * // ... daemon writes endpoint file, clients connect ...
 * await server.stop();           // graceful shutdown
 * ```
 */
export class UIServer {
  private readonly opts: UIServerOptions;
  private readonly dispatcher: MethodDispatcher;
  private readonly netServer: net.Server;
  private readonly connections = new Set<ConnectionEntry>();
  private running = false;

  constructor(opts: UIServerOptions) {
    this.opts = opts;
    this.dispatcher = new MethodDispatcher(opts);
    this.netServer = net.createServer({ allowHalfOpen: false });
    this.netServer.on("connection", (socket) => this.handleConnection(socket));

    // §7.1: Warn when running without token — loopback-only permissive mode.
    if (!opts.token) {
      const warn = opts.onWarn ?? console.warn;
      warn(
        "[atomic ui-server] No ATOMIC_UI_SERVER_TOKEN configured — " +
          "accepting any token (loopback-only permissive mode)",
      );
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Start listening.
   *
   * @param port TCP port; `0` lets the OS assign a free port (default).
   * @param host Bind address; defaults to `"127.0.0.1"` (loopback-only).
   */
  start(port = 0, host = "127.0.0.1"): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.netServer.once("error", reject);
      this.netServer.listen(port, host, () => {
        this.netServer.removeListener("error", reject);
        this.running = true;
        const addr = this.address();
        this.log(`[atomic ui-server] Listening on ${addr?.address}:${addr?.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the server gracefully.
   *
   * 1. Sends `server/closing` to every connected client.
   * 2. Waits 100ms for buffered writes to flush.
   * 3. Disposes all `MessageConnection`s.
   * 4. Closes the `net.Server`.
   *
   * @param reason Human-readable shutdown reason forwarded in the notification.
   */
  async stop(reason: "shutdown" | "fatal" = "shutdown"): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // 1. Broadcast server/closing.
    for (const { conn } of this.connections) {
      try {
        conn.sendNotification(SERVER_CLOSING_METHOD, { reason });
      } catch {
        // Best-effort; client may have already disconnected.
      }
    }

    // 2. Drain.
    await new Promise<void>((resolve) => setTimeout(resolve, CLOSE_DRAIN_MS));

    // 3. Dispose connections.
    for (const { conn } of this.connections) {
      try {
        conn.dispose();
      } catch {
        // Ignore disposal errors.
      }
    }
    this.connections.clear();

    // 4. Close net server.
    await new Promise<void>((resolve, reject) => {
      this.netServer.close((err) => (err ? reject(err) : resolve()));
    });
  }

  /**
   * Returns the bound address info, or `null` if the server hasn't started.
   */
  address(): net.AddressInfo | null {
    const addr = this.netServer.address();
    if (!addr || typeof addr === "string") return null;
    return addr;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private handleConnection(socket: net.Socket): void {
    const reader = new SocketMessageReader(socket);
    const writer = new SocketMessageWriter(socket);
    const conn = createMessageConnection(reader, writer);

    const entry: ConnectionEntry = { conn, socket };
    this.connections.add(entry);

    // Cleanup entry when the underlying socket closes.
    socket.on("close", () => {
      this.connections.delete(entry);
    });

    // Log (not throw) on connection-level errors.
    conn.onError(([err]) => {
      this.log(
        `[atomic ui-server] Connection error: ${(err as Error)?.message ?? String(err)}`,
      );
    });

    // Route every incoming request through the MethodDispatcher.
    conn.onRequest((method, params) => {
      return this.dispatcher.dispatch(method, params, conn).catch((err: unknown) => {
        if (err instanceof AtomicRpcError) {
          throw err.toResponseError();
        }
        throw err;
      });
    });

    conn.listen();

    this.log(
      `[atomic ui-server] Connection accepted from ${socket.remoteAddress}:${socket.remotePort}`,
    );
  }

  private log(msg: string): void {
    (this.opts.onLog ?? (() => {}))(msg);
  }
}
