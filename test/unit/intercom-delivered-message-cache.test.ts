import { test } from "bun:test";
import assert from "node:assert/strict";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { buildMessageSendSignature, buildSendSignature } from "../../packages/intercom/broker/send-signature.js";

test("successful message ids dedupe only the same logical send within a bounded TTL cache", () => {
  const cache = new DeliveredMessageCache(100, 2);
  cache.record("one", "signature-one", 0);
  cache.record("two", "signature-two", 1);
  assert.equal(cache.lookup("one", "signature-one", 2), "match");
  assert.equal(cache.lookup("one", "different", 2), "conflict");
  cache.record("three", "signature-three", 3);
  assert.equal(cache.lookup("one", "signature-one", 3), "miss", "oldest entry is evicted at the size bound");
  assert.equal(cache.lookup("two", "signature-two", 102), "miss", "entries expire after the TTL");
  assert.equal(cache.lookup("three", "signature-three", 102), "match");
});

test("logical send signatures normalize options and ignore transport metadata", () => {
  const options = {
    text: "done",
    attachments: [{ type: "snippet" as const, name: "proof", content: "ok", language: "text" }],
    replyTo: "parent-message",
    expectsReply: false,
  };
  const signature = buildSendSignature("parent", options);
  assert.equal(buildMessageSendSignature("parent", {
    id: "attempt-a",
    timestamp: 1,
    replyTo: options.replyTo,
    expectsReply: options.expectsReply,
    content: { text: options.text, attachments: options.attachments },
  }), signature);
  assert.equal(buildMessageSendSignature("parent", {
    id: "attempt-b",
    timestamp: 999,
    replyTo: options.replyTo,
    expectsReply: options.expectsReply,
    content: { text: options.text, attachments: options.attachments },
  }), signature, "id and timestamp must not affect logical identity");
  assert.notEqual(buildSendSignature("other", options), signature);
  assert.notEqual(buildSendSignature("parent", { ...options, text: "changed" }), signature);
  assert.notEqual(buildSendSignature("parent", { ...options, replyTo: "other" }), signature);
  assert.equal(buildSendSignature("parent", { text: "done" }), buildSendSignature("parent", {
    text: "done", attachments: [], expectsReply: false,
  }), "empty optional collections and false flags normalize to their wire semantics");
  assert.notEqual(buildSendSignature("parent", { ...options, expectsReply: true }), signature);
});
