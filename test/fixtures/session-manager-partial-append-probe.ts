import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
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
  const later = SessionManager.create(root, laterDir);
  later.appendMessage({ role: "user", content: "baseline", timestamp: 1 });
  const baselineId = later.appendMessage(assistant("baseline reply", 2));
  const laterFile = later.getSessionFile();
  assert.ok(laterFile);
  const beforeFailure = readFileSync(laterFile);

  assert.throws(
    () => later.appendCustomEntry("partial-fault-later", { marker: "partial-fault-later" }),
    /fault after partial physical append/,
  );
  assert.deepEqual(readFileSync(laterFile), beforeFailure, "failed append must restore exact prior bytes");
  assert.equal(later.getLeafId(), baselineId);
  assert.equal(later.getEntries().some((entry) => entry.type === "custom" && entry.customType === "partial-fault-later"), false);

  const retryId = later.appendCustomEntry("persisted-retry", { attempt: 2 });
  assert.equal(later.getEntry(retryId)?.parentId, baselineId);
  const laterEntries = parsePhysicalEntries(laterFile);
  assertUniqueIds(laterEntries);
  const reopened = SessionManager.open(laterFile, laterDir, root);
  assert.ok(reopened.getEntry(retryId));
  const reopenedAppendId = reopened.appendCustomEntry("after-reopen", { attempt: 3 });
  const reopenedAgain = SessionManager.open(laterFile, laterDir, root);
  assert.ok(reopenedAgain.getEntry(retryId), "retry must survive a second reopen");
  assert.ok(reopenedAgain.getEntry(reopenedAppendId), "append through reopened manager must survive another reopen");
  assertUniqueIds(parsePhysicalEntries(laterFile));

  const batchDir = join(root, "batch");
  const batch = SessionManager.create(root, batchDir);
  const userId = batch.appendMessage({ role: "user", content: "buffered user", timestamp: 10 });
  const batchFile = batch.getSessionFile();
  assert.ok(batchFile);
  assert.equal(existsSync(batchFile), false);
  assert.throws(
    () => batch.appendMessage(assistant("partial-fault-batch", 11)),
    /fault after partial physical append/,
  );
  assert.equal(existsSync(batchFile), false, "failed initial batch must restore the absent-file state");
  assert.equal(batch.getLeafId(), userId);
  assert.equal(batch.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant").length, 0);

  const assistantId = batch.appendMessage(assistant("retry batch reply", 12));
  const batchEntries = parsePhysicalEntries(batchFile);
  assertUniqueIds(batchEntries);
  assert.equal(batchEntries.length, 3);
  const reopenedBatch = SessionManager.open(batchFile, batchDir, root);
  assert.ok(reopenedBatch.getEntry(userId));
  assert.ok(reopenedBatch.getEntry(assistantId));
  assert.equal(reopenedBatch.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user").length, 1);
  assert.equal(reopenedBatch.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant").length, 1);

  console.log(JSON.stringify({ later: "ok", batch: "ok" }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
