import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@bastani/atomic";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { loadExtensionFromFactory } from "../../packages/coding-agent/src/core/extensions/loader-core.js";
import { createExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/loader-runtime.js";

test("public extension send methods return the runtime admission receipts by identity", async () => {
  const runtime = createExtensionRuntime();
  let api: ExtensionAPI | undefined;
  await loadExtensionFromFactory((extensionApi) => { api = extensionApi; }, process.cwd(), createEventBus(), runtime);
  assert.ok(api);
  const messageReceipt = Promise.resolve();
  const batchReceipt = Promise.resolve();
  runtime.sendMessage = () => messageReceipt;
  runtime.sendMessages = () => batchReceipt;

  assert.equal(api.sendMessage({ customType: "receipt", content: "one", display: true }), messageReceipt);
  assert.equal(api.sendMessages([{ customType: "receipt", content: "two", display: true }]), batchReceipt);
});
