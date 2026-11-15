import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES } from "@bastani/atomic";
import { afterEach, test } from "vitest";
import { formatAttachments } from "../../packages/intercom/intercom-utils.js";
import {
	boundReceivedMessage,
	INTERCOM_MAX_RECEIVED_MESSAGE_BYTES,
	receivedMessageExceedsBound,
} from "../../packages/intercom/received-message-bound.js";
import type { Attachment, Message } from "../../packages/intercom/types.js";

const directories: string[] = [];
afterEach(() => {
	while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function message(text: string, attachments?: Attachment[]): Message {
	return {
		id: "m-4907",
		timestamp: 7,
		replyTo: "q-1",
		expectsReply: true,
		content: { text, ...(attachments === undefined ? {} : { attachments }) },
	};
}

test("the received-message limit is the tool-result truncation limit (#4907)", () => {
	assert.equal(INTERCOM_MAX_RECEIVED_MESSAGE_BYTES, DEFAULT_MAX_BYTES);
});

test("a received message is measured as shown, its attachments included, in UTF-8 bytes (#4907)", () => {
	const attachment: Attachment = { type: "file", name: "a", content: "x" };
	const shownAttachmentBytes = Buffer.byteLength(formatAttachments([attachment]));
	const atLimit = message("é".repeat((INTERCOM_MAX_RECEIVED_MESSAGE_BYTES - shownAttachmentBytes) / 2), [attachment]);
	assert.equal(receivedMessageExceedsBound(atLimit), false);
	assert.equal(receivedMessageExceedsBound(message(`${atLimit.content.text}x`, [attachment])), true);
	assert.equal(receivedMessageExceedsBound(message("é".repeat(INTERCOM_MAX_RECEIVED_MESSAGE_BYTES / 2))), false);
	assert.equal(receivedMessageExceedsBound(message(`${"é".repeat(INTERCOM_MAX_RECEIVED_MESSAGE_BYTES / 2)}x`)), true);
});

test("a message within the limit is kept as it is, and nothing is saved (#4907)", async () => {
	const small = message("hello", [{ type: "snippet", name: "n.ts", language: "ts", content: "export {};" }]);
	const bounded = await boundReceivedMessage(small, () => assert.fail("a message within the limit is not saved"));
	assert.equal(bounded, small);
});

test("a larger message keeps its identity and becomes a preview of its text and attachments saved to a file (#4907)", async () => {
	const sessionDir = mkdtempSync(join(tmpdir(), "intercom-bound-"));
	directories.push(sessionDir);
	const attachment: Attachment = {
		type: "file",
		name: "big.log",
		content: "a".repeat(INTERCOM_MAX_RECEIVED_MESSAGE_BYTES),
	};
	const large = message("see attached", [attachment]);
	const bounded = await boundReceivedMessage(large, () => ({ sessionId: "recipient", sessionDir }));
	const { content, ...identity } = bounded;
	const { content: _original, ...originalIdentity } = large;
	assert.deepEqual(identity, originalIdentity);
	assert.deepEqual(Object.keys(content), ["text"]);
	assert.ok(Buffer.byteLength(content.text) < INTERCOM_MAX_RECEIVED_MESSAGE_BYTES);
	assert.match(content.text, /^<persisted-output>\nOutput too large \(50KB\)/);
	assert.match(content.text, /Preview \(first 2KB\):\nsee attached\n\n---\n📎 big\.log\na/);
	const path = /saved to: (.+)$/m.exec(content.text)?.[1];
	assert.ok(path, content.text);
	assert.ok(path.startsWith(sessionDir), path);
	assert.equal(readFileSync(path, "utf8"), `see attached${formatAttachments([attachment])}`);
});
