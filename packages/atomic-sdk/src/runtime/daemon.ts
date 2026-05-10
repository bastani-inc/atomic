/**
 * Daemon lifecycle — singleton enforcement, endpoint file I/O, signal handling,
 * logging, and SDK connect helper.
 *
 * Responsibilities (§5.2, §7.2 of specs/2026-05-09-ui-server-bun-native.md):
 *   - Ensure per-user singleton via ~/.atomic/daemon.endpoint.json.
 *   - Detect and clean up stale endpoint files.
 *   - Bind UIServer on 127.0.0.1:0 (kernel-assigned port).
 *   - Write endpoint file with mode 0o600.
 *   - Trap SIGTERM / SIGINT / SIGHUP → emit server/closing, unlink endpoint.
 *   - Trap unhandledRejection / uncaughtException → log to daemon.log, stop fatal.
 *   - Log to ~/.atomic/daemon.log (configurable for tests via DaemonOptions.logFile).
 *   - `connectToDaemon()` SDK helper — connect to existing or throw if absent.
 *   - `ensureStarted()` SDK helper — auto-spawn if absent, poll endpoint file.
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import { UIServer } from "./ui-server.ts";
import { getProtocolVersion } from "./protocol-version.ts";
import type { IRunManager, ISupervisor } from "./ui-protocol/methods.ts";
import type { WorkflowRegistry } from "./registry.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Shape of the on-disk endpoint file. */
export interface DaemonEndpoint {
  host: string;
  port: number;
  pid: number;
  startedAt: string;
  atomicVersion: string;
  protocolVersion: string;
}

/** Options for Daemon.start(). */
export interface DaemonOptions {
  /** Injected into UIServer/MethodDispatcher. */
  workflows: WorkflowRegistry;
  runs: IRunManager;
  supervisor: ISupervisor;
  /** Version of the atomic binary/CLI. */
  atomicVersion: string;
  /** Version of the SDK package (@bastani/atomic-sdk). */
  sdkVersion: string;

  /**
   * Pre-shared connection token. Defaults to ATOMIC_UI_SERVER_TOKEN env var,
   * then a randomly-generated 32-byte hex string.
   */
  token?: string;

  /**
   * Absolute path to the endpoint JSON file.
   * Defaults to ~/.atomic/daemon.endpoint.json.
   */
  endpointFile?: string;

  /**
   * Absolute path to the log file.
   * Defaults to ~/.atomic/daemon.log.
   */
  logFile?: string;

  /** Warning callback (defaults to console.warn). */
  onWarn?: (msg: string) => void;

  /** Log callback (defaults to appendFile → logFile). */
  onLog?: (msg: string) => void;
}

/** Result of Daemon.start() when a new daemon process was started. */
export interface DaemonStartResult {
  /** The endpoint that was written. */
  endpoint: DaemonEndpoint;
  /** How the daemon was started. "new" = bound fresh server. "existing" = found running daemon. */
  mode: "new" | "existing";
}

/** Options for connectToDaemon(). */
export interface ConnectOptions {
  /** Absolute path to the endpoint file. Defaults to ~/.atomic/daemon.endpoint.json. */
  endpointFile?: string;
  /** Token to send in connect(). Defaults to ATOMIC_UI_SERVER_TOKEN. */
  token?: string;
  /** clientName forwarded in connect(). Defaults to "@bastani/atomic-sdk". */
  clientName?: string;
}

/** Options for ensureStarted(). */
export interface EnsureStartedOptions extends ConnectOptions {
  /**
   * Path to the atomic binary to spawn if the daemon is not running.
   * Defaults to ATOMIC_BINARY env var, then Bun.which("atomic"), then throws MissingDependencyError.
   */
  atomicBinary?: string;
  /** Poll interval in ms. Defaults to 50. */
  pollIntervalMs?: number;
  /** Maximum wait in ms. Defaults to 5000. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class MissingDependencyError extends Error {
  constructor(dep: string) {
    super(`Missing dependency: ${dep}`);
    this.name = "MissingDependencyError";
  }
}

export class DaemonAlreadyRunningError extends Error {
  constructor(public readonly endpoint: DaemonEndpoint) {
    super(`Daemon already running on port ${endpoint.port}`);
    this.name = "DaemonAlreadyRunningError";
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function defaultEndpointFile(): string {
  return path.join(os.homedir(), ".atomic", "daemon.endpoint.json");
}

function defaultLogFile(): string {
  return path.join(os.homedir(), ".atomic", "daemon.log");
}

// ---------------------------------------------------------------------------
// Endpoint file helpers
// ---------------------------------------------------------------------------

/** Read and parse the endpoint file, or return null on any error. */
export async function readEndpointFile(endpointFile: string): Promise<DaemonEndpoint | null> {
  try {
    const raw = await fsp.readFile(endpointFile, "utf8");
    return JSON.parse(raw) as DaemonEndpoint;
  } catch {
    return null;
  }
}

/**
 * Write endpoint JSON to endpointFile with mode 0o600.
 * Creates parent directories as needed.
 */
async function writeEndpointFile(endpointFile: string, endpoint: DaemonEndpoint): Promise<void> {
  await fsp.mkdir(path.dirname(endpointFile), { recursive: true });
  await fsp.writeFile(endpointFile, JSON.stringify(endpoint, null, 2), {
    mode: 0o600,
    encoding: "utf8",
  });
}

/** Unlink endpoint file; ignores ENOENT. */
async function unlinkEndpointFile(endpointFile: string): Promise<void> {
  try {
    await fsp.unlink(endpointFile);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// ---------------------------------------------------------------------------
// Liveness probe
// ---------------------------------------------------------------------------

/**
 * Probe whether the endpoint described by `ep` has a live daemon responding
 * to `protocol/getVersion`. Returns the version string if alive, null if stale.
 *
 * Uses a raw Content-Length framed JSON-RPC exchange to avoid vscode-jsonrpc's
 * Bun-specific socket write timing issues.
 */
export async function probeLiveness(ep: DaemonEndpoint): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const socket = net.createConnection({ host: ep.host, port: ep.port });
    let settled = false;

    const done = (result: string | null) => {
      if (settled) return;
      settled = true;
      socket.on("error", () => {}); // Suppress post-cleanup errors.
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => done(null), 2_000);

    socket.once("error", () => {
      clearTimeout(timer);
      done(null);
    });

    socket.once("connect", () => {
      // Accumulate response bytes.
      let buf = "";

      socket.on("data", (chunk: Buffer | string) => {
        buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");

        // Parse Content-Length framing.
        const headerEnd = buf.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;

        const header = buf.slice(0, headerEnd);
        const lenMatch = /Content-Length:\s*(\d+)/i.exec(header);
        if (!lenMatch) return;

        const bodyLen = parseInt(lenMatch[1]!, 10);
        const bodyStart = headerEnd + 4;
        if (buf.length < bodyStart + bodyLen) return;

        const body = buf.slice(bodyStart, bodyStart + bodyLen);
        clearTimeout(timer);

        try {
          const msg = JSON.parse(body) as { result?: { protocolVersion?: unknown } };
          const v = msg.result?.protocolVersion;
          done(typeof v === "string" ? v : null);
        } catch {
          done(null);
        }
      });

      socket.on("error", () => {
        clearTimeout(timer);
        done(null);
      });

      // Send a JSON-RPC 2.0 request for protocol/getVersion.
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "protocol/getVersion",
        params: {},
      });
      const msg = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
      socket.write(msg, "utf8");
    });
  });
}

// ---------------------------------------------------------------------------
// Log helpers
// ---------------------------------------------------------------------------

function buildLogWriter(logFile: string): (msg: string) => void {
  return (msg: string) => {
    const line = `${new Date().toISOString()} ${msg}\n`;
    // Sync append to avoid losing logs on crash paths.
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, line, { encoding: "utf8" });
    } catch {
      // Never throw from a log function.
    }
  };
}

// ---------------------------------------------------------------------------
// Transport error guard
// ---------------------------------------------------------------------------

/**
 * Returns true for socket-level errors that are already handled by the
 * UIServer's per-connection onError handler. vscode-jsonrpc v8 leaks these as
 * unhandled rejections; we must not treat them as fatal daemon errors.
 */
function isTransportError(reason: unknown): boolean {
  if (!(reason instanceof Error)) return false;
  const code = (reason as NodeJS.ErrnoException).code;
  return code === "EPIPE" || code === "ECONNRESET" || code === "ECONNABORTED";
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

/**
 * Daemon lifecycle manager.
 *
 * ```ts
 * const daemon = new Daemon(opts);
 * const { mode, endpoint } = await daemon.start();
 * // ... serve until signal ...
 * await daemon.stop();
 * ```
 */
export class Daemon {
  private readonly opts: DaemonOptions & {
    endpointFile: string;
    logFile: string;
    token: string | undefined;
  };

  private server: UIServer | null = null;
  private endpoint: DaemonEndpoint | null = null;

  // Signal/error handler abort controller so tests can tear down cleanly.
  private signalAbort: AbortController | null = null;

  constructor(opts: DaemonOptions) {
    // Per spec §5.2: if ATOMIC_UI_SERVER_TOKEN is unset and no explicit token
    // provided, the daemon runs in permissive/loopback-only mode (token = undefined).
    const token =
      opts.token ??
      process.env.ATOMIC_UI_SERVER_TOKEN;

    const endpointFile = opts.endpointFile ?? defaultEndpointFile();
    const logFile = opts.logFile ?? defaultLogFile();

    const logWriter = buildLogWriter(logFile);

    this.opts = {
      ...opts,
      token,
      endpointFile,
      logFile,
      onWarn: opts.onWarn ?? ((msg) => { console.warn(msg); logWriter(msg); }),
      onLog: opts.onLog ?? logWriter,
    };
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Start the daemon.
   *
   * 1. Read endpoint file; probe liveness.
   * 2. If alive → throw DaemonAlreadyRunningError (caller decides what to do).
   * 3. If stale → unlink, proceed.
   * 4. Bind UIServer on 127.0.0.1:0.
   * 5. Write endpoint file (mode 0o600).
   * 6. Register signal handlers.
   * 7. Register unhandled exception handlers → log + fatal stop.
   */
  async start(): Promise<DaemonStartResult> {
    const { endpointFile } = this.opts;

    const existing = await readEndpointFile(endpointFile);
    if (existing !== null) {
      const version = await probeLiveness(existing);
      if (version !== null) {
        // Another daemon is alive — return existing endpoint info.
        return { endpoint: existing, mode: "existing" };
      }
      // Stale — unlink and proceed.
      this.log(`[daemon] Stale endpoint file detected (port ${existing.port}); cleaning up.`);
      await unlinkEndpointFile(endpointFile);
    }

    // Bind server.
    const server = new UIServer({
      workflows: this.opts.workflows,
      runs: this.opts.runs,
      supervisor: this.opts.supervisor,
      atomicVersion: this.opts.atomicVersion,
      sdkVersion: this.opts.sdkVersion,
      token: this.opts.token,
      onWarn: this.opts.onWarn,
      onLog: this.opts.onLog,
    });

    await server.start(0, "127.0.0.1");
    this.server = server;

    // Load workflow registry before writing the endpoint file so that the
    // daemon is fully ready (workflows available) the moment it becomes
    // discoverable. Broken entries are logged as warnings but do not abort
    // startup — the MethodDispatcher already handles defensive lazy-load.
    const { broken } = await this.opts.workflows.load();
    for (const entry of broken) {
      this.warn(`[daemon] Failed to load workflow ${entry.source}: ${entry.error}`);
    }

    const addr = server.address();
    if (!addr) throw new Error("UIServer started but address() returned null");

    const endpoint: DaemonEndpoint = {
      host: addr.address,
      port: addr.port,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      atomicVersion: this.opts.atomicVersion,
      protocolVersion: getProtocolVersion(),
    };
    this.endpoint = endpoint;

    await writeEndpointFile(endpointFile, endpoint);
    this.log(`[daemon] Started on ${endpoint.host}:${endpoint.port} (pid ${endpoint.pid})`);

    this.registerSignalHandlers();

    return { endpoint, mode: "new" };
  }

  /**
   * Gracefully stop the daemon.
   * Broadcasts `server/closing`, drains 100ms, unlinks endpoint file.
   */
  async stop(reason: "shutdown" | "fatal" = "shutdown"): Promise<void> {
    this.deregisterSignalHandlers();

    if (this.server) {
      await this.server.stop(reason);
      this.server = null;
    }

    if (this.endpoint) {
      await unlinkEndpointFile(this.opts.endpointFile);
      this.endpoint = null;
    }

    this.log(`[daemon] Stopped (reason: ${reason})`);
  }

  /** Current bound endpoint, or null if not started. */
  getEndpoint(): DaemonEndpoint | null {
    return this.endpoint;
  }

  /** Current connection token. */
  getToken(): string | undefined {
    return this.opts.token;
  }

  // ── Signal / exception handlers ──────────────────────────────────────────

  private signalHandler = async () => {
    this.log("[daemon] Signal received — shutting down.");
    await this.stop("shutdown");
    process.exit(0);
  };

  private unhandledRejectionHandler = async (reason: unknown) => {
    // vscode-jsonrpc leaks socket write errors (EPIPE / ECONNRESET) as
    // unhandled rejections even though UIServer.handleConnection registers
    // conn.onError to handle them. Ignore these network-level transport errors
    // since they are already handled at the connection layer.
    if (isTransportError(reason)) return;

    const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    this.log(`[daemon] Unhandled rejection: ${msg}`);
    await this.stop("fatal");
    process.exit(1);
  };

  private uncaughtExceptionHandler = async (err: Error) => {
    this.log(`[daemon] Uncaught exception: ${err.stack ?? err.message}`);
    await this.stop("fatal");
    process.exit(1);
  };

  private registerSignalHandlers(): void {
    this.signalAbort = new AbortController();
    process.on("SIGTERM", this.signalHandler);
    process.on("SIGINT", this.signalHandler);
    process.on("SIGHUP", this.signalHandler);
    process.on("unhandledRejection", this.unhandledRejectionHandler);
    process.on("uncaughtException", this.uncaughtExceptionHandler);
  }

  private deregisterSignalHandlers(): void {
    process.off("SIGTERM", this.signalHandler);
    process.off("SIGINT", this.signalHandler);
    process.off("SIGHUP", this.signalHandler);
    process.off("unhandledRejection", this.unhandledRejectionHandler);
    process.off("uncaughtException", this.uncaughtExceptionHandler);
    this.signalAbort = null;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private log(msg: string): void {
    this.opts.onLog?.(msg);
  }

  private warn(msg: string): void {
    this.opts.onWarn?.(msg);
  }
}

// ---------------------------------------------------------------------------
// SDK helpers
// ---------------------------------------------------------------------------

const daemonConnectionSockets = new WeakMap<MessageConnection, net.Socket>();

/** Dispose a daemon MessageConnection and force-close its underlying socket. */
export function closeDaemonConnection(conn: MessageConnection): void {
  try {
    conn.dispose();
  } finally {
    daemonConnectionSockets.get(conn)?.destroy();
    daemonConnectionSockets.delete(conn);
  }
}

/**
 * Connect to a running daemon's endpoint.
 *
 * Reads the endpoint file, opens a TCP socket, sends `connect()`, returns the
 * authenticated MessageConnection. Throws if endpoint is absent or unreachable.
 */
export async function connectToDaemon(opts: ConnectOptions = {}): Promise<MessageConnection> {
  const endpointFile = opts.endpointFile ?? defaultEndpointFile();
  const token = opts.token ?? process.env.ATOMIC_UI_SERVER_TOKEN;
  const clientName = opts.clientName ?? "@bastani/atomic-sdk";

  const ep = await readEndpointFile(endpointFile);
  if (ep === null) {
    throw new MissingDependencyError("@bastani/atomic (no endpoint file)");
  }

  return openConnection(ep.host, ep.port, token, clientName);
}

/**
 * Ensure the daemon is running, spawning it if necessary.
 *
 * Auto-spawn resolution (§5.2):
 *   1. opts.atomicBinary
 *   2. process.env.ATOMIC_BINARY
 *   3. workspace CLI source when running from a monorepo source checkout
 *   4. bundled @bastani/atomic platform binary
 *   5. Bun.which("atomic")
 *   6. Throws MissingDependencyError
 *
 * Polls the endpoint file every pollIntervalMs for up to timeoutMs.
 * Returns an authenticated MessageConnection.
 */
export async function ensureStarted(opts: EnsureStartedOptions = {}): Promise<MessageConnection> {
  const endpointFile = opts.endpointFile ?? defaultEndpointFile();
  const token = opts.token ?? process.env.ATOMIC_UI_SERVER_TOKEN;
  const clientName = opts.clientName ?? "@bastani/atomic-sdk";
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Try existing endpoint first.
  const existing = await readEndpointFile(endpointFile);
  if (existing !== null) {
    const alive = await probeLiveness(existing);
    if (alive !== null) {
      return openConnection(existing.host, existing.port, token, clientName);
    }
    // Stale; unlink and spawn fresh.
    await unlinkEndpointFile(endpointFile);
  }

  // Resolve daemon command.
  const command = resolveAtomicDaemonCommand(opts.atomicBinary);

  // Spawn detached daemon. `detached: true` starts a new process group, but
  // Bun still keeps a child-process handle referenced unless we explicitly
  // unref it. Without this, short-lived callers like `atomic workflow -d ...`
  // print the run id and then hang until the daemon exits.
  const child = Bun.spawn([...command, "--ui-server"], {
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
    env: process.env as Record<string, string>,
  });
  (child as { unref?: () => void }).unref?.();

  // Poll for endpoint file.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    const ep = await readEndpointFile(endpointFile);
    if (ep !== null) {
      const alive = await probeLiveness(ep);
      if (alive !== null) {
        return openConnection(ep.host, ep.port, token, clientName);
      }
    }
  }

  throw new MissingDependencyError("@bastani/atomic (daemon did not start within timeout)");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveAtomicDaemonCommand(override?: string): string[] {
  if (override) return [override];
  if (process.env.ATOMIC_BINARY) return [process.env.ATOMIC_BINARY];

  const workspaceDevCommand = resolveWorkspaceDevAtomicCommand();
  if (workspaceDevCommand !== null) return workspaceDevCommand;

  const packagedBinary = resolvePackagedAtomicBinary();
  if (packagedBinary !== null) return [packagedBinary];

  const found = Bun.which("atomic");
  if (found) return [found];
  throw new MissingDependencyError("@bastani/atomic");
}

function resolveWorkspaceDevAtomicCommand(): string[] | null {
  let cliPath: string;
  try {
    cliPath = fileURLToPath(new URL("../../../atomic/src/cli.ts", import.meta.url));
  } catch {
    return null;
  }

  if (!fs.existsSync(cliPath)) return null;
  if (!isSdkSourceCheckout()) return null;

  return [process.execPath, cliPath];
}

/** @internal — exported for unit tests. */
export function resolvePackagedAtomicBinary(): string | null {
  if (isSdkSourceCheckout()) return null;

  const require = createRequire(import.meta.url);
  const ext = process.platform === "win32" ? ".exe" : "";

  for (const suffix of getPlatformPackageSuffixes()) {
    try {
      return require.resolve(`@bastani/atomic-${suffix}/bin/atomic${ext}`);
    } catch {
      // Try the next package candidate.
    }
  }

  return null;
}

function isSdkSourceCheckout(): boolean {
  try {
    const here = fileURLToPath(import.meta.url);
    return here.includes(`${path.sep}packages${path.sep}atomic-sdk${path.sep}src${path.sep}`);
  } catch {
    return false;
  }
}

/** @internal — exported for unit tests. */
export function getPlatformPackageSuffixes(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
  musl: boolean = isLinuxMusl(),
): string[] {
  if (arch !== "x64" && arch !== "arm64") return [];

  switch (platform) {
    case "linux":
      return musl
        ? [`linux-${arch}-musl`, `linux-${arch}`]
        : [`linux-${arch}`, `linux-${arch}-musl`];
    case "darwin":
      return [`darwin-${arch}`];
    case "win32":
      return [`windows-${arch}`];
    default:
      return [];
  }
}

/** @internal — exported for unit tests. */
export function isLinuxMusl(): boolean {
  if (process.platform !== "linux") return false;
  const report = process.report?.getReport?.() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  return report?.header?.glibcVersionRuntime === undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Open a raw TCP connection to host:port, perform `connect` handshake,
 * return the authenticated MessageConnection.
 */
function openConnection(
  host: string,
  port: number,
  token: string | undefined,
  clientName: string,
): Promise<MessageConnection> {
  return new Promise<MessageConnection>((resolve, reject) => {
    const socket = net.createConnection({ host, port });

    socket.once("error", reject);

    socket.once("connect", () => {
      const reader = new StreamMessageReader(socket);
      const writer = new StreamMessageWriter(socket);
      const conn = createMessageConnection(reader, writer);
      daemonConnectionSockets.set(conn, socket);
      socket.on("close", () => daemonConnectionSockets.delete(conn));
      conn.listen();

      const connectParams: { token?: string; clientName: string } = { clientName };
      if (token !== undefined) connectParams.token = token;

      conn
        .sendRequest("connect", connectParams)
        .then(() => resolve(conn))
        .catch((err) => {
          socket.on("error", () => {});
          conn.dispose();
          socket.destroy();
          reject(err);
        });
    });
  });
}
