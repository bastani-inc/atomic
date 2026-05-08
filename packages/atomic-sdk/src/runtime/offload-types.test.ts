import { test, expect } from "bun:test";
import type { MetadataJsonWithResume, OffloadResumeMetadata } from "./offload-types.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const validResume: OffloadResumeMetadata = {
  schemaVersion: 1,
  agentSessionId: "9f3a8f1d-1c0e-4b1f-9a2f-5e7d8b0e1a23",
  tmuxSessionName: "atomic-7f3a2c1d",
  tmuxWindowName: "review",
  spawnEnv: { CLAUDECODE: "1" },
  spawnCwd: "/home/user/projects/foo",
  lastPrompt: "Look at the diff and propose fixes",
  lastSeenAt: 1_717_804_900_000,
  offloadedAt: null,
};

const baseMetadata: MetadataJsonWithResume = {
  name: "review",
  description: "Review code changes",
  agent: "claude",
  paneId: "%7",
  serverUrl: "",
  port: 0,
  startedAt: new Date(1_717_804_800_000).toISOString(),
};

// ─── serialization round-trips ───────────────────────────────────────────────

test("OffloadResumeMetadata survives JSON round-trip", () => {
  const serialized = JSON.stringify(validResume);
  const parsed = JSON.parse(serialized) as OffloadResumeMetadata;

  expect(parsed.schemaVersion).toBe(1);
  expect(parsed.agentSessionId).toBe(validResume.agentSessionId);
  expect(parsed.tmuxSessionName).toBe(validResume.tmuxSessionName);
  expect(parsed.tmuxWindowName).toBe(validResume.tmuxWindowName);
  expect(parsed.spawnEnv).toEqual(validResume.spawnEnv);
  expect(parsed.spawnCwd).toBe(validResume.spawnCwd);
  expect(parsed.lastPrompt).toBe(validResume.lastPrompt);
  expect(parsed.lastSeenAt).toBe(validResume.lastSeenAt);
  expect(parsed.offloadedAt).toBeNull();
  expect(parsed.error).toBeUndefined();
});

test("OffloadResumeMetadata with offloadedAt timestamp survives round-trip", () => {
  const offloaded: OffloadResumeMetadata = {
    ...validResume,
    offloadedAt: 1_717_805_000_000,
  };

  const parsed = JSON.parse(JSON.stringify(offloaded)) as OffloadResumeMetadata;

  expect(parsed.offloadedAt).toBe(1_717_805_000_000);
});

test("OffloadResumeMetadata with error field survives round-trip", () => {
  const withError: OffloadResumeMetadata = {
    ...validResume,
    offloadedAt: 1_717_805_000_000,
    error: "ENOENT: agent binary not found",
  };

  const parsed = JSON.parse(JSON.stringify(withError)) as OffloadResumeMetadata;

  expect(parsed.error).toBe("ENOENT: agent binary not found");
});

// ─── MetadataJsonWithResume — immutable top-level fields survive ─────────────

test("top-level immutable fields survive when resume is added", () => {
  const withResume: MetadataJsonWithResume = {
    ...baseMetadata,
    resume: validResume,
  };

  const parsed = JSON.parse(JSON.stringify(withResume)) as MetadataJsonWithResume;

  // Top-level immutable fields unchanged
  expect(parsed.name).toBe("review");
  expect(parsed.description).toBe("Review code changes");
  expect(parsed.agent).toBe("claude");
  expect(parsed.paneId).toBe("%7");
  expect(parsed.serverUrl).toBe("");
  expect(parsed.port).toBe(0);
  expect(parsed.startedAt).toBe(baseMetadata.startedAt);

  // resume sub-object present and correct
  expect(parsed.resume).toBeDefined();
  expect(parsed.resume?.schemaVersion).toBe(1);
  expect(parsed.resume?.agentSessionId).toBe(validResume.agentSessionId);
});

test("top-level immutable fields survive when resume is updated", () => {
  const original: MetadataJsonWithResume = { ...baseMetadata, resume: validResume };

  // Simulate a read-modify-write patch that updates offloadedAt
  const parsed = JSON.parse(JSON.stringify(original)) as MetadataJsonWithResume;
  if (parsed.resume) {
    parsed.resume = { ...parsed.resume, offloadedAt: 1_717_805_500_000 };
  }

  const reparsed = JSON.parse(JSON.stringify(parsed)) as MetadataJsonWithResume;

  // Top-level untouched
  expect(reparsed.name).toBe("review");
  expect(reparsed.agent).toBe("claude");
  expect(reparsed.startedAt).toBe(baseMetadata.startedAt);

  // resume updated
  expect(reparsed.resume?.offloadedAt).toBe(1_717_805_500_000);
});

test("metadata without resume is still valid MetadataJsonWithResume", () => {
  const parsed = JSON.parse(JSON.stringify(baseMetadata)) as MetadataJsonWithResume;

  expect(parsed.resume).toBeUndefined();
  expect(parsed.name).toBe("review");
});

test("spawnEnv survives with multiple keys", () => {
  const multiEnv: OffloadResumeMetadata = {
    ...validResume,
    spawnEnv: { CLAUDECODE: "1", NO_COLOR: "1", TERM: "xterm-256color" },
  };

  const parsed = JSON.parse(JSON.stringify(multiEnv)) as OffloadResumeMetadata;

  expect(parsed.spawnEnv).toEqual({
    CLAUDECODE: "1",
    NO_COLOR: "1",
    TERM: "xterm-256color",
  });
});
