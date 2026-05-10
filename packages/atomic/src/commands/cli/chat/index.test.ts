import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";
import {
  buildAgentArgs,
  buildLauncherEnv,
  buildLauncherScript,
  buildSpawnEnv,
  resolveChatCommand,
  startChatSessionViaDaemon,
} from "./index.ts";
import { atomicTempEnv } from "@bastani/atomic-sdk/lib/atomic-temp";

const TERMINAL_ENV_KEYS = ["LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM"] as const;

const sampleTerminalEnv: Record<string, string> = {
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  LC_CTYPE: "en_US.UTF-8",
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
};

function withMockPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  }
}

function withEnvVar<T>(key: string, value: string, fn: () => T): T {
  const originalValue = process.env[key];
  process.env[key] = value;

  try {
    return fn();
  } finally {
    if (originalValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalValue;
    }
  }
}

describe("buildLauncherScript", () => {
  test("builds a PowerShell launcher with cwd, env, args, and exit code", () => {
    const { script, ext } = withMockPlatform("win32", () =>
      buildLauncherScript(
        "copilot",
        ["--debug"],
        "C:\\repo",
        { ATOMIC_AGENT: "copilot" },
      )
    );

    expect(ext).toBe("ps1");
    expect(script).toContain('Set-Location "C:\\repo"');
    expect(script).toContain('${env:ATOMIC_AGENT} = "copilot"');
    expect(script).toContain('& "copilot" @("--debug")');
    expect(script).toContain('if ($LASTEXITCODE -is [int]) { $atomicExitCode = $LASTEXITCODE }');
    expect(script).toContain("exit $atomicExitCode");
    expect(script).not.toContain("Invoke-AtomicSessionCleanup");
  });

  test("builds a bash launcher without terminal input suppression", () => {
    const { script, ext } = withMockPlatform("linux", () =>
      buildLauncherScript(
        "claude",
        ["--dangerously-skip-permissions"],
        "/repo",
        { ATOMIC_AGENT: "claude" },
      )
    );

    expect(ext).toBe("sh");
    expect(script).toContain('cd "/repo"');
    expect(script).toContain('export ATOMIC_AGENT="claude"');
    expect(script).toContain('"claude" "--dangerously-skip-permissions"');
    expect(script).toContain("atomic_exit_code=$?");
    expect(script).not.toContain("exec ");
    expect(script).not.toContain("stty -echo -icanon");
    expect(script).not.toContain("atomic_original_tty_state");
    expect(script).not.toContain("trap atomic_cleanup");
  });

  describe("terminal env key exports", () => {
    test("bash launcher exports LANG, LC_ALL, LC_CTYPE, TERM, COLORTERM", () => {
      const { script, ext } = withMockPlatform("linux", () =>
        buildLauncherScript("claude", [], "/repo", sampleTerminalEnv)
      );

      expect(ext).toBe("sh");
      for (const key of TERMINAL_ENV_KEYS) {
        expect(script).toContain(`export ${key}="${sampleTerminalEnv[key]}"`);
      }
    });

    test("PowerShell launcher sets LANG, LC_ALL, LC_CTYPE, TERM, COLORTERM", () => {
      const { script, ext } = withMockPlatform("win32", () =>
        buildLauncherScript("claude", [], "C:\\repo", sampleTerminalEnv)
      );

      expect(ext).toBe("ps1");
      for (const key of TERMINAL_ENV_KEYS) {
        expect(script).toContain(`\${env:${key}} = "${sampleTerminalEnv[key]}"`);
      }
    });

    test("bash launcher emits export lines for all five terminal env keys when merged with other env", () => {
      const envVars = { ...sampleTerminalEnv, ATOMIC_AGENT: "claude" };
      const { script } = withMockPlatform("linux", () =>
        buildLauncherScript("claude", [], "/repo", envVars)
      );

      for (const key of TERMINAL_ENV_KEYS) {
        expect(script).toContain(`export ${key}=`);
      }
      expect(script).toContain('export ATOMIC_AGENT="claude"');
    });

    test("PowerShell launcher emits braced env assignments for all five terminal env keys when merged with other env", () => {
      const envVars = { ...sampleTerminalEnv, ATOMIC_AGENT: "copilot" };
      const { script } = withMockPlatform("win32", () =>
        buildLauncherScript("copilot", [], "C:\\repo", envVars)
      );

      for (const key of TERMINAL_ENV_KEYS) {
        expect(script).toContain(`\${env:${key}} =`);
      }
      expect(script).toContain('${env:ATOMIC_AGENT} = "copilot"');
    });

    test("PowerShell launcher handles env keys with punctuation", () => {
      const { script } = withMockPlatform("win32", () =>
        buildLauncherScript("copilot", [], "C:\\repo", {
          "ProgramFiles(x86)": "C:\\Program Files (x86)",
        })
      );

      expect(script).toContain('${env:ProgramFiles(x86)} = "C:\\Program Files (x86)"');
    });

    test("bash launcher rejects invalid env keys", () => {
      expect(() =>
        withMockPlatform("linux", () =>
          buildLauncherScript("claude", [], "/repo", {
            "ProgramFiles(x86)": "C:\\Program Files (x86)",
          })
        )
      ).toThrow('Invalid Bash env key "ProgramFiles(x86)"');
    });
  });
});

describe("chat env builders", () => {
  const devcontainerEnv = {
    GH_TOKEN: "gh-secret",
    COPILOT_GITHUB_TOKEN: "copilot-secret",
    ANTHROPIC_API_KEY: "anthropic-secret",
    PATH: "/usr/local/bin",
    HOME: "/home/dev",
    LANG: "C",
    TERM: "dumb",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
  };

  test("buildLauncherEnv serializes only terminal defaults and explicit env", () => {
    const env = buildLauncherEnv({ ATOMIC_AGENT: "copilot" }, devcontainerEnv);

    expect(env).toEqual({
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      LC_CTYPE: "en_US.UTF-8",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      ATOMIC_AGENT: "copilot",
    });
  });

  test("Claude temp env is preserved when serialized into a launcher", () => {
    const claudeTempEnv = atomicTempEnv("/home/dev/.atomic/tmp");
    const env = buildLauncherEnv({ ...claudeTempEnv, ATOMIC_AGENT: "claude" }, devcontainerEnv);

    expect(env.TMPDIR).toBe("/home/dev/.atomic/tmp");
    expect(env.TMP).toBe("/home/dev/.atomic/tmp");
    expect(env.TEMP).toBe("/home/dev/.atomic/tmp");
  });

  test("buildLauncherEnv does not include inherited secrets or platform keys", () => {
    const env = buildLauncherEnv({ ATOMIC_AGENT: "copilot" }, devcontainerEnv);

    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.COPILOT_GITHUB_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBeUndefined();
    expect(env.HOME).toBeUndefined();
    expect(env["ProgramFiles(x86)"]).toBeUndefined();
  });

  test("buildSpawnEnv preserves inherited process env while normalizing terminal keys", () => {
    const env = buildSpawnEnv({ ATOMIC_AGENT: "copilot" }, devcontainerEnv);

    expect(env.GH_TOKEN).toBe("gh-secret");
    expect(env.COPILOT_GITHUB_TOKEN).toBe("copilot-secret");
    expect(env.ANTHROPIC_API_KEY).toBe("anthropic-secret");
    expect(env.PATH).toBe("/usr/local/bin");
    expect(env.HOME).toBe("/home/dev");
    expect(env["ProgramFiles(x86)"]).toBe("C:\\Program Files (x86)");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.ATOMIC_AGENT).toBe("copilot");
  });

  test("launcher script generated from buildLauncherEnv contains no inherited secret values", () => {
    const env = buildLauncherEnv({ ATOMIC_AGENT: "copilot" }, devcontainerEnv);
    const { script } = withMockPlatform("linux", () =>
      buildLauncherScript("copilot", [], "/repo", env)
    );

    expect(script).not.toContain("gh-secret");
    expect(script).not.toContain("copilot-secret");
    expect(script).not.toContain("anthropic-secret");
    expect(script).toContain('export LANG="en_US.UTF-8"');
    expect(script).toContain('export ATOMIC_AGENT="copilot"');
  });
});

describe("buildAgentArgs", () => {
  test("Copilot chat keeps CLI mouse capture enabled so click events work", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "atomic-chat-args-"));
    try {
      const args = await buildAgentArgs("copilot", [], projectRoot);

      expect(args).toContain("--experimental");
      expect(args).not.toContain("--no-mouse");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("startChatSessionViaDaemon", () => {
  test("sends chat/start with agent args env and cwd", async () => {
    const sendRequest = mock(async (_method: string, _params: unknown) => ({
      runId: "chat-run-1",
      attachable: true,
    }));
    const dispose = mock(() => {});
    const ensureStartedFn = mock(async () => ({ sendRequest, dispose }) as never);

    const runId = await startChatSessionViaDaemon({
      agentType: "claude",
      args: ["--debug"],
      env: { ATOMIC_AGENT: "claude" },
      cwd: "/repo",
      ensureStartedFn,
    });

    expect(runId).toBe("chat-run-1");
    expect(ensureStartedFn).toHaveBeenCalledWith({ clientName: "@bastani/atomic/chat" });
    expect(sendRequest).toHaveBeenCalledWith("chat/start", {
      agent: "claude",
      args: ["--debug"],
      env: { ATOMIC_AGENT: "claude" },
      cwd: "/repo",
    });
    expect(dispose).toHaveBeenCalled();
  });
});

describe("resolveChatCommand", () => {
  test("uses COPILOT_CLI_PATH for Copilot even when command is outside PATH", () => {
    withEnvVar("COPILOT_CLI_PATH", "/custom/bin/copilot-custom", () => {
      expect(resolveChatCommand("copilot")).toBe("/custom/bin/copilot-custom");
    });
  });

  test("launcher script accepts resolved Copilot path", () => {
    const resolvedCopilotPath = "/custom/bin/copilot-custom";
    const { script } = withMockPlatform("linux", () =>
      buildLauncherScript(resolvedCopilotPath, ["--debug"], "/repo", {
        ATOMIC_AGENT: "copilot",
      })
    );

    expect(script).toContain('"/custom/bin/copilot-custom" "--debug"');
    expect(script).not.toContain('"copilot" "--debug"');
  });
});
