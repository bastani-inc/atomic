import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MetadataJsonWithResume } from "./offload-types.ts";
import { persistResume } from "./offload-manager.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const IMMUTABLES = {
  name: "review",
  description: "Review code changes",
  agent: "claude" as const,
  paneId: "%7",
  serverUrl: "",
  port: 0,
  startedAt: new Date(1_717_804_800_000).toISOString(),
} satisfies Omit<MetadataJsonWithResume, "resume">;

function makeStageDir(): string {
  return mkdtempSync(join(tmpdir(), "atomic-test-"));
}

function writeMetadata(stageDir: string, data: MetadataJsonWithResume): void {
  writeFileSync(join(stageDir, "metadata.json"), JSON.stringify(data, null, 2));
}

function readMetadata(stageDir: string): MetadataJsonWithResume {
  const raw = require("node:fs").readFileSync(join(stageDir, "metadata.json"), "utf8");
  return JSON.parse(raw) as MetadataJsonWithResume;
}

// ─── tracer bullet: basic write ───────────────────────────────────────────────

test("persistResume writes resume sub-object into metadata.json", async () => {
  const dir = makeStageDir();
  writeMetadata(dir, { ...IMMUTABLES });

  await persistResume(dir, {
    agentSessionId: "abc-123",
    tmuxSessionName: "atomic-aabbccdd",
    tmuxWindowName: "review",
    spawnEnv: { CLAUDECODE: "1" },
    spawnCwd: "/home/user/project",
    lastPrompt: "Fix the bug",
    lastSeenAt: 1_717_804_900_000,
    offloadedAt: null,
  });

  const meta = readMetadata(dir);
  expect(meta.resume).toBeDefined();
  expect(meta.resume?.schemaVersion).toBe(1);
  expect(meta.resume?.agentSessionId).toBe("abc-123");
  expect(meta.resume?.offloadedAt).toBeNull();
});

// ─── immutables are preserved ─────────────────────────────────────────────────

test("immutable top-level fields unchanged after persistResume", async () => {
  const dir = makeStageDir();
  writeMetadata(dir, { ...IMMUTABLES });

  const before = readMetadata(dir);

  await persistResume(dir, {
    agentSessionId: "xyz",
    tmuxSessionName: "s",
    tmuxWindowName: "w",
    spawnEnv: {},
    spawnCwd: "/",
    lastPrompt: "p",
    lastSeenAt: 0,
    offloadedAt: null,
  });

  const after = readMetadata(dir);

  expect(after.name).toBe(before.name);
  expect(after.description).toBe(before.description);
  expect(after.agent).toBe(before.agent);
  expect(after.paneId).toBe(before.paneId);
  expect(after.serverUrl).toBe(before.serverUrl);
  expect(after.port).toBe(before.port);
  expect(after.startedAt).toBe(before.startedAt);
});

// ─── patch wins on merge ──────────────────────────────────────────────────────

test("patch fields overwrite existing resume fields", async () => {
  const dir = makeStageDir();
  writeMetadata(dir, {
    ...IMMUTABLES,
    resume: {
      schemaVersion: 1,
      agentSessionId: "old-id",
      tmuxSessionName: "old-session",
      tmuxWindowName: "old-win",
      spawnEnv: {},
      spawnCwd: "/old",
      lastPrompt: "old prompt",
      lastSeenAt: 1000,
      offloadedAt: null,
    },
  });

  await persistResume(dir, { agentSessionId: "new-id", lastSeenAt: 9999 });

  const meta = readMetadata(dir);
  expect(meta.resume?.agentSessionId).toBe("new-id");
  expect(meta.resume?.lastSeenAt).toBe(9999);
  // untouched field retained
  expect(meta.resume?.tmuxSessionName).toBe("old-session");
});

// ─── schema mismatch ─────────────────────────────────────────────────────────

test("throws on unsupported schemaVersion", async () => {
  const dir = makeStageDir();
  const badMeta = {
    ...IMMUTABLES,
    resume: {
      schemaVersion: 2,
      agentSessionId: "",
      tmuxSessionName: "",
      tmuxWindowName: "",
      spawnEnv: {},
      spawnCwd: "",
      lastPrompt: "",
      lastSeenAt: 0,
      offloadedAt: null,
    },
  };
  writeFileSync(join(dir, "metadata.json"), JSON.stringify(badMeta));

  await expect(persistResume(dir, { lastSeenAt: 1 })).rejects.toThrow(
    "unsupported resume schemaVersion: 2",
  );
});

// ─── missing metadata.json ────────────────────────────────────────────────────

test("throws when metadata.json is missing", async () => {
  const dir = makeStageDir();
  // no metadata.json written

  const metaPath = join(dir, "metadata.json");
  await expect(persistResume(dir, { lastSeenAt: 1 })).rejects.toThrow(
    `metadata.json not found at ${metaPath}`,
  );
});

// ─── file mode 0o600 ─────────────────────────────────────────────────────────

test("written file has mode 0o600", async () => {
  const dir = makeStageDir();
  writeMetadata(dir, { ...IMMUTABLES });

  await persistResume(dir, {
    agentSessionId: "id",
    tmuxSessionName: "s",
    tmuxWindowName: "w",
    spawnEnv: {},
    spawnCwd: "/",
    lastPrompt: "p",
    lastSeenAt: 0,
    offloadedAt: null,
  });

  const mode = statSync(join(dir, "metadata.json")).mode & 0o777;
  expect(mode).toBe(0o600);
});

// ─── concurrency: 100 concurrent calls serialize, no lost writes ──────────────

test("100 concurrent persistResume calls for same stageDir all complete", async () => {
  const dir = makeStageDir();
  writeMetadata(dir, { ...IMMUTABLES });

  // Seed initial resume so merges have a base
  await persistResume(dir, {
    agentSessionId: "seed",
    tmuxSessionName: "s",
    tmuxWindowName: "w",
    spawnEnv: {},
    spawnCwd: "/",
    lastPrompt: "seed",
    lastSeenAt: 0,
    offloadedAt: null,
  });

  const N = 100;
  const promises = Array.from({ length: N }, (_, i) =>
    persistResume(dir, { lastSeenAt: i + 1 }),
  );

  await Promise.all(promises);

  // All completed — final file is valid JSON with schemaVersion 1
  const meta = readMetadata(dir);
  expect(meta.resume?.schemaVersion).toBe(1);
  // lastSeenAt should be one of 1..100 (last writer wins, serialized)
  expect(meta.resume?.lastSeenAt).toBeGreaterThanOrEqual(1);
  expect(meta.resume?.lastSeenAt).toBeLessThanOrEqual(N);
  // All immutables intact
  expect(meta.name).toBe(IMMUTABLES.name);
  expect(meta.agent).toBe(IMMUTABLES.agent);
});

// ─── concurrent calls for different stageDirs don't interfere ────────────────

test("concurrent persistResume for different stageDirs complete independently", async () => {
  const dirs = Array.from({ length: 5 }, () => {
    const d = makeStageDir();
    writeMetadata(d, { ...IMMUTABLES });
    return d;
  });

  const promises = dirs.map((d, i) =>
    persistResume(d, {
      agentSessionId: `id-${i}`,
      tmuxSessionName: `s-${i}`,
      tmuxWindowName: `w-${i}`,
      spawnEnv: {},
      spawnCwd: "/",
      lastPrompt: `prompt-${i}`,
      lastSeenAt: i,
      offloadedAt: null,
    }),
  );

  await Promise.all(promises);

  for (let i = 0; i < dirs.length; i++) {
    const meta = readMetadata(dirs[i]!);
    expect(meta.resume?.agentSessionId).toBe(`id-${i}`);
    expect(meta.resume?.lastSeenAt).toBe(i);
  }
});
