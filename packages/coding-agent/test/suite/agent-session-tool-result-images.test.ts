import { crc32, deflateSync } from "node:zlib";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, expect, test } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

function pngChunk(type: string, body: Buffer): Buffer {
	const header = Buffer.alloc(8);
	header.writeUInt32BE(body.length, 0);
	header.write(type, 4, "ascii");
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), body])), 0);
	return Buffer.concat([header, body, checksum]);
}

function createPng(width: number, height: number): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 0;
	const raw = Buffer.alloc((width + 1) * height);
	for (let row = 0; row < height; row += 1) {
		raw.fill(row % 256, row * (width + 1) + 1, (row + 1) * (width + 1));
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

function pngWidth(base64: string): number {
	return Buffer.from(base64, "base64").readUInt32BE(16);
}

const oversizedImage = createPng(2400, 100).toString("base64");
const screenshotTool: AgentTool = {
	name: "screenshot",
	label: "Screenshot",
	description: "Return an oversized screenshot",
	parameters: Type.Object({}),
	execute: async () => ({
		content: [{ type: "image", data: oversizedImage, mimeType: "image/png" }],
		details: { source: "tool" },
	}),
};

function historyImages(harness: Harness): ImageContent[] {
	return harness.session.messages
		.filter((message) => message.role === "toolResult")
		.flatMap((message) => message.content)
		.filter((part): part is ImageContent => part.type === "image");
}

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
});

test("resizes builtin and extension-injected tool images before history", async () => {
	const harness = await createHarness({
		tools: [screenshotTool],
		extensionFactories: [
			(pi) => {
				pi.on("tool_result", (event) => ({
					content: [
						...event.content,
						{ type: "image", data: oversizedImage, mimeType: "image/png" },
						{ type: "text", text: "injected by extension" },
					],
					details: { source: "extension" },
				}));
			},
		],
	});
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("screenshot", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);

	await harness.session.prompt("take a screenshot");

	const images = historyImages(harness);
	expect(images).toHaveLength(2);
	for (const image of images) {
		expect(pngWidth(image.data)).toBeLessThanOrEqual(2000);
	}
	const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
	expect(toolResult?.details).toEqual({ source: "extension" });
});

test("preserves builtin tool details while resizing its image", async () => {
	const harness = await createHarness({ tools: [screenshotTool] });
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("screenshot", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);

	await harness.session.prompt("take a screenshot");

	const images = historyImages(harness);
	expect(images).toHaveLength(1);
	expect(pngWidth(images[0]!.data)).toBeLessThanOrEqual(2000);
	const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
	expect(toolResult?.details).toEqual({ source: "tool" });
});

test("resizes images returned by extension tools before history", async () => {
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "extension_screenshot",
					label: "Extension screenshot",
					description: "Return an oversized screenshot from an extension tool",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "image", data: oversizedImage, mimeType: "image/png" }],
						details: { source: "extension-tool" },
					}),
				});
			},
		],
		initialActiveToolNames: ["extension_screenshot"],
	});
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("extension_screenshot", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);

	await harness.session.prompt("take an extension screenshot");

	const images = historyImages(harness);
	expect(images).toHaveLength(1);
	expect(pngWidth(images[0]!.data)).toBeLessThanOrEqual(2000);
	const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
	expect(toolResult?.details).toEqual({ source: "extension-tool" });
});

test("keeps tool images unchanged when automatic resizing is disabled", async () => {
	const harness = await createHarness({
		tools: [screenshotTool],
		settings: { images: { autoResize: false } },
	});
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("screenshot", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);

	await harness.session.prompt("take a screenshot");

	const images = historyImages(harness);
	expect(images).toHaveLength(1);
	expect(images[0]?.data).toBe(oversizedImage);
});
