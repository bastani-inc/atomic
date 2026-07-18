import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryDurableBackend,
  type DurableWorkflowBackend,
} from "../../packages/workflows/src/durable/backend.js";
import { deleteDurableWorkflowIfSafe } from "../../packages/workflows/src/durable/retention-policy.js";

function register(
  backend: DurableWorkflowBackend,
  workflowId: string,
  status: "running" | "paused" | "completed",
): void {
  backend.registerWorkflow({
    workflowId,
    name: `flow-${workflowId}`,
    inputs: {},
    createdAt: 1,
    status,
    completedCheckpoints: 1,
  });
}

describe("durable workflow retention policy", () => {
  test("never deletes locally in-flight or authoritatively running workflows", async () => {
    const backend = new InMemoryDurableBackend();
    register(backend, "local-paused", "paused");
    register(backend, "remote-running", "running");

    const local = await deleteDurableWorkflowIfSafe(
      backend,
      "local-paused",
      (workflowId) => workflowId === "local-paused",
    );
    const remote = await deleteDurableWorkflowIfSafe(backend, "remote-running", () => false);

    assert.equal(local.ok, false);
    assert.equal(remote.ok, false);
    assert.equal(backend.getWorkflow("local-paused")?.status, "paused");
    assert.equal(backend.getWorkflow("remote-running")?.status, "running");
  });

  test("deletes only inactive durable state and leaves retained transcripts untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-retention-delete-"));
    try {
      const backend = new InMemoryDurableBackend();
      const transcript = join(dir, "stage.jsonl");
      writeFileSync(transcript, "retained transcript\n");
      register(backend, "inactive", "paused");
      register(backend, "active", "running");

      const inactive = await deleteDurableWorkflowIfSafe(backend, "inactive", () => false);
      const active = await deleteDurableWorkflowIfSafe(backend, "active", () => false);

      assert.equal(inactive.ok, true);
      assert.equal(active.ok, false);
      assert.equal(backend.getWorkflow("inactive"), undefined);
      assert.equal(backend.getWorkflow("active")?.status, "running");
      assert.equal(existsSync(transcript), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports backend deletion failures and preserves the indexed row", async () => {
    class RejectingDeleteBackend extends InMemoryDurableBackend {
      override async deleteWorkflowIfInactive(): Promise<never> {
        throw new Error("delete unavailable");
      }
    }
    const backend = new RejectingDeleteBackend();
    register(backend, "preserved", "completed");

    const outcome = await deleteDurableWorkflowIfSafe(backend, "preserved", () => false);

    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /delete unavailable/);
    assert.equal(backend.getWorkflow("preserved")?.status, "completed");
  });

  test("serializes resume claims against inactive deletion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-retention-race-"));
    try {
      const backend = new InMemoryDurableBackend();
      register(backend, "resume-wins", "paused");
      assert.equal(await backend.transitionWorkflowStatus("resume-wins", ["paused"], "running"), true);
      assert.deepEqual(await backend.deleteWorkflowIfInactive("resume-wins"), {
        ok: false,
        reason: "running",
      });

      register(backend, "delete-wins", "paused");
      assert.deepEqual(await backend.deleteWorkflowIfInactive("delete-wins"), { ok: true });
      assert.equal(await backend.transitionWorkflowStatus("delete-wins", ["paused"], "running"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
