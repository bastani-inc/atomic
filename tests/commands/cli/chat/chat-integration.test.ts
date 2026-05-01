/**
 * Integration tests for chat/index.ts — resolver and env wiring.
 *
 * Verifies that:
 *  - resolveChatCommand("copilot") delegates to resolveCopilotCliPath()
 *    and honors COPILOT_CLI_PATH even when copilot absent from PATH.
 *  - resolveChatCommand for non-copilot agents uses getCommandPath.
 *  - buildLauncherEnv (used for launcher scripts) excludes process.env
 *    secrets (GH_TOKEN, COPILOT_GITHUB_TOKEN, ANTHROPIC_API_KEY).
 *  - buildSpawnEnv (used for direct Bun.spawn) inherits full env + normalized
 *    terminal keys.
 *  - Normalized LANG, LC_ALL, LC_CTYPE, TERM, COLORTERM always appear in
 *    launcher env.
 */

import { mock, test, expect, describe, beforeEach, afterEach } from "bun:test";

// ---------------------------------------------------------------------------
// Module-level mock for detect.ts — must precede imports.
// ---------------------------------------------------------------------------

let mockGetCommandPath: (cmd: string) => string | null = () => null;

await mock.module("../../../../src/services/system/detect.ts", () => ({
  getCommandPath: (cmd: string) => mockGetCommandPath(cmd),
  getCommandVersion: () => null,
}));

import {
  resolveChatCommand,
  buildLauncherEnv,
  buildSpawnEnv,
  TERMINAL_ENV_KEYS,
} from "../../../../src/commands/cli/chat/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let savedEnv: NodeJS.ProcessEnv;

function saveEnv() {
  savedEnv = { ...process.env };
}

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
}

// ---------------------------------------------------------------------------
// resolveChatCommand — copilot branch
// ---------------------------------------------------------------------------

describe("resolveChatCommand – copilot", () => {
  beforeEach(() => {
    saveEnv();
    mockGetCommandPath = () => null;
  });
  afterEach(() => {
    restoreEnv();
    mockGetCommandPath = () => null;
  });

  test("returns COPILOT_CLI_PATH when set, even if PATH lookup returns null", () => {
    process.env["COPILOT_CLI_PATH"] = "/custom/bin/copilot";
    mockGetCommandPath = () => null;
    expect(resolveChatCommand("copilot")).toBe("/custom/bin/copilot");
  });

  test("returns PATH-resolved path when COPILOT_CLI_PATH absent", () => {
    delete process.env["COPILOT_CLI_PATH"];
    mockGetCommandPath = (cmd) => (cmd === "copilot" ? "/usr/local/bin/copilot" : null);
    expect(resolveChatCommand("copilot")).toBe("/usr/local/bin/copilot");
  });

  test("returns undefined when COPILOT_CLI_PATH unset and copilot not in PATH", () => {
    delete process.env["COPILOT_CLI_PATH"];
    mockGetCommandPath = () => null;
    expect(resolveChatCommand("copilot")).toBeUndefined();
  });

  test("COPILOT_CLI_PATH takes precedence over PATH-resolved path", () => {
    process.env["COPILOT_CLI_PATH"] = "/explicit/copilot";
    mockGetCommandPath = () => "/usr/local/bin/copilot";
    expect(resolveChatCommand("copilot")).toBe("/explicit/copilot");
  });
});

// ---------------------------------------------------------------------------
// resolveChatCommand — non-copilot agents (claude, opencode)
// ---------------------------------------------------------------------------

describe("resolveChatCommand – claude / opencode", () => {
  beforeEach(() => {
    saveEnv();
    mockGetCommandPath = () => null;
  });
  afterEach(() => {
    restoreEnv();
    mockGetCommandPath = () => null;
  });

  test("claude: returns path from getCommandPath('claude')", () => {
    mockGetCommandPath = (cmd) => (cmd === "claude" ? "/usr/bin/claude" : null);
    expect(resolveChatCommand("claude")).toBe("/usr/bin/claude");
  });

  test("claude: returns undefined when not in PATH", () => {
    mockGetCommandPath = () => null;
    expect(resolveChatCommand("claude")).toBeUndefined();
  });

  test("opencode: returns path from getCommandPath('opencode')", () => {
    mockGetCommandPath = (cmd) => (cmd === "opencode" ? "/usr/local/bin/opencode" : null);
    expect(resolveChatCommand("opencode")).toBe("/usr/local/bin/opencode");
  });

  test("copilot COPILOT_CLI_PATH does not affect claude resolution", () => {
    process.env["COPILOT_CLI_PATH"] = "/custom/copilot";
    mockGetCommandPath = (cmd) => (cmd === "claude" ? "/usr/bin/claude" : null);
    expect(resolveChatCommand("claude")).toBe("/usr/bin/claude");
  });
});

// ---------------------------------------------------------------------------
// buildLauncherEnv — secret exclusion and terminal key export
// ---------------------------------------------------------------------------

describe("buildLauncherEnv – launcher script safety", () => {
  test("excludes GH_TOKEN from inherited env", () => {
    const base: NodeJS.ProcessEnv = { GH_TOKEN: "ghp_secret", LANG: "en_US.UTF-8", TERM: "xterm-256color", COLORTERM: "truecolor" };
    const env = buildLauncherEnv({}, base);
    expect("GH_TOKEN" in env).toBe(false);
  });

  test("excludes COPILOT_GITHUB_TOKEN from inherited env", () => {
    const base: NodeJS.ProcessEnv = { COPILOT_GITHUB_TOKEN: "ghu_secret", LANG: "en_US.UTF-8", TERM: "xterm-256color", COLORTERM: "truecolor" };
    const env = buildLauncherEnv({}, base);
    expect("COPILOT_GITHUB_TOKEN" in env).toBe(false);
  });

  test("excludes ANTHROPIC_API_KEY from inherited env", () => {
    const base: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant-secret", LANG: "en_US.UTF-8", TERM: "xterm-256color", COLORTERM: "truecolor" };
    const env = buildLauncherEnv({}, base);
    expect("ANTHROPIC_API_KEY" in env).toBe(false);
  });

  test("exports normalized LANG, LC_ALL, LC_CTYPE, TERM, COLORTERM", () => {
    const base: NodeJS.ProcessEnv = { LANG: "C", TERM: "dumb" };
    const env = buildLauncherEnv({}, base);
    expect(env["LANG"]).toBe("en_US.UTF-8");
    expect(env["LC_ALL"]).toBe("en_US.UTF-8");
    expect(env["LC_CTYPE"]).toBe("en_US.UTF-8");
    expect(env["TERM"]).toBe("xterm-256color");
    expect(env["COLORTERM"]).toBe("truecolor");
  });

  test("all TERMINAL_ENV_KEYS present in launcher env", () => {
    const env = buildLauncherEnv({}, {});
    for (const key of TERMINAL_ENV_KEYS) {
      expect(key in env).toBe(true);
    }
  });

  test("explicit envVars appear in launcher env even if not terminal keys", () => {
    const env = buildLauncherEnv({ ATOMIC_AGENT: "copilot", CUSTOM: "val" }, {});
    expect(env["ATOMIC_AGENT"]).toBe("copilot");
    expect(env["CUSTOM"]).toBe("val");
  });

  test("only terminal keys + explicit vars — no HOME/PATH leakage from baseEnv", () => {
    const base: NodeJS.ProcessEnv = { HOME: "/home/user", PATH: "/usr/bin", LANG: "en_US.UTF-8", TERM: "xterm-256color", COLORTERM: "truecolor" };
    const env = buildLauncherEnv({}, base);
    expect("HOME" in env).toBe(false);
    expect("PATH" in env).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildSpawnEnv — full env inheritance + normalized terminal keys
// ---------------------------------------------------------------------------

describe("buildSpawnEnv – direct spawn env", () => {
  test("inherits full baseEnv including non-terminal keys", () => {
    const base: NodeJS.ProcessEnv = { HOME: "/home/user", PATH: "/usr/bin:/bin", GH_TOKEN: "ghp_secret", LANG: "en_US.UTF-8", TERM: "xterm-256color", COLORTERM: "truecolor" };
    const env = buildSpawnEnv({}, base);
    expect(env["HOME"]).toBe("/home/user");
    expect(env["PATH"]).toBe("/usr/bin:/bin");
    // Secrets inherited in spawn env (intentional — process already has access)
    expect(env["GH_TOKEN"]).toBe("ghp_secret");
  });

  test("normalizes LANG/TERM/COLORTERM from baseEnv", () => {
    const base: NodeJS.ProcessEnv = { LANG: "C", TERM: "dumb", HOME: "/root" };
    const env = buildSpawnEnv({}, base);
    expect(env["LANG"]).toBe("en_US.UTF-8");
    expect(env["TERM"]).toBe("xterm-256color");
    expect(env["COLORTERM"]).toBe("truecolor");
  });

  test("explicit envVars override baseEnv", () => {
    const base: NodeJS.ProcessEnv = { LANG: "C" };
    const env = buildSpawnEnv({ LANG: "ja_JP.UTF-8", ATOMIC_AGENT: "copilot" }, base);
    expect(env["LANG"]).toBe("ja_JP.UTF-8");
    expect(env["ATOMIC_AGENT"]).toBe("copilot");
  });

  test("applies all TERMINAL_ENV_KEYS with sane defaults when base empty", () => {
    const env = buildSpawnEnv({}, {});
    for (const key of TERMINAL_ENV_KEYS) {
      expect(key in env).toBe(true);
    }
    expect(env["LANG"]).toBe("en_US.UTF-8");
    expect(env["TERM"]).toBe("xterm-256color");
    expect(env["COLORTERM"]).toBe("truecolor");
  });
});
