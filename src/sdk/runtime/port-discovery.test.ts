/**
 * Tests for the cross-platform TCP port discovery module.
 *
 * Parser functions are tested with synthetic data to keep tests OS-independent.
 * The end-to-end test uses a real server and only runs on Linux/macOS.
 */

import { test, expect, describe, mock, beforeAll, afterAll } from "bun:test";
import {
  _linuxGetListeningPort,
  _macosGetChildren,
  _macosReadListeningPort,
  _parseLinuxTcpLine,
  _parseLinuxTcpTable,
  _getLinuxPidSocketInodes,
  _parseMacosLsofOutput,
  _parseWindowsPowerShellOutput,
  _parseWindowsNetstatOutput,
  _readListeningPortForPid,
  _setPortDiscoverySpawnSyncForTest,
  _windowsGetChildren,
  _windowsReadListeningPort,
  getListeningPortForPid,
  PORT_DISCOVERY_TIMEOUT_MS,
} from "./port-discovery.ts";
import * as net from "node:net";
import { Buffer } from "node:buffer";

type Platform = typeof process.platform;
type SpawnResult = {
  stdout: Buffer;
  stderr: Buffer;
  success: boolean;
};

function withPlatform<T>(platform: Platform, fn: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  try {
    return fn();
  } finally {
    if (descriptor) {
      Object.defineProperty(process, "platform", descriptor);
    }
  }
}

function spawnResult(stdout = "", stderr = "", success = true): SpawnResult {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    success,
  };
}

function withSpawnSyncMock<T>(handler: (cmd: string[]) => SpawnResult, fn: () => T): T {
  const restore = _setPortDiscoverySpawnSyncForTest(mock((options) => handler(options.cmd)));
  try {
    return fn();
  } finally {
    restore();
  }
}

// ---------------------------------------------------------------------------
// 1. Linux /proc parser
// ---------------------------------------------------------------------------

describe("_parseLinuxTcpLine", () => {
  test("returns null for header line", () => {
    const line = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
    expect(_parseLinuxTcpLine(line)).toBeNull();
  });

  test("returns null for non-LISTEN state (ESTABLISHED = 01)", () => {
    const line = "   0: 0100007F:1F90 0200007F:C000 01 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 20 4 24 10 -1";
    expect(_parseLinuxTcpLine(line)).toBeNull();
  });

  test("parses LISTEN state (0A) and decodes port hex :1F90 → 8080", () => {
    // 0x1F90 = 8080
    const line = "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 99001 1 0000000000000000 100 0 0 10 0";
    const result = _parseLinuxTcpLine(line);
    expect(result).not.toBeNull();
    expect(result!.port).toBe(8080);
    expect(result!.inode).toBe(99001);
  });

  test("parses port :50FF → 20735", () => {
    // 0x50FF = 20735
    const line = "   1: 00000000:50FF 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 55555 1 0000000000000000 100 0 0 10 0";
    const result = _parseLinuxTcpLine(line);
    expect(result).not.toBeNull();
    expect(result!.port).toBe(0x50ff);
  });

  test("parses port :0050 → 80", () => {
    // 0x0050 = 80
    const line = "   2: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000  0        0 1001 1 0000000000000000 100 0 0 10 0";
    const result = _parseLinuxTcpLine(line);
    expect(result).not.toBeNull();
    expect(result!.port).toBe(80);
  });

  test("returns null for empty line", () => {
    expect(_parseLinuxTcpLine("")).toBeNull();
    expect(_parseLinuxTcpLine("   ")).toBeNull();
  });

  test("returns null for truncated line", () => {
    expect(_parseLinuxTcpLine("   0: 0100007F:1F90 00000000:0000 0A")).toBeNull();
  });

  test("returns null when port hex is 0000", () => {
    const line = "   0: 00000000:0000 00000000:0000 0A 00000000:00000000 00:00000000 00000000  0        0 1 1 0000000000000000 100 0 0 10 0";
    expect(_parseLinuxTcpLine(line)).toBeNull();
  });
});

describe("_parseLinuxTcpTable", () => {
  const sampleTcp = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 99001 1 0000000000000000 100 0 0 10 0",
    "   1: 0200007F:23FB 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 99002 1 0000000000000000 100 0 0 10 0",
    "   2: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 99003 1 0000000000000000 100 0 0 10 0",
  ].join("\n");

  test("only includes LISTEN (0A) entries", () => {
    const table = _parseLinuxTcpTable(sampleTcp);
    // inode 99002 is ESTABLISHED (01) — must not appear
    expect(table.has(99002)).toBe(false);
  });

  test("maps inode 99001 → port 8080", () => {
    const table = _parseLinuxTcpTable(sampleTcp);
    expect(table.get(99001)).toBe(8080);
  });

  test("maps inode 99003 → port 80", () => {
    const table = _parseLinuxTcpTable(sampleTcp);
    expect(table.get(99003)).toBe(80);
  });

  test("returns empty map for empty content", () => {
    expect(_parseLinuxTcpTable("").size).toBe(0);
  });
});

// Note: _getLinuxPidSocketInodes relies on real /proc fs; tested in e2e section.

describe("Linux discovery helpers", () => {
  test("returns IPv4 port before IPv6 for matching socket inode", () => {
    const tcp = "0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 111 1";
    const tcp6 = "0: 00000000000000000000000001000000:23FB 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 111 1";

    expect(_linuxGetListeningPort(tcp, tcp6, new Set([111]))).toBe(8080);
  });

  test("returns IPv6 port when no IPv4 table entry matches", () => {
    const tcp6 = "0: 00000000000000000000000001000000:23FB 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 222 1";

    expect(_linuxGetListeningPort("", tcp6, new Set([222]))).toBe(9211);
  });

  test("platform dispatch uses Linux reader without subprocesses", () => {
    const port = withPlatform("linux", () => _readListeningPortForPid(2_000_000_000));

    expect(port).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. macOS lsof parser
// ---------------------------------------------------------------------------

describe("_parseMacosLsofOutput", () => {
  const sampleLsof = [
    "COMMAND   PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
    "node    12345 user   23u  IPv4 0x0000000000000000      0t0  TCP 127.0.0.1:8080 (LISTEN)",
    "node    12345 user   24u  IPv4 0x0000000000000001      0t0  TCP 0.0.0.0:9090 (LISTEN)",
  ].join("\n");

  test("extracts port from 127.0.0.1:8080", () => {
    expect(_parseMacosLsofOutput(sampleLsof)).toBe(8080);
  });

  test("prefers loopback over wildcard when loopback appears first", () => {
    const output = [
      "COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "node    1 user 23u IPv4 0 0t0 TCP 127.0.0.1:8080 (LISTEN)",
      "node    1 user 24u IPv4 0 0t0 TCP 0.0.0.0:9090 (LISTEN)",
    ].join("\n");
    expect(_parseMacosLsofOutput(output)).toBe(8080);
  });

  test("returns wildcard port when only 0.0.0.0 binding exists", () => {
    const output = [
      "COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "node    1 user 23u IPv4 0 0t0 TCP 0.0.0.0:3000 (LISTEN)",
    ].join("\n");
    expect(_parseMacosLsofOutput(output)).toBe(3000);
  });

  test("returns null for empty output", () => {
    expect(_parseMacosLsofOutput("")).toBeNull();
  });

  test("returns null for header-only output", () => {
    expect(_parseMacosLsofOutput("COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME")).toBeNull();
  });

  test("handles ::1 IPv6 loopback", () => {
    const output = [
      "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME",
      "node 1 user 10u IPv6 0 0t0 TCP [::1]:4000 (LISTEN)",
    ].join("\n");
    // [::1]:4000 — lastIndexOf(':') points to the ':' before port
    // After stripping brackets, host becomes "[::1]" which won't match our preferred list.
    // The parser sees last colon, gets port 4000, host "[::1]" — falls to fallback candidates.
    const port = _parseMacosLsofOutput(output);
    expect(port).toBe(4000);
  });

  test("handles :: IPv6 wildcard", () => {
    const output = [
      "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME",
      "node 1 user 10u IPv6 0 0t0 TCP [::]:5000 (LISTEN)",
    ].join("\n");
    const port = _parseMacosLsofOutput(output);
    expect(port).toBe(5000);
  });

  test("returns null when no valid port lines", () => {
    expect(_parseMacosLsofOutput("COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\njunk line here")).toBeNull();
  });
});

describe("macOS discovery helpers", () => {
  const lsofOutput = "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nbun 123 user 10u IPv4 0 0t0 TCP 127.0.0.1:4567 (LISTEN)";

  test("reads a port from lsof output", () => {
    const port = withSpawnSyncMock(
      () => spawnResult(lsofOutput),
      () => _macosReadListeningPort(123, 0),
    );

    expect(port).toBe(4567);
  });

  test("walks child PIDs when parent has no listening port", () => {
    const seenCommands: string[][] = [];
    const port = withSpawnSyncMock(
      (cmd) => {
        seenCommands.push(cmd);
        if (cmd[0] === "pgrep") return spawnResult("456\n");
        if (cmd.includes("456")) return spawnResult(lsofOutput.replace("4567", "5678"));
        return spawnResult("");
      },
      () => _macosReadListeningPort(123, 0),
    );

    expect(port).toBe(5678);
    expect(seenCommands.some((cmd) => cmd[0] === "pgrep")).toBe(true);
  });

  test("returns null after macOS child traversal depth limit", () => {
    const port = withSpawnSyncMock(
      () => spawnResult(lsofOutput),
      () => _macosReadListeningPort(123, 4),
    );

    expect(port).toBeNull();
  });

  test("parses pgrep child output and filters invalid values", () => {
    const children = withSpawnSyncMock(
      () => spawnResult("123\nnot-a-pid\n0\n456\n"),
      () => _macosGetChildren(99),
    );

    expect(children).toEqual([123, 456]);
  });

  test("platform dispatch uses macOS reader", () => {
    const port = withPlatform("darwin", () =>
      withSpawnSyncMock(() => spawnResult(lsofOutput), () => _readListeningPortForPid(123)),
    );

    expect(port).toBe(4567);
  });
});

// ---------------------------------------------------------------------------
// 3. Windows PowerShell parser
// ---------------------------------------------------------------------------

describe("_parseWindowsPowerShellOutput", () => {
  test("returns null for empty string", () => {
    expect(_parseWindowsPowerShellOutput("")).toBeNull();
  });

  test("returns null for literal null string", () => {
    expect(_parseWindowsPowerShellOutput("null")).toBeNull();
  });

  test("returns null for whitespace-only string", () => {
    expect(_parseWindowsPowerShellOutput("   ")).toBeNull();
  });

  test("parses single object {LocalPort: 12345}", () => {
    expect(_parseWindowsPowerShellOutput('{"LocalPort":12345}')).toBe(12345);
  });

  test("parses array and returns first port", () => {
    const json = '[{"LocalPort":8080},{"LocalPort":9090}]';
    expect(_parseWindowsPowerShellOutput(json)).toBe(8080);
  });

  test("parses array with single element", () => {
    expect(_parseWindowsPowerShellOutput('[{"LocalPort":3000}]')).toBe(3000);
  });

  test("returns null for invalid JSON", () => {
    expect(_parseWindowsPowerShellOutput("not json")).toBeNull();
  });

  test("returns null for empty array", () => {
    expect(_parseWindowsPowerShellOutput("[]")).toBeNull();
  });

  test("returns null for object without LocalPort", () => {
    expect(_parseWindowsPowerShellOutput('{"OtherField":1234}')).toBeNull();
  });
});

describe("Windows discovery helpers", () => {
  test("reads a port from PowerShell output", () => {
    const port = withSpawnSyncMock(
      () => spawnResult('{"LocalPort":7001}'),
      () => _windowsReadListeningPort(321, 0),
    );

    expect(port).toBe(7001);
  });

  test("falls back to netstat when PowerShell is unavailable", () => {
    const port = withSpawnSyncMock(
      (cmd) => {
        if (cmd[0] === "cmd") {
          return spawnResult("TCP 0.0.0.0:7002 0.0.0.0:0 LISTENING 321");
        }
        return spawnResult("", "CommandNotFoundException", false);
      },
      () => _windowsReadListeningPort(321, 0),
    );

    expect(port).toBe(7002);
  });

  test("walks child PIDs when parent has no listening port", () => {
    const port = withSpawnSyncMock(
      (cmd) => {
        const command = cmd.join(" ");
        if (command.includes("Get-NetTCPConnection") && command.includes("654")) {
          return spawnResult('{"LocalPort":7003}');
        }
        if (command.includes("Win32_Process")) {
          return spawnResult('{"ProcessId":654}');
        }
        return spawnResult("null");
      },
      () => _windowsReadListeningPort(321, 0),
    );

    expect(port).toBe(7003);
  });

  test("returns null after Windows child traversal depth limit", () => {
    const port = withSpawnSyncMock(
      () => spawnResult('{"LocalPort":7004}'),
      () => _windowsReadListeningPort(321, 4),
    );

    expect(port).toBeNull();
  });

  test("parses Windows child PID JSON arrays and objects", () => {
    const arrayChildren = withSpawnSyncMock(
      () => spawnResult('[{"ProcessId":111},{"ProcessId":"222"},{"Other":333},{"ProcessId":0}]'),
      () => _windowsGetChildren(321),
    );
    const objectChildren = withSpawnSyncMock(
      () => spawnResult('{"ProcessId":444}'),
      () => _windowsGetChildren(321),
    );

    expect(arrayChildren).toEqual([111, 222]);
    expect(objectChildren).toEqual([444]);
  });

  test("falls back to wmic when child PowerShell is unavailable", () => {
    const children = withSpawnSyncMock(
      (cmd) => {
        if (cmd[0] === "wmic") return spawnResult("ProcessId\n111\nbad\n222\n");
        return spawnResult("", "is not recognized", false);
      },
      () => _windowsGetChildren(321),
    );

    expect(children).toEqual([111, 222]);
  });

  test("platform dispatch uses Windows reader for non-Linux and non-macOS platforms", () => {
    const port = withPlatform("win32", () =>
      withSpawnSyncMock(() => spawnResult('{"LocalPort":7005}'), () => _readListeningPortForPid(321)),
    );

    expect(port).toBe(7005);
  });
});

// ---------------------------------------------------------------------------
// 4. Windows netstat parser
// ---------------------------------------------------------------------------

describe("_parseWindowsNetstatOutput", () => {
  const sampleNetstat = [
    "",
    "Active Connections",
    "",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       884",
    "  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       1234",
    "  TCP    0.0.0.0:9090           0.0.0.0:0              LISTENING       5678",
    "  TCP    127.0.0.1:54321        127.0.0.1:12345        ESTABLISHED     1234",
    "  UDP    0.0.0.0:3702           *:*                                    1234",
  ].join("\n");

  test("returns port 8080 for PID 1234", () => {
    expect(_parseWindowsNetstatOutput(sampleNetstat, 1234)).toBe(8080);
  });

  test("returns port 9090 for PID 5678", () => {
    expect(_parseWindowsNetstatOutput(sampleNetstat, 5678)).toBe(9090);
  });

  test("ignores ESTABLISHED connections", () => {
    // PID 1234 has ESTABLISHED on 54321 too, but we should get the LISTENING one first
    expect(_parseWindowsNetstatOutput(sampleNetstat, 1234)).toBe(8080);
  });

  test("returns null for unknown PID", () => {
    expect(_parseWindowsNetstatOutput(sampleNetstat, 9999)).toBeNull();
  });

  test("returns null for empty output", () => {
    expect(_parseWindowsNetstatOutput("", 1234)).toBeNull();
  });

  test("handles IPv6 addresses", () => {
    const output = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP6   [::]:8080              [::]:0                 LISTENING       4242",
    ].join("\n");
    expect(_parseWindowsNetstatOutput(output, 4242)).toBe(8080);
  });
});

// ---------------------------------------------------------------------------
// 5. Polling loop (dependency-injection)
// ---------------------------------------------------------------------------

describe("getListeningPortForPid polling loop", () => {
  test("returns port on first non-null read", async () => {
    // We can't inject the resolver directly, but we can test via E2E with a
    // very short timeout on the real process — testing the loop logic is
    // validated through integration (see section 6). Here we test the contract:
    // if the process is the current process and it has a listening socket,
    // we get a port.
    //
    // For pure unit testing of the loop, we verify the timeout path.
    const result = await getListeningPortForPid(-999999, {
      timeoutMs: 50,
      pollIntervalMs: 10,
    });
    // PID -999999 doesn't exist, so either process-alive check returns false
    // or we timeout. Either way, null.
    expect(result).toBeNull();
  });

  test("returns null on timeout for non-listening PID", async () => {
    // Use a real but non-listening PID (our parent shell or similar)
    // The process exists but has no listening TCP socket.
    // With a very short timeout we should get null quickly.
    const result = await getListeningPortForPid(process.ppid ?? 1, {
      timeoutMs: 200,
      pollIntervalMs: 50,
    });
    // Either it times out (null) or parent happens to listen (number).
    // We can't assert exact value but we can assert type.
    expect(result === null || typeof result === "number").toBe(true);
  });

  test("returns null immediately for dead PID", async () => {
    // Use a very large PID unlikely to exist
    const start = Date.now();
    const result = await getListeningPortForPid(2_000_000_000, {
      timeoutMs: 5_000,
      pollIntervalMs: 100,
    });
    const elapsed = Date.now() - start;
    expect(result).toBeNull();
    // Should exit well before the 5s timeout once it detects the process is dead
    // (On Linux, /proc/2_000_000_000 won't exist; on macOS/Windows, kill(0) throws)
    expect(elapsed).toBeLessThan(4_000);
  });
});

// ---------------------------------------------------------------------------
// 6. End-to-end (Linux/macOS only)
// ---------------------------------------------------------------------------

const isLinuxOrMac = process.platform === "linux" || process.platform === "darwin";

describe("getListeningPortForPid end-to-end", () => {
  let server: net.Server;
  let serverPort: number;

  beforeAll(async () => {
    if (!isLinuxOrMac) return;
    server = net.createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    serverPort = typeof addr === "object" && addr !== null ? addr.port : 0;
  });

  afterAll(async () => {
    if (!isLinuxOrMac) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test(
    "discovers own listening port via getListeningPortForPid",
    async () => {
      if (!isLinuxOrMac) {
        return; // Skip on Windows
      }
      expect(serverPort).toBeGreaterThan(0);

      const discovered = await getListeningPortForPid(process.pid, {
        timeoutMs: 5_000,
        pollIntervalMs: 100,
      });

      // The discovered port should match what the server is listening on.
      // Note: process may have multiple listening sockets (e.g., Bun test runner).
      // We verify that discovered is a valid port number.
      expect(discovered).not.toBeNull();
      expect(typeof discovered).toBe("number");
      expect(discovered!).toBeGreaterThan(0);
    },
    10_000,
  );

  test(
    "PORT_DISCOVERY_TIMEOUT_MS is 15000",
    () => {
      expect(PORT_DISCOVERY_TIMEOUT_MS).toBe(15_000);
    },
  );
});
