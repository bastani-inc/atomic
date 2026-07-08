import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, RegisteredCommand, ToolDefinition } from "../../packages/coding-agent/src/index.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import intercom from "../../packages/intercom/index.js";
import {
  getBrokerPidPath,
  getBrokerSocketPath,
  getBrokerSpawnLockPath,
  getIntercomDirPath,
} from "../../packages/intercom/broker/paths.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function withEnv<T>(updates: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(updates)) {
    previous.set(key, process.env[key]);
    const value = updates[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("intercom Atomic agent-dir paths", () => {
  test("uses the default Atomic agent directory for broker runtime files", () => {
    const home = tempDir("atomic-intercom-home-");
    withEnv({ HOME: home, USERPROFILE: undefined, ATOMIC_CODING_AGENT_DIR: undefined, PI_CODING_AGENT_DIR: undefined }, () => {
      const agentDir = join(home, ".atomic", "agent");
      assert.equal(getIntercomDirPath(), join(agentDir, "intercom"));
      assert.equal(getBrokerSocketPath("darwin"), join(agentDir, "intercom", "broker.sock"));
      assert.equal(getBrokerPidPath(), join(agentDir, "intercom", "broker.pid"));
      assert.equal(getBrokerSpawnLockPath(), join(agentDir, "intercom", "broker.spawn.lock"));
    });
  });

  test("honors ATOMIC_CODING_AGENT_DIR and legacy PI_CODING_AGENT_DIR aliases", () => {
    const home = tempDir("atomic-intercom-home-");
    const atomicAgentDir = join(home, "custom-atomic-agent");
    const piAgentDir = join(home, "custom-pi-agent");

    withEnv({ HOME: home, ATOMIC_CODING_AGENT_DIR: atomicAgentDir, PI_CODING_AGENT_DIR: piAgentDir }, () => {
      assert.equal(getBrokerSocketPath("linux"), join(atomicAgentDir, "intercom", "broker.sock"));
      assert.equal(getBrokerPidPath(), join(atomicAgentDir, "intercom", "broker.pid"));
    });

    withEnv({ HOME: home, ATOMIC_CODING_AGENT_DIR: undefined, PI_CODING_AGENT_DIR: piAgentDir }, () => {
      assert.equal(getBrokerSocketPath("linux"), join(piAgentDir, "intercom", "broker.sock"));
      assert.equal(getBrokerPidPath(), join(piAgentDir, "intercom", "broker.pid"));
    });
  });

  test("derives Windows pipe identity from the active agent directory", () => {
    const agentDir = join("C:\\Users\\Atomic User", ".atomic", "agent");
    assert.equal(getBrokerSocketPath("win32", agentDir), "\\\\.\\pipe\\pi-intercom-c-users-atomic-user-atomic-agent");
  });
});

function runLoadConfig(home: string): { status?: string; brokerCommand: string; brokerArgs: string[] } {
  const configUrl = pathToFileURL(resolve("packages/intercom/config.ts")).href;
  const script = [
    `const mod = await import(${JSON.stringify(configUrl)});`,
    "console.log(JSON.stringify(mod.loadConfig()));",
  ].join("\n");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.USERPROFILE;
  delete env.ATOMIC_CODING_AGENT_DIR;
  delete env.PI_CODING_AGENT_DIR;
  const result = spawnSync("bun", ["--eval", script], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim()) as { status?: string; brokerCommand: string; brokerArgs: string[] };
}

describe("intercom default broker runtime", () => {
  test("uses Bun directly when no intercom config overrides the broker command", () => {
    const home = tempDir("atomic-intercom-config-");

    const config = runLoadConfig(home);

    assert.equal(config.brokerCommand, "bun");
    assert.deepEqual(config.brokerArgs, []);
  });
});

describe("intercom config path precedence", () => {
  test("prefers ~/.atomic/agent/intercom/config.json over legacy ~/.pi fallback", () => {
    const home = tempDir("atomic-intercom-config-");
    const atomicDir = join(home, ".atomic", "agent", "intercom");
    const piDir = join(home, ".pi", "agent", "intercom");
    mkdirSync(atomicDir, { recursive: true });
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(atomicDir, "config.json"), JSON.stringify({ status: "atomic-config" }), "utf8");
    writeFileSync(join(piDir, "config.json"), JSON.stringify({ status: "pi-config" }), "utf8");

    assert.equal(runLoadConfig(home).status, "atomic-config");
  });

  test("loads legacy ~/.pi/agent/intercom/config.json when Atomic config is absent", () => {
    const home = tempDir("atomic-intercom-config-");
    const piDir = join(home, ".pi", "agent", "intercom");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "config.json"), JSON.stringify({ status: "pi-config" }), "utf8");

    assert.equal(runLoadConfig(home).status, "pi-config");
  });
});

type CapturedRegistration = {
  tools: string[];
  commands: string[];
  shortcuts: string[];
  handlers: string[];
  eventHandlers: string[];
};

function captureIntercomRegistration(env: Record<string, string | undefined>): CapturedRegistration {
  const captured: CapturedRegistration = { tools: [], commands: [], shortcuts: [], handlers: [], eventHandlers: [] };
  withEnv(env, () => {
    const api = {
      on: ((event: string) => { captured.handlers.push(event); }) as ExtensionAPI["on"],
      registerTool: ((tool: ToolDefinition) => { captured.tools.push(tool.name); }) as ExtensionAPI["registerTool"],
      registerCommand: ((name: string, _options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
        captured.commands.push(name);
      }) as ExtensionAPI["registerCommand"],
      registerShortcut: ((shortcut: string) => { captured.shortcuts.push(shortcut); }) as ExtensionAPI["registerShortcut"],
      registerMessageRenderer: (() => {}) as ExtensionAPI["registerMessageRenderer"],
      events: {
        emit: () => {},
        on: (event: string) => {
          captured.eventHandlers.push(event);
          return () => {};
        },
      },
    } as Partial<ExtensionAPI> as ExtensionAPI;
    intercom(api);
  });
  return captured;
}

describe("lazy intercom registration", () => {
  test("registers the Pi-compatible public tool, command, and shortcut in normal sessions", () => {
    const captured = captureIntercomRegistration({
      PI_SUBAGENT_ORCHESTRATOR_TARGET: undefined,
      ATOMIC_SUBAGENT_ORCHESTRATOR_TARGET: undefined,
    });

    assert.ok(captured.tools.includes("intercom"));
    assert.equal(captured.tools.includes("contact_supervisor"), false);
    assert.ok(captured.commands.includes("intercom"));
    assert.ok(captured.shortcuts.includes("alt+m"));
    assert.ok(captured.eventHandlers.includes("subagent:control-intercom"));
    assert.ok(captured.eventHandlers.includes("subagent:result-intercom"));
  });

  test("registers contact_supervisor when PI or ATOMIC subagent bridge metadata exists", () => {
    const piCaptured = captureIntercomRegistration({ PI_SUBAGENT_ORCHESTRATOR_TARGET: "parent" });
    const atomicCaptured = captureIntercomRegistration({ ATOMIC_SUBAGENT_ORCHESTRATOR_TARGET: "parent" });

    assert.ok(piCaptured.tools.includes("contact_supervisor"));
    assert.ok(atomicCaptured.tools.includes("contact_supervisor"));
  });
});

describe("intercom package manifest compatibility", () => {
  test("bundled intercom publishes preferred atomic metadata and legacy pi metadata", () => {
    const manifest = JSON.parse(readFileSync("packages/intercom/package.json", "utf8")) as {
      atomic?: { extensions?: string[]; skills?: string[] };
      pi?: { extensions?: string[]; skills?: string[] };
    };

    assert.deepEqual(manifest.atomic, { extensions: ["./index.ts"], skills: ["./skills"] });
    assert.deepEqual(manifest.pi, manifest.atomic);
  });

  test("loader prefers atomic package metadata and still accepts legacy pi metadata", async () => {
    const cwd = tempDir("atomic-intercom-manifest-cwd-");
    const agentDir = tempDir("atomic-intercom-manifest-agent-");
    const atomicPackageDir = join(cwd, "atomic-package");
    const legacyPackageDir = join(cwd, "legacy-package");
    mkdirSync(atomicPackageDir, { recursive: true });
    mkdirSync(legacyPackageDir, { recursive: true });

    writeFileSync(
      join(atomicPackageDir, "package.json"),
      JSON.stringify({
        name: "atomic-package",
        atomic: { extensions: ["./atomic.ts"] },
        pi: { extensions: ["./pi.ts"] },
      }),
      "utf8",
    );
    writeFileSync(join(atomicPackageDir, "atomic.ts"), "export default (pi) => pi.registerCommand('from-atomic', { description: '', handler() {} });\n", "utf8");
    writeFileSync(join(atomicPackageDir, "pi.ts"), "export default (pi) => pi.registerCommand('from-pi', { description: '', handler() {} });\n", "utf8");

    writeFileSync(
      join(legacyPackageDir, "package.json"),
      JSON.stringify({ name: "legacy-package", pi: { extensions: ["./legacy.ts"] } }),
      "utf8",
    );
    writeFileSync(join(legacyPackageDir, "legacy.ts"), "export default (pi) => pi.registerCommand('from-legacy-pi', { description: '', handler() {} });\n", "utf8");

    const settingsManager = SettingsManager.inMemory();
    settingsManager.setPackages([atomicPackageDir, legacyPackageDir]);
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, builtinPackagePaths: [] });

    await loader.reload();

    const extensions = loader.getExtensions();
    assert.deepEqual(extensions.errors, []);
    const commands = extensions.extensions.flatMap((extension) => [...extension.commands.keys()]);
    assert.ok(commands.includes("from-atomic"));
    assert.ok(commands.includes("from-legacy-pi"));
    assert.equal(commands.includes("from-pi"), false);
  }, 20_000);
});
