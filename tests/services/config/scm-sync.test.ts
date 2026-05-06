import {
  test,
  expect,
  describe,
  beforeEach,
  afterEach,
} from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  copilotScmDisableFlags,
  getCopilotScmDisableFlags,
  syncScmMcpServers,
} from "../../../packages/atomic-sdk/src/services/config/scm-sync.ts";

let tmpDir: string;
let previousSettingsHome: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "scm-sync-test-"));
  // Point the global atomic settings path at an empty dir inside tmpDir so
  // tests stay hermetic and never read the real user's ~/.atomic/settings.json.
  previousSettingsHome = process.env.ATOMIC_SETTINGS_HOME;
  process.env.ATOMIC_SETTINGS_HOME = join(tmpDir, "home");
});

afterEach(async () => {
  if (previousSettingsHome === undefined) {
    delete process.env.ATOMIC_SETTINGS_HOME;
  } else {
    process.env.ATOMIC_SETTINGS_HOME = previousSettingsHome;
  }
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeAtomicConfig(
  projectRoot: string,
  config: Record<string, unknown>,
): Promise<void> {
  const dir = join(projectRoot, ".atomic");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "settings.json"), JSON.stringify(config));
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// copilotScmDisableFlags (pure)
// ---------------------------------------------------------------------------

describe("copilotScmDisableFlags", () => {
  test("returns [] when scm is undefined", () => {
    expect(copilotScmDisableFlags(undefined)).toEqual([]);
  });

  test("disables only azure-devops when scm is github (workspace github-mcp-server overrides the built-in)", () => {
    expect(copilotScmDisableFlags("github")).toEqual([
      "--disable-mcp-server",
      "azure-devops",
    ]);
  });

  test("disables github-mcp-server when scm is azure-devops", () => {
    expect(copilotScmDisableFlags("azure-devops")).toEqual([
      "--disable-mcp-server",
      "github-mcp-server",
    ]);
  });

  test("disables github-mcp-server and azure-devops when scm is sapling", () => {
    expect(copilotScmDisableFlags("sapling")).toEqual([
      "--disable-mcp-server",
      "github-mcp-server",
      "--disable-mcp-server",
      "azure-devops",
    ]);
  });
});

// ---------------------------------------------------------------------------
// getCopilotScmDisableFlags (reads atomic config)
// ---------------------------------------------------------------------------

describe("getCopilotScmDisableFlags", () => {
  test("returns [] when project has no atomic config", async () => {
    const projectRoot = join(tmpDir, "no-config");
    await mkdir(projectRoot, { recursive: true });
    expect(await getCopilotScmDisableFlags(projectRoot)).toEqual([]);
  });

  test("returns flags derived from the project's scm selection", async () => {
    const projectRoot = join(tmpDir, "with-scm");
    await mkdir(projectRoot, { recursive: true });
    await writeAtomicConfig(projectRoot, { scm: "github" });

    expect(await getCopilotScmDisableFlags(projectRoot)).toEqual([
      "--disable-mcp-server",
      "azure-devops",
    ]);
  });

  test("returns [] when atomic config has no scm field", async () => {
    const projectRoot = join(tmpDir, "no-scm");
    await mkdir(projectRoot, { recursive: true });
    await writeAtomicConfig(projectRoot, { version: 1 });
    expect(await getCopilotScmDisableFlags(projectRoot)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// syncScmMcpServers — Claude settings
// ---------------------------------------------------------------------------

describe("syncScmMcpServers — Claude settings", () => {
  async function writeClaudeSettings(
    projectRoot: string,
    settings: Record<string, unknown>,
  ): Promise<void> {
    const dir = join(projectRoot, ".claude");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "settings.json"), JSON.stringify(settings));
  }

  test("adds azure-devops to disabledMcpjsonServers when scm is github", async () => {
    const projectRoot = join(tmpDir, "claude-gh");
    await mkdir(projectRoot, { recursive: true });
    await writeAtomicConfig(projectRoot, { scm: "github" });
    await writeClaudeSettings(projectRoot, {});

    await syncScmMcpServers(projectRoot);

    const settings = await readJsonFile(
      join(projectRoot, ".claude", "settings.json"),
    );
    expect(settings.disabledMcpjsonServers).toEqual(["azure-devops"]);
  });

  test("adds github-mcp-server to disabledMcpjsonServers when scm is azure-devops", async () => {
    const projectRoot = join(tmpDir, "claude-ado");
    await mkdir(projectRoot, { recursive: true });
    await writeAtomicConfig(projectRoot, { scm: "azure-devops" });
    await writeClaudeSettings(projectRoot, {});

    await syncScmMcpServers(projectRoot);

    const settings = await readJsonFile(
      join(projectRoot, ".claude", "settings.json"),
    );
    expect(settings.disabledMcpjsonServers).toEqual(["github-mcp-server"]);
  });

  test("preserves unrelated entries in disabledMcpjsonServers", async () => {
    const projectRoot = join(tmpDir, "claude-preserve");
    await mkdir(projectRoot, { recursive: true });
    await writeAtomicConfig(projectRoot, { scm: "github" });
    await writeClaudeSettings(projectRoot, {
      disabledMcpjsonServers: ["custom-server", "azure-devops"],
      otherKey: "preserved",
    });

    await syncScmMcpServers(projectRoot);

    const settings = await readJsonFile(
      join(projectRoot, ".claude", "settings.json"),
    );
    expect(settings.disabledMcpjsonServers).toEqual([
      "custom-server",
      "azure-devops",
    ]);
    expect(settings.otherKey).toBe("preserved");
  });

  test("removes stale SCM entries when scm selection changes", async () => {
    const projectRoot = join(tmpDir, "claude-switch");
    await mkdir(projectRoot, { recursive: true });
    await writeAtomicConfig(projectRoot, { scm: "azure-devops" });
    await writeClaudeSettings(projectRoot, {
      disabledMcpjsonServers: ["azure-devops"],
    });

    await syncScmMcpServers(projectRoot);

    const settings = await readJsonFile(
      join(projectRoot, ".claude", "settings.json"),
    );
    expect(settings.disabledMcpjsonServers).toEqual(["github-mcp-server"]);
  });

  test("no-ops when the resulting array matches existing", async () => {
    const projectRoot = join(tmpDir, "claude-noop");
    await mkdir(projectRoot, { recursive: true });
    await writeAtomicConfig(projectRoot, { scm: "github" });
    await writeClaudeSettings(projectRoot, {
      disabledMcpjsonServers: ["azure-devops"],
    });
    const path = join(projectRoot, ".claude", "settings.json");
    const originalRaw = await readFile(path, "utf8");

    await syncScmMcpServers(projectRoot);

    // Byte-identical — writeJson formats, so equality here means no write.
    const afterRaw = await readFile(path, "utf8");
    expect(afterRaw).toBe(originalRaw);
  });

  test("rewrites array to drop non-string entries when SCM changes require an update", async () => {
    const projectRoot = join(tmpDir, "claude-mixed");
    await mkdir(projectRoot, { recursive: true });
    await writeAtomicConfig(projectRoot, { scm: "azure-devops" });
    await writeClaudeSettings(projectRoot, {
      disabledMcpjsonServers: ["keep", 42, null, "azure-devops"],
    });

    await syncScmMcpServers(projectRoot);

    const settings = await readJsonFile(
      join(projectRoot, ".claude", "settings.json"),
    );
    expect(settings.disabledMcpjsonServers).toEqual(["keep", "github-mcp-server"]);
  });

  test("skips when .claude/settings.json does not exist", async () => {
    const projectRoot = join(tmpDir, "claude-missing");
    await mkdir(projectRoot, { recursive: true });
    await writeAtomicConfig(projectRoot, { scm: "github" });

    await syncScmMcpServers(projectRoot);

    // Should not have created the file.
    const exists = await Bun.file(
      join(projectRoot, ".claude", "settings.json"),
    ).exists();
    expect(exists).toBe(false);
  });

  test("skips when .claude/settings.json is invalid JSON", async () => {
    const projectRoot = join(tmpDir, "claude-invalid");
    await mkdir(projectRoot, { recursive: true });
    await writeAtomicConfig(projectRoot, { scm: "github" });
    const dir = join(projectRoot, ".claude");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "settings.json");
    await writeFile(path, "{ not json");

    await syncScmMcpServers(projectRoot);

    // File should be untouched (still invalid).
    const raw = await readFile(path, "utf8");
    expect(raw).toBe("{ not json");
  });

  test("skips when .claude/settings.json is a JSON array (not an object)", async () => {
    const projectRoot = join(tmpDir, "claude-array");
    await mkdir(projectRoot, { recursive: true });
    await writeAtomicConfig(projectRoot, { scm: "github" });
    const dir = join(projectRoot, ".claude");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "settings.json");
    await writeFile(path, "[1,2,3]");

    await syncScmMcpServers(projectRoot);

    const raw = await readFile(path, "utf8");
    expect(raw).toBe("[1,2,3]");
  });
});

// ---------------------------------------------------------------------------
// syncScmMcpServers — OpenCode settings
// ---------------------------------------------------------------------------

describe("syncScmMcpServers — OpenCode settings", () => {
  async function writeOpencodeConfig(
    projectRoot: string,
    config: Record<string, unknown>,
  ): Promise<void> {
    const dir = join(projectRoot, ".opencode");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "opencode.json"), JSON.stringify(config));
  }

  test("enables github-mcp-server and disables azure-devops when scm is github", async () => {
    const projectRoot = join(tmpDir, "oc-gh");
    await mkdir(projectRoot, { recursive: true });
    await writeAtomicConfig(projectRoot, { scm: "github" });
    await writeOpencodeConfig(projectRoot, {
      mcp: {
        "github-mcp-server": { enabled: false, type: "local" },
        "azure-devops": { enabled: true, type: "local" },
      },
    });

    await syncScmMcpServers(projectRoot);

    const config = await readJsonFile(
      join(projectRoot, ".opencode", "opencode.json"),
    );
    const mcp = (config.mcp ?? {}) as Record<string, { enabled?: boolean }>;
    expect(mcp["github-mcp-server"]?.enabled).toBe(true);
    expect(mcp["azure-devops"]?.enabled).toBe(false);
  });

  test("disables both when scm is sapling", async () => {
    const projectRoot = join(tmpDir, "oc-sl");
    await mkdir(projectRoot, { recursive: true });
    await writeAtomicConfig(projectRoot, { scm: "sapling" });
    await writeOpencodeConfig(projectRoot, {
      mcp: {
        "github-mcp-server": { enabled: true },
        "azure-devops": { enabled: true },
      },
    });

    await syncScmMcpServers(projectRoot);

    const config = await readJsonFile(
      join(projectRoot, ".opencode", "opencode.json"),
    );
    const mcp = (config.mcp ?? {}) as Record<string, { enabled?: boolean }>;
    expect(mcp["github-mcp-server"]?.enabled).toBe(false);
    expect(mcp["azure-devops"]?.enabled).toBe(false);
  });

  test("does not touch unrelated mcp servers", async () => {
    const projectRoot = join(tmpDir, "oc-other");
    await mkdir(projectRoot, { recursive: true });
    await writeAtomicConfig(projectRoot, { scm: "github" });
    await writeOpencodeConfig(projectRoot, {
      mcp: {
        "github-mcp-server": { enabled: false },
        "custom-server": { enabled: true, command: "x" },
      },
    });

    await syncScmMcpServers(projectRoot);

    const config = await readJsonFile(
      join(projectRoot, ".opencode", "opencode.json"),
    );
    const mcp = config.mcp as Record<string, Record<string, unknown>>;
    expect(mcp["github-mcp-server"]?.enabled).toBe(true);
    expect(mcp["custom-server"]).toEqual({ enabled: true, command: "x" });
  });

  test("does not add server definitions that don't already exist", async () => {
    const projectRoot = join(tmpDir, "oc-missing-srv");
    await mkdir(projectRoot, { recursive: true });
    await writeAtomicConfig(projectRoot, { scm: "github" });
    await writeOpencodeConfig(projectRoot, { mcp: {} });

    await syncScmMcpServers(projectRoot);

    const config = await readJsonFile(
      join(projectRoot, ".opencode", "opencode.json"),
    );
    expect(config.mcp).toEqual({});
  });

  test("no-ops when flags already match desired state", async () => {
    const projectRoot = join(tmpDir, "oc-noop");
    await mkdir(projectRoot, { recursive: true });
    await writeAtomicConfig(projectRoot, { scm: "github" });
    await writeOpencodeConfig(projectRoot, {
      mcp: {
        "github-mcp-server": { enabled: true },
        "azure-devops": { enabled: false },
      },
    });
    const path = join(projectRoot, ".opencode", "opencode.json");
    const originalRaw = await readFile(path, "utf8");

    await syncScmMcpServers(projectRoot);

    const afterRaw = await readFile(path, "utf8");
    expect(afterRaw).toBe(originalRaw);
  });

  test("skips when mcp field is missing or malformed", async () => {
    const projectRoot = join(tmpDir, "oc-no-mcp");
    await mkdir(projectRoot, { recursive: true });
    await writeAtomicConfig(projectRoot, { scm: "github" });
    await writeOpencodeConfig(projectRoot, { mcp: [1, 2, 3] });
    const path = join(projectRoot, ".opencode", "opencode.json");
    const originalRaw = await readFile(path, "utf8");

    await syncScmMcpServers(projectRoot);

    expect(await readFile(path, "utf8")).toBe(originalRaw);
  });

  test("skips server entries that are not objects", async () => {
    const projectRoot = join(tmpDir, "oc-bad-entry");
    await mkdir(projectRoot, { recursive: true });
    await writeAtomicConfig(projectRoot, { scm: "github" });
    await writeOpencodeConfig(projectRoot, {
      mcp: {
        "github-mcp-server": "not-an-object",
        "azure-devops": { enabled: true },
      },
    });

    await syncScmMcpServers(projectRoot);

    const config = await readJsonFile(
      join(projectRoot, ".opencode", "opencode.json"),
    );
    const mcp = config.mcp as Record<string, unknown>;
    expect(mcp["github-mcp-server"]).toBe("not-an-object");
    expect((mcp["azure-devops"] as { enabled: boolean }).enabled).toBe(false);
  });

  test("skips when .opencode/opencode.json does not exist", async () => {
    const projectRoot = join(tmpDir, "oc-missing");
    await mkdir(projectRoot, { recursive: true });
    await writeAtomicConfig(projectRoot, { scm: "github" });

    await syncScmMcpServers(projectRoot);

    const exists = await Bun.file(
      join(projectRoot, ".opencode", "opencode.json"),
    ).exists();
    expect(exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// syncScmMcpServers — top-level behavior
// ---------------------------------------------------------------------------

describe("syncScmMcpServers — top-level", () => {
  test("no-ops when atomic config is absent", async () => {
    const projectRoot = join(tmpDir, "no-config-top");
    await mkdir(projectRoot, { recursive: true });
    // Put a claude settings file to prove it's not touched.
    const claudeDir = join(projectRoot, ".claude");
    await mkdir(claudeDir, { recursive: true });
    const path = join(claudeDir, "settings.json");
    await writeFile(path, JSON.stringify({ disabledMcpjsonServers: [] }));
    const originalRaw = await readFile(path, "utf8");

    await syncScmMcpServers(projectRoot);

    expect(await readFile(path, "utf8")).toBe(originalRaw);
  });

  test("no-ops when scm is unset in atomic config", async () => {
    const projectRoot = join(tmpDir, "no-scm-top");
    await mkdir(projectRoot, { recursive: true });
    await writeAtomicConfig(projectRoot, { version: 1 });
    const claudeDir = join(projectRoot, ".claude");
    await mkdir(claudeDir, { recursive: true });
    const path = join(claudeDir, "settings.json");
    await writeFile(path, JSON.stringify({ disabledMcpjsonServers: [] }));
    const originalRaw = await readFile(path, "utf8");

    await syncScmMcpServers(projectRoot);

    expect(await readFile(path, "utf8")).toBe(originalRaw);
  });

  test("swallows errors rather than throwing", async () => {
    // projectRoot that does not exist — readAtomicConfig must still resolve,
    // and syncScmMcpServers must not throw regardless.
    const projectRoot = join(tmpDir, "does-not-exist");
    expect(await syncScmMcpServers(projectRoot)).toBeUndefined();
  });
});
