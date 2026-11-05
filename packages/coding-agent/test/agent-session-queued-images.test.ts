import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import type { ImageContent, TextContent } from "@bastani/pi-ai/compat";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, it } from "vitest";
import type { AgentSessionInternalSurface } from "../src/core/agent-session-methods.ts";
import { markQueuedMessageImages, normalizeQueuedMessageImages } from "../src/core/agent-session-prompt.ts";
import { createHarness, type Harness } from "./test-harness.ts";

const OMITTED_IMAGE_HINT = "[Image omitted: could not be converted to a supported inline image format.]";
const UNSUPPORTED_IMAGE: ImageContent = { type: "image", data: "AAAA", mimeType: "image/x-unsupported" };

type UserMessage = Extract<AgentMessage, { role: "user" }>;
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

function userMessage(content: (TextContent | ImageContent)[]): UserMessage {
	return { role: "user", content, timestamp: 1 };
}

function crc32(data: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

/** A solid gray RGB PNG of the given size, base64 encoded. */
function createPng(width: number, height: number): string {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	const row = Buffer.alloc(1 + width * 3, 0x80);
	row[0] = 0;
	const raw = Buffer.concat(Array.from({ length: height }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	]).toString("base64");
}

function persistedUserContent(harness: Harness, text: string): (TextContent | ImageContent)[] {
	for (const entry of harness.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		if (typeof content === "string") continue;
		if (content[0]?.type === "text" && content[0].text.split("\n")[0] === text) return content;
	}
	throw new Error(`No user message "${text}"`);
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
}

describe("AgentSession queued message images", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	// Queued messages skipped the image resize idle prompts get.
	it("resizes images in steering, follow-up, and streaming prompt messages (pi #11738)", async () => {
		harness = await createHarness({ responses: [{ text: "first", delayMs: 300 }, "second", "third", "fourth"] });
		const image: ImageContent = { type: "image", data: createPng(1200, 9000), mimeType: "image/png" };

		const run = harness.session.prompt("idle");
		await waitFor(() => harness!.session.isStreaming);
		await harness.session.steer("steer", [image]);
		await harness.session.followUp("follow up", [image]);
		await harness.session.prompt("streaming prompt", { images: [image], streamingBehavior: "followUp" });
		await run;
		await waitFor(() => !harness!.session.isStreaming && harness!.faux.callCount >= 4);

		for (const text of ["steer", "follow up", "streaming prompt"]) {
			const content = persistedUserContent(harness, text);
			const images = content.filter((block): block is ImageContent => block.type === "image");
			assert.equal(images.length, 1);
			assert.notEqual(images[0].data, image.data);
			assert.ok((content[0] as TextContent).text.includes("original 1200x9000, displayed at 267x2000"));
		}
		const sentImages = harness.faux.contexts
			.flatMap((context) => context.messages)
			.flatMap((message): readonly { type: string }[] =>
				typeof message.content === "string" ? [] : message.content,
			)
			.filter((block): block is ImageContent => block.type === "image");
		assert.ok(sentImages.length > 0);
		assert.equal(
			sentImages.some((block) => block.data === image.data),
			false,
		);
		assert.equal(harness.session.pendingMessageCount, 0);
	});
});

describe("normalizeQueuedMessageImages", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	async function sessionInternals(): Promise<AgentSessionInternalSurface> {
		harness = await createHarness();
		return harness.session as AgentSessionInternalSurface;
	}

	it("leaves a message that was not queued with images untouched", async () => {
		const session = await sessionInternals();
		const message = userMessage([{ type: "text", text: "plain" }, UNSUPPORTED_IMAGE]);
		const content = message.content;

		await normalizeQueuedMessageImages(session, message);

		assert.equal(message.content, content);
		assert.deepEqual(message.content, [{ type: "text", text: "plain" }, UNSUPPORTED_IMAGE]);
	});

	it("leaves a queued message that is not a user message untouched", async () => {
		const session = await sessionInternals();
		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "result" }, UNSUPPORTED_IMAGE],
			isError: false,
			timestamp: 1,
		};
		const content = message.content;
		markQueuedMessageImages(message);

		await normalizeQueuedMessageImages(session, message);

		assert.equal(message.content, content);
		assert.deepEqual(message.content, [{ type: "text", text: "result" }, UNSUPPORTED_IMAGE]);
	});

	it.each([
		["an image", [UNSUPPORTED_IMAGE]],
		["nothing", []],
	] as const)("leaves a queued message that starts with %s untouched", async (_name, blocks) => {
		const session = await sessionInternals();
		const message = userMessage([...blocks]);
		const content = message.content;
		markQueuedMessageImages(message);

		await normalizeQueuedMessageImages(session, message);

		assert.equal(message.content, content);
		assert.deepEqual(message.content, blocks);
	});

	it("keeps the other text blocks in place and lists a hint for every omitted image", async () => {
		const session = await sessionInternals();
		const message = userMessage([
			{ type: "text", text: "queued" },
			{ type: "text", text: "extra" },
			{ type: "image", data: createPng(1, 1), mimeType: "image/png" },
			UNSUPPORTED_IMAGE,
			UNSUPPORTED_IMAGE,
		]);
		markQueuedMessageImages(message);

		await normalizeQueuedMessageImages(session, message);

		assert.ok(typeof message.content !== "string");
		const [text, extra, kept, ...others] = message.content;
		assert.deepEqual(text, { type: "text", text: `queued\n\n${OMITTED_IMAGE_HINT}\n${OMITTED_IMAGE_HINT}` });
		assert.deepEqual(extra, { type: "text", text: "extra" });
		assert.equal(kept?.type, "image");
		assert.deepEqual(others, []);
	});

	it("adds no hint text when every image normalizes cleanly", async () => {
		const session = await sessionInternals();
		const message = userMessage([
			{ type: "text", text: "queued" },
			{ type: "image", data: createPng(1, 1), mimeType: "image/png" },
		]);
		markQueuedMessageImages(message);

		await normalizeQueuedMessageImages(session, message);

		assert.ok(typeof message.content !== "string");
		assert.deepEqual(message.content[0], { type: "text", text: "queued" });
		assert.equal(message.content.length, 2);
	});

	it("follows the admitted message's text when its hints are added", async () => {
		const session = await sessionInternals();
		const message = userMessage([{ type: "text", text: "queued" }, UNSUPPORTED_IMAGE]);
		markQueuedMessageImages(message);
		session._admittedQueuedMessageAwaitingReply = "queued";

		await normalizeQueuedMessageImages(session, message);

		assert.equal(session._admittedQueuedMessageAwaitingReply, `queued\n\n${OMITTED_IMAGE_HINT}`);
	});

	it("leaves another message's admitted text alone", async () => {
		const session = await sessionInternals();
		const message = userMessage([{ type: "text", text: "queued" }, UNSUPPORTED_IMAGE]);
		markQueuedMessageImages(message);
		session._admittedQueuedMessageAwaitingReply = "another message";

		await normalizeQueuedMessageImages(session, message);

		assert.equal(session._admittedQueuedMessageAwaitingReply, "another message");
	});
});
