/**
 * Unit tests for `atomic workflow read`.
 *
 * Strategy: drive a real tempdir laid out as `~/.atomic/sessions/<runId>/...`
 * and point the command at it via injected `sessionsBaseDir`. This exercises
 * the actual `readdir` / `stat` / glob path the runtime uses, not a mock —
 * cheaper than spinning up a workflow and far harder to drift from on-disk
 * reality.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readdir, stat } from "node:fs/promises";
import {
  workflowReadCommand,
  resolveRunId,
  formatSize,
  defaultDeps as readDefaultDeps,
  type WorkflowReadDeps,
  type ReadJsonPayload,
  type ReadJsonError,
} from "./workflow-read.ts";

// ─── Output capture ──────────────────────────────────────────────────────────

interface Captured {
  stdout: string;
  stderr: string;
  restore: () => void;
}

function captureOutput(): Captured {
  const c: Captured = { stdout: "", stderr: "", restore: () => {} };
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    c.stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    c.stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
  c.restore = () => {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  };
  return c;
}

// ─── Color disable ───────────────────────────────────────────────────────────

let originalNoColor: string | undefined;
beforeAll(() => {
  originalNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
});
afterAll(() => {
  if (originalNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = originalNoColor;
});

// ─── Fixture builder ─────────────────────────────────────────────────────────

let tmpRoot: string;
let sessionsDir: string;
const RUN_ID = "a1b2c3d4";
const STAGE_NAME = "scout";
const STAGE_SUFFIX = "9f8e7d6c";
const STAGE_DIR_NAME = `${STAGE_NAME}-${STAGE_SUFFIX}`;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "atomic-wf-read-test-"));
  sessionsDir = join(tmpRoot, "sessions");

  // Run dir with stage subdir + run-level files
  const runDir = join(sessionsDir, RUN_ID);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "status.json"), JSON.stringify({ overall: "in_progress" }));
  await writeFile(join(runDir, "metadata.json"), JSON.stringify({ workflow: "demo" }));
  await writeFile(join(runDir, "orchestrator.log"), "log line\n");

  const stageDir = join(runDir, STAGE_DIR_NAME);
  await mkdir(stageDir, { recursive: true });
  await writeFile(join(stageDir, "metadata.json"), JSON.stringify({ name: STAGE_NAME }));
  await writeFile(join(stageDir, "messages.json"), JSON.stringify([{ role: "user", text: "hi" }]));
  await writeFile(join(stageDir, "inbox.md"), "# inbox\n\nhi");

  // A second stage so the run-level "stages" listing has more than one entry
  await mkdir(join(runDir, "explore-1a2b3c4d"), { recursive: true });
  await writeFile(join(runDir, "explore-1a2b3c4d", "messages.json"), "[]");
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ─── Dep factory ─────────────────────────────────────────────────────────────

function makeDeps(envOverrides: Record<string, string> = {}): WorkflowReadDeps {
  return {
    sessionsBaseDir: () => sessionsDir,
    env: (name) => envOverrides[name],
    readdir,
    stat,
  };
}

let captured: Captured;
beforeEach(() => { captured = captureOutput(); });
afterEach(() => { captured.restore(); });

// ─── resolveRunId unit tests ─────────────────────────────────────────────────

describe("resolveRunId", () => {
  test("accepts a bare 8-hex run id", () => {
    expect(resolveRunId("a1b2c3d4")).toBe("a1b2c3d4");
  });

  test("normalises uppercase hex to lowercase", () => {
    expect(resolveRunId("A1B2C3D4")).toBe("a1b2c3d4");
  });

  test("extracts run id from a full tmux name", () => {
    expect(resolveRunId("atomic-wf-claude-ralph-a1b2c3d4")).toBe("a1b2c3d4");
  });

  test("rejects non-atomic-wf names", () => {
    expect(resolveRunId("nginx-server")).toBe(null);
  });

  test("rejects malformed run ids (wrong length)", () => {
    expect(resolveRunId("a1b2c3")).toBe(null);
  });

  test("rejects non-hex characters", () => {
    expect(resolveRunId("zzzzzzzz")).toBe(null);
  });
});

// ─── formatSize unit tests ───────────────────────────────────────────────────

describe("formatSize", () => {
  test("bytes under 1024 stay as B", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(512)).toBe("512 B");
  });

  test("KB / MB / GB units scale and use one decimal", () => {
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatSize(1024 * 1024 * 1024)).toBe("1.0 GB");
  });

  test("negative or non-finite values render as em-dash", () => {
    expect(formatSize(-1)).toBe("—");
    expect(formatSize(Number.NaN)).toBe("—");
  });
});

// ─── workflowReadCommand: happy paths ────────────────────────────────────────

describe("workflowReadCommand — happy paths", () => {
  test("run dir lookup by bare run id returns path + files + stages", async () => {
    const code = await workflowReadCommand(
      { sessionId: RUN_ID, format: "json" },
      makeDeps(),
    );
    expect(code).toBe(0);
    const payload: ReadJsonPayload = JSON.parse(captured.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.runId).toBe(RUN_ID);
    expect(payload.path).toBe(join(sessionsDir, RUN_ID));
    expect(payload.stageName).toBeUndefined();
    expect(payload.stages).toEqual(["explore", "scout"]);

    // Files should include the stage dirs (kind=dir) and run-level files (kind=file).
    const fileNames = payload.files.map((f) => f.name);
    expect(fileNames).toContain("status.json");
    expect(fileNames).toContain("metadata.json");
    expect(fileNames).toContain(STAGE_DIR_NAME);
  });

  test("run dir lookup by full tmux name resolves to the same run id", async () => {
    const code = await workflowReadCommand(
      { sessionId: `atomic-wf-claude-ralph-${RUN_ID}`, format: "json" },
      makeDeps(),
    );
    expect(code).toBe(0);
    const payload: ReadJsonPayload = JSON.parse(captured.stdout);
    expect(payload.runId).toBe(RUN_ID);
  });

  test("stage lookup resolves the <name>-<8hex> dir and lists stage files", async () => {
    const code = await workflowReadCommand(
      { sessionId: RUN_ID, stageId: STAGE_NAME, format: "json" },
      makeDeps(),
    );
    expect(code).toBe(0);
    const payload: ReadJsonPayload = JSON.parse(captured.stdout);
    expect(payload.stageName).toBe(STAGE_NAME);
    expect(payload.path).toBe(join(sessionsDir, RUN_ID, STAGE_DIR_NAME));
    const names = payload.files.map((f) => f.name);
    expect(names).toEqual(["inbox.md", "messages.json", "metadata.json"]);
    // Sizes are populated on file entries.
    for (const f of payload.files) {
      expect(f.kind).toBe("file");
      expect(typeof f.size).toBe("number");
    }
  });
});

// ─── workflowReadCommand: error paths ────────────────────────────────────────

describe("workflowReadCommand — error paths", () => {
  test("missing --sessionId returns exit 1 with helpful hint (json envelope)", async () => {
    const code = await workflowReadCommand({ format: "json" }, makeDeps());
    expect(code).toBe(1);
    const payload: ReadJsonError = JSON.parse(captured.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("--sessionId");
    expect(payload.hint).toBeDefined();
  });

  test("malformed sessionId returns exit 1", async () => {
    const code = await workflowReadCommand(
      { sessionId: "not-a-real-name", format: "json" },
      makeDeps(),
    );
    expect(code).toBe(1);
    const payload: ReadJsonError = JSON.parse(captured.stdout);
    expect(payload.error).toContain("not-a-real-name");
  });

  test("nonexistent run dir returns exit 1", async () => {
    const code = await workflowReadCommand(
      { sessionId: "deadbeef", format: "json" },
      makeDeps(),
    );
    expect(code).toBe(1);
    const payload: ReadJsonError = JSON.parse(captured.stdout);
    expect(payload.error).toContain("no session directory");
  });

  test("missing stage returns exit 1 + lists available stages as candidates", async () => {
    const code = await workflowReadCommand(
      { sessionId: RUN_ID, stageId: "nonexistent", format: "json" },
      makeDeps(),
    );
    expect(code).toBe(1);
    const payload: ReadJsonError = JSON.parse(captured.stdout);
    expect(payload.error).toContain("nonexistent");
    expect(payload.hint).toContain("scout");
    expect(payload.hint).toContain("explore");
  });

  test("stage with similar prefix doesn't match (regex anchors on -<8hex>)", async () => {
    // `scou` is a prefix of `scout`; the regex requires the full name.
    const code = await workflowReadCommand(
      { sessionId: RUN_ID, stageId: "scou", format: "json" },
      makeDeps(),
    );
    expect(code).toBe(1);
    const payload: ReadJsonError = JSON.parse(captured.stdout);
    expect(payload.error).toContain('"scou"');
  });

  test("text-format errors go to stderr, not stdout", async () => {
    const code = await workflowReadCommand(
      { sessionId: "deadbeef", format: "text" },
      makeDeps(),
    );
    expect(code).toBe(1);
    expect(captured.stderr).toContain("no session directory");
    expect(captured.stdout).toBe("");
  });

  test("text-format renders hint line when failure has a hint", async () => {
    const code = await workflowReadCommand(
      { format: "text" }, // no sessionId → triggers hint
      makeDeps(),
    );
    expect(code).toBe(1);
    expect(captured.stderr).toContain("--sessionId");
    expect(captured.stderr).toContain("Hint");
  });

  test("missing stage in a run with no stage subdirs reports empty-candidates hint", async () => {
    // Build a fresh run dir with only run-level files (no stage subdirs).
    const emptyRunId = "deadbee0";
    const emptyRunDir = join(sessionsDir, emptyRunId);
    await mkdir(emptyRunDir, { recursive: true });
    await writeFile(join(emptyRunDir, "status.json"), "{}");

    const code = await workflowReadCommand(
      { sessionId: emptyRunId, stageId: "any-stage", format: "json" },
      makeDeps(),
    );
    expect(code).toBe(1);
    const payload: ReadJsonError = JSON.parse(captured.stdout);
    expect(payload.hint).toContain("no stage subdirectories");
  });
});

// ─── defaultDeps unit tests ──────────────────────────────────────────────────

describe("defaultDeps", () => {
  test("sessionsBaseDir resolves under the user's home directory", () => {
    const path = readDefaultDeps.sessionsBaseDir();
    expect(path).toContain(".atomic");
    expect(path).toContain("sessions");
  });

  test("env(name) reads from process.env", () => {
    const original = process.env.ATOMIC_READ_DEPS_TEST;
    process.env.ATOMIC_READ_DEPS_TEST = "ok";
    try {
      expect(readDefaultDeps.env("ATOMIC_READ_DEPS_TEST")).toBe("ok");
    } finally {
      if (original === undefined) delete process.env.ATOMIC_READ_DEPS_TEST;
      else process.env.ATOMIC_READ_DEPS_TEST = original;
    }
  });
});

// ─── workflowReadCommand: format auto-detection ──────────────────────────────

describe("workflowReadCommand — format resolution", () => {
  test("ATOMIC_AGENT in env defaults to json", async () => {
    const code = await workflowReadCommand(
      { sessionId: RUN_ID },
      makeDeps({ ATOMIC_AGENT: "claude" }),
    );
    expect(code).toBe(0);
    expect(() => JSON.parse(captured.stdout)).not.toThrow();
  });

  test("no ATOMIC_AGENT defaults to text", async () => {
    const code = await workflowReadCommand({ sessionId: RUN_ID }, makeDeps());
    expect(code).toBe(0);
    expect(() => JSON.parse(captured.stdout)).toThrow();
    // Text format puts the path on its own labelled line.
    expect(captured.stdout).toMatch(/path\s+·\s+/);
    expect(captured.stdout).toContain(RUN_ID);
  });

  test("explicit --format=text wins over ATOMIC_AGENT", async () => {
    const code = await workflowReadCommand(
      { sessionId: RUN_ID, format: "text" },
      makeDeps({ ATOMIC_AGENT: "claude" }),
    );
    expect(code).toBe(0);
    expect(captured.stdout).toMatch(/path\s+·\s+/);
  });
});

// ─── workflowReadCommand: text output structure ──────────────────────────────

describe("workflowReadCommand — text output", () => {
  test("stage lookup includes stage / run / path / files lines", async () => {
    await workflowReadCommand(
      { sessionId: RUN_ID, stageId: STAGE_NAME, format: "text" },
      makeDeps(),
    );
    expect(captured.stdout).toMatch(/stage\s+·\s+scout/);
    expect(captured.stdout).toMatch(/run\s+·\s+a1b2c3d4/);
    expect(captured.stdout).toMatch(/path\s+·\s+/);
    expect(captured.stdout).toContain("messages.json");
    expect(captured.stdout).toContain("inbox.md");
  });

  test("run dir lookup splits stages from run-level files", async () => {
    await workflowReadCommand(
      { sessionId: RUN_ID, format: "text" },
      makeDeps(),
    );
    expect(captured.stdout).toContain("stages");
    expect(captured.stdout).toContain("scout");
    expect(captured.stdout).toContain("explore");
    expect(captured.stdout).toContain("status.json");
    // Stage dirs should NOT appear in the run-level files list (they have
    // already been pulled into the `stages` section).
    expect(captured.stdout).not.toContain(STAGE_DIR_NAME);
  });
});
