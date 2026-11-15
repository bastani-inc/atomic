import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { convertMessages } from "../src/api/google-shared.ts";
import type { Content } from "@google/genai";
import type { Context, Message, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

type GoogleApi = "google-generative-ai" | "google-vertex";

function makeModel(api: GoogleApi, id: string): Model<GoogleApi> {
	return {
		id,
		name: id,
		api,
		provider: api === "google-vertex" ? "google-vertex" : "google",
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

/** A parallel batch of `callCount` read calls; the call at `imageIndex` returns an image. */
function makeBatch(model: Model<GoogleApi>, callCount: number, imageIndex: number): Context {
	const ids = Array.from({ length: callCount }, (_, i) => `call_${i}`);
	const results: Message[] = ids.map((id, i) => ({
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content:
			i === imageIndex
				? [
						{ type: "text", text: `image ${i}` },
						{ type: "image", data: "abc", mimeType: "image/png" },
					]
				: [{ type: "text", text: `text ${i}` }],
		isError: false,
		timestamp: 2,
	}));
	return {
		messages: [
			{ role: "user", content: "read the files", timestamp: 0 },
			{
				role: "assistant",
				content: ids.map((id) => ({ type: "toolCall", id, name: "read", arguments: { path: id } })),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 1,
			},
			...results,
			{ role: "user", content: "thanks", timestamp: 3 },
		],
	};
}

/** Summarizes each turn: function responses by output, images, and text parts. */
function shape(contents: Content[]): string[][] {
	return contents.map((content) =>
		(content.parts ?? []).map((part) => {
			if (part.functionResponse) {
				const nested = part.functionResponse.parts?.length ? "+image" : "";
				return `fr:${String(part.functionResponse.response?.output)}${nested}`;
			}
			if (part.functionCall) return "fc";
			if (part.inlineData) return "image";
			return `text:${part.text}`;
		}),
	);
}

const batches = [
	{ callCount: 2, imageIndex: 0, label: "first of 2" },
	{ callCount: 2, imageIndex: 1, label: "last of 2" },
	{ callCount: 3, imageIndex: 0, label: "first of 3" },
	{ callCount: 3, imageIndex: 1, label: "middle of 3" },
	{ callCount: 3, imageIndex: 2, label: "last of 3" },
];

describe("google-shared parallel tool batch with an image result", () => {
	for (const api of ["google-generative-ai", "google-vertex"] as const) {
		for (const { callCount, imageIndex, label } of batches) {
			it(`keeps gemini-2.5 function responses in one turn with the image ${label} on ${api} (#5048)`, () => {
				const model = makeModel(api, "gemini-2.5-flash");
				const contents = convertMessages(model, normalizeContext(makeBatch(model, callCount, imageIndex)));
				const responses = Array.from({ length: callCount }, (_, i) =>
					i === imageIndex ? `fr:image ${i}` : `fr:text ${i}`,
				);

				assert.deepEqual(shape(contents), [
					["text:read the files"],
					Array.from({ length: callCount }, () => "fc"),
					responses,
					["text:Tool result image:", "image"],
					["text:thanks"],
				]);
			});

			it(`nests the image ${label} for gemini-3 on ${api} (#5048)`, () => {
				const model = makeModel(api, "gemini-3-pro-preview");
				const contents = convertMessages(model, normalizeContext(makeBatch(model, callCount, imageIndex)));
				const responses = Array.from({ length: callCount }, (_, i) =>
					i === imageIndex ? `fr:image ${i}+image` : `fr:text ${i}`,
				);

				assert.deepEqual(shape(contents), [
					["text:read the files"],
					Array.from({ length: callCount }, () => "fc"),
					responses,
					["text:thanks"],
				]);
			});
		}
	}
});
