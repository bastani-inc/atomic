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
import { seedGlobalProviderEnvVars } from "../../../src/services/config/settings.ts";

let tmpDir: string;
let previousSettingsHome: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "settings-seed-envvars-test-"));
  previousSettingsHome = process.env.ATOMIC_SETTINGS_HOME;
  process.env.ATOMIC_SETTINGS_HOME = tmpDir;
});

afterEach(async () => {
  if (previousSettingsHome === undefined) {
    delete process.env.ATOMIC_SETTINGS_HOME;
  } else {
    process.env.ATOMIC_SETTINGS_HOME = previousSettingsHome;
  }
  await rm(tmpDir, { recursive: true, force: true });
});

function settingsPath(): string {
  return join(tmpDir, ".atomic", "settings.json");
}

async function writeGlobalSettings(value: Record<string, unknown>): Promise<void> {
  const dir = join(tmpDir, ".atomic");
  await mkdir(dir, { recursive: true });
  await writeFile(settingsPath(), JSON.stringify(value));
}

async function readGlobalSettings(): Promise<Record<string, unknown>> {
  const raw = await readFile(settingsPath(), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("seedGlobalProviderEnvVars", () => {
  test("seeds COLORTERM=truecolor into every provider when settings.json is missing", async () => {
    await seedGlobalProviderEnvVars();

    const settings = await readGlobalSettings();
    const providers = settings.providers as Record<
      string,
      { envVars?: Record<string, string> }
    >;
    expect(providers.claude?.envVars?.COLORTERM).toBe("truecolor");
    expect(providers.opencode?.envVars?.COLORTERM).toBe("truecolor");
    expect(providers.copilot?.envVars?.COLORTERM).toBe("truecolor");
  });

  test("seeds COLORTERM into all providers when settings.json exists without providers", async () => {
    await writeGlobalSettings({ version: 1, scm: "github" });

    await seedGlobalProviderEnvVars();

    const settings = await readGlobalSettings();
    expect(settings.scm).toBe("github");
    const providers = settings.providers as Record<
      string,
      { envVars?: Record<string, string> }
    >;
    expect(providers.claude?.envVars?.COLORTERM).toBe("truecolor");
    expect(providers.opencode?.envVars?.COLORTERM).toBe("truecolor");
    expect(providers.copilot?.envVars?.COLORTERM).toBe("truecolor");
  });

  test("is idempotent on a second run", async () => {
    await seedGlobalProviderEnvVars();
    const firstWrite = await readFile(settingsPath(), "utf8");

    await seedGlobalProviderEnvVars();
    const secondWrite = await readFile(settingsPath(), "utf8");

    expect(secondWrite).toBe(firstWrite);
  });

  test("preserves a user-set COLORTERM value (e.g. '256color')", async () => {
    await writeGlobalSettings({
      version: 1,
      providers: {
        claude: { envVars: { COLORTERM: "256color" } },
      },
    });

    await seedGlobalProviderEnvVars();

    const settings = await readGlobalSettings();
    const providers = settings.providers as Record<
      string,
      { envVars?: Record<string, string> }
    >;
    expect(providers.claude?.envVars?.COLORTERM).toBe("256color");
    expect(providers.opencode?.envVars?.COLORTERM).toBe("truecolor");
    expect(providers.copilot?.envVars?.COLORTERM).toBe("truecolor");
  });

  test("preserves an explicit empty-string COLORTERM override", async () => {
    await writeGlobalSettings({
      version: 1,
      providers: {
        opencode: { envVars: { COLORTERM: "" } },
      },
    });

    await seedGlobalProviderEnvVars();

    const settings = await readGlobalSettings();
    const providers = settings.providers as Record<
      string,
      { envVars?: Record<string, string> }
    >;
    expect(providers.opencode?.envVars?.COLORTERM).toBe("");
  });

  test("preserves unrelated envVars and chatFlags on the same provider", async () => {
    await writeGlobalSettings({
      version: 1,
      providers: {
        claude: {
          chatFlags: ["--print"],
          envVars: { ANTHROPIC_API_KEY: "sk-test" },
        },
      },
    });

    await seedGlobalProviderEnvVars();

    const settings = await readGlobalSettings();
    const claude = (settings.providers as Record<string, {
      chatFlags?: string[];
      envVars?: Record<string, string>;
    }>).claude;
    expect(claude?.chatFlags).toEqual(["--print"]);
    expect(claude?.envVars?.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(claude?.envVars?.COLORTERM).toBe("truecolor");
  });

  test("seeds CLAUDE_CODE_TMUX_TRUECOLOR=1 only on the claude provider", async () => {
    await seedGlobalProviderEnvVars();

    const settings = await readGlobalSettings();
    const providers = settings.providers as Record<
      string,
      { envVars?: Record<string, string> }
    >;
    expect(providers.claude?.envVars?.CLAUDE_CODE_TMUX_TRUECOLOR).toBe("1");
    expect(providers.opencode?.envVars).not.toHaveProperty(
      "CLAUDE_CODE_TMUX_TRUECOLOR",
    );
    expect(providers.copilot?.envVars).not.toHaveProperty(
      "CLAUDE_CODE_TMUX_TRUECOLOR",
    );
  });

  test("preserves a user-set CLAUDE_CODE_TMUX_TRUECOLOR override", async () => {
    await writeGlobalSettings({
      version: 1,
      providers: {
        claude: { envVars: { CLAUDE_CODE_TMUX_TRUECOLOR: "" } },
      },
    });

    await seedGlobalProviderEnvVars();

    const settings = await readGlobalSettings();
    const providers = settings.providers as Record<
      string,
      { envVars?: Record<string, string> }
    >;
    expect(providers.claude?.envVars?.CLAUDE_CODE_TMUX_TRUECOLOR).toBe("");
    // COLORTERM should still be seeded alongside it
    expect(providers.claude?.envVars?.COLORTERM).toBe("truecolor");
  });
});
