import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { PartialAppendFault } from "./session-manager-partial-append-preload.js";
import type { FileEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";

function assistant(content: string, timestamp: number) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: content }],
    api: "anthropic-messages" as const,
    provider: "anthropic",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp,
  };
}

function parsePhysicalEntries(path: string): FileEntry[] {
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  return lines.map((line) => JSON.parse(line) as FileEntry);
}

function assertUniqueIds(entries: readonly FileEntry[]): void {
  const ids = entries.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "physical session ids must remain unique");
}

const root = mkdtempSync(join(tmpdir(), "atomic-session-partial-append-probe-"));
try {
  const laterDir = join(root, "later");
  const later = await SessionManager.create(root, laterDir);
  await later.appendMessage({ role: "user", content: "baseline", timestamp: 1 });
  const baselineId = await later.appendMessage(assistant("baseline reply", 2));
  const laterFile = later.getSessionFile();
  assert.ok(laterFile);
  const beforeFailure = readFileSync(laterFile);

  await assert.rejects(
    async () => await later.appendCustomEntry("partial-fault-later", { marker: "partial-fault-later" }),
    (error) => { assert.ok(error instanceof StorageUnavailableError); assert.ok(error.cause instanceof PartialAppendFault); return true; },
  );
  assert.deepEqual(readFileSync(laterFile), beforeFailure, "failed append must restore exact prior bytes");
  assert.equal(later.getLeafId(), baselineId);
  assert.equal(later.getEntries().some((entry) => entry.type === "custom" && entry.customType === "partial-fault-later"), false);

  const retryId = await later.appendCustomEntry("persisted-retry", { attempt: 2 });
  assert.equal(later.getEntry(retryId)?.parentId, baselineId);
  const laterEntries = parsePhysicalEntries(laterFile);
  assertUniqueIds(laterEntries);
  const reopened = await SessionManager.open(laterFile, laterDir, root);
  assert.ok(reopened.getEntry(retryId));
  const reopenedAppendId = await reopened.appendCustomEntry("after-reopen", { attempt: 3 });
  const reopenedAgain = await SessionManager.open(laterFile, laterDir, root);
  assert.ok(reopenedAgain.getEntry(retryId), "retry must survive a second reopen");
  assert.ok(reopenedAgain.getEntry(reopenedAppendId), "append through reopened manager must survive another reopen");
  assertUniqueIds(parsePhysicalEntries(laterFile));

  const batchDir = join(root, "batch");
  const batch = await SessionManager.create(root, batchDir);
  const setupId = await batch.appendModelChange("anthropic", "test");
  const batchFile = batch.getSessionFile();
  assert.ok(batchFile);
  assert.equal(existsSync(batchFile), true);
  const batchBeforeFailure = readFileSync(batchFile);
  await assert.rejects(
    async () => await batch.appendMessage({ role: "user", content: "partial-fault-batch", timestamp: 11 }),
    (error) => { assert.ok(error instanceof StorageUnavailableError); assert.ok(error.cause instanceof PartialAppendFault); return true; },
  );
  assert.deepEqual(readFileSync(batchFile), batchBeforeFailure, "failed append preserves the committed setup");
  assert.equal(batch.getLeafId(), setupId);
  assert.equal(batch.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user").length, 0);

  const userId = await batch.appendMessage({ role: "user", content: "retry batch user", timestamp: 12 });
  const batchEntries = parsePhysicalEntries(batchFile);
  assertUniqueIds(batchEntries);
  assert.equal(batchEntries.length, 3);
  const reopenedBatch = await SessionManager.open(batchFile, batchDir, root);
  assert.ok(reopenedBatch.getEntry(setupId));
  assert.ok(reopenedBatch.getEntry(userId));
  assert.equal(reopenedBatch.getEntries().filter((entry) => entry.type === "model_change").length, 1);
  assert.equal(reopenedBatch.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user").length, 1);

  console.log(JSON.stringify({ later: "ok", batch: "ok" }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
