/**
 * Tests for copilot.ts provider helpers:
 *   - resolveCopilotCliPath()
 *   - copilotSubprocessEnv()
 *   - copilotSdkLaunchOptions()
 *
 * Strategy:
 * - Inject a command-path resolver to control PATH lookups.
 * - Mutate `process.env` within each test; restore in afterEach.
 * - Never leak PATH mutations or module mocks into parallel test files.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";

import {
  type CommandPathResolver,
  resolveCopilotCliPath,
  copilotSubprocessEnv,
  copilotSdkLaunchOptions,
} from "../../../src/sdk/providers/copilot.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let mockGetCommandPath: CommandPathResolver = () => null;

function makeBaseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    LC_CTYPE: "en_US.UTF-8",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    HOME: "/home/user",
    PATH: "/usr/bin:/bin",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveCopilotCliPath()
// ---------------------------------------------------------------------------

describe("resolveCopilotCliPath()", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore process.env keys
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
    mockGetCommandPath = () => null;
  });

  test("COPILOT_CLI_PATH env var takes precedence over PATH resolution", () => {
    process.env["COPILOT_CLI_PATH"] = "/custom/path/copilot";
    mockGetCommandPath = () => "/usr/local/bin/copilot";

    expect(resolveCopilotCliPath(mockGetCommandPath)).toBe("/custom/path/copilot");
  });

  test("COPILOT_CLI_PATH non-empty string returned verbatim", () => {
    process.env["COPILOT_CLI_PATH"] = "/opt/copilot/bin/copilot";
    mockGetCommandPath = () => null;

    expect(resolveCopilotCliPath(mockGetCommandPath)).toBe("/opt/copilot/bin/copilot");
  });

  test("PATH-resolved copilot binary returned when COPILOT_CLI_PATH not set", () => {
    delete process.env["COPILOT_CLI_PATH"];
    mockGetCommandPath = (cmd: string) =>
      cmd === "copilot" ? "/usr/local/bin/copilot" : null;

    expect(resolveCopilotCliPath(mockGetCommandPath)).toBe("/usr/local/bin/copilot");
  });

  test("returns undefined when COPILOT_CLI_PATH unset and command not on PATH", () => {
    delete process.env["COPILOT_CLI_PATH"];
    mockGetCommandPath = () => null;

    expect(resolveCopilotCliPath(mockGetCommandPath)).toBeUndefined();
  });

  test("empty COPILOT_CLI_PATH falls through to PATH resolution", () => {
    process.env["COPILOT_CLI_PATH"] = "";
    mockGetCommandPath = (cmd: string) =>
      cmd === "copilot" ? "/usr/bin/copilot" : null;

    expect(resolveCopilotCliPath(mockGetCommandPath)).toBe("/usr/bin/copilot");
  });
});

// ---------------------------------------------------------------------------
// copilotSubprocessEnv()
// ---------------------------------------------------------------------------

describe("copilotSubprocessEnv()", () => {
  test("NODE_NO_WARNINGS is set to '1'", () => {
    const env = copilotSubprocessEnv(makeBaseEnv());
    expect(env["NODE_NO_WARNINGS"]).toBe("1");
  });

  test("base env keys preserved in output", () => {
    const base = makeBaseEnv({ MY_CUSTOM_VAR: "hello" });
    const env = copilotSubprocessEnv(base);
    expect(env["MY_CUSTOM_VAR"]).toBe("hello");
  });

  test("UTF-8 locale keys preserved when already UTF-8", () => {
    const base = makeBaseEnv({
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      LC_CTYPE: "en_US.UTF-8",
    });
    const env = copilotSubprocessEnv(base);
    expect(env["LANG"]).toBe("en_US.UTF-8");
    expect(env["LC_ALL"]).toBe("en_US.UTF-8");
    expect(env["LC_CTYPE"]).toBe("en_US.UTF-8");
  });

  test("non-UTF-8 LANG normalized to en_US.UTF-8", () => {
    const base = makeBaseEnv({ LANG: "C", LC_ALL: "C", LC_CTYPE: "C" });
    const env = copilotSubprocessEnv(base);
    expect(env["LANG"]).toBe("en_US.UTF-8");
    expect(env["LC_ALL"]).toBe("en_US.UTF-8");
    expect(env["LC_CTYPE"]).toBe("en_US.UTF-8");
  });

  test("returns fresh object each call — mutations do not leak", () => {
    const base = makeBaseEnv();
    const env1 = copilotSubprocessEnv(base);
    const env2 = copilotSubprocessEnv(base);
    env1["EXTRA"] = "mutated";
    expect(env2["EXTRA"]).toBeUndefined();
  });

  test("NODE_NO_WARNINGS overrides any caller-supplied value", () => {
    // copilotSubprocessEnv merges normalizedTerminalEnv then sets NODE_NO_WARNINGS
    const base = makeBaseEnv({ NODE_NO_WARNINGS: "0" });
    const env = copilotSubprocessEnv(base);
    expect(env["NODE_NO_WARNINGS"]).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// copilotSdkLaunchOptions()
// ---------------------------------------------------------------------------

describe("copilotSdkLaunchOptions()", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
    mockGetCommandPath = () => null;
  });

  test("env field always present in returned options", () => {
    mockGetCommandPath = () => null;
    delete process.env["COPILOT_CLI_PATH"];
    const opts = copilotSdkLaunchOptions(mockGetCommandPath);
    expect(opts.env).toBeDefined();
  });

  test("env includes NODE_NO_WARNINGS=1", () => {
    mockGetCommandPath = () => null;
    delete process.env["COPILOT_CLI_PATH"];
    const opts = copilotSdkLaunchOptions(mockGetCommandPath);
    expect(opts.env?.["NODE_NO_WARNINGS"]).toBe("1");
  });

  test("cliPath set when COPILOT_CLI_PATH provided", () => {
    process.env["COPILOT_CLI_PATH"] = "/custom/copilot";
    mockGetCommandPath = () => null;
    const opts = copilotSdkLaunchOptions(mockGetCommandPath);
    expect(opts.cliPath).toBe("/custom/copilot");
  });

  test("cliPath set when copilot resolved from PATH", () => {
    delete process.env["COPILOT_CLI_PATH"];
    mockGetCommandPath = (cmd: string) =>
      cmd === "copilot" ? "/usr/local/bin/copilot" : null;
    const opts = copilotSdkLaunchOptions(mockGetCommandPath);
    expect(opts.cliPath).toBe("/usr/local/bin/copilot");
  });

  test("cliPath absent when command not resolvable", () => {
    delete process.env["COPILOT_CLI_PATH"];
    mockGetCommandPath = () => null;
    const opts = copilotSdkLaunchOptions(mockGetCommandPath);
    expect(Object.prototype.hasOwnProperty.call(opts, "cliPath")).toBe(false);
  });
});
