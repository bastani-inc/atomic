import { describe, expect, it } from "vitest";
import { buildOpenRouterCatalog, type OpenRouterModelListItem } from "../scripts/openrouter-catalog.ts";

const imageOnly: OpenRouterModelListItem = {
	id: "example/image-model",
	name: "Example Image Model",
	architecture: {
		input_modalities: ["text", "image"],
		output_modalities: ["image"],
	},
	pricing: {
		prompt: "0.000001",
		completion: "0.000002",
	},
};

const chatWithImages: OpenRouterModelListItem = {
	id: "example/multimodal",
	name: "Example Multimodal",
	supported_parameters: ["tools"],
	architecture: {
		modality: "text+image->text+image",
		input_modalities: ["text", "image"],
		output_modalities: ["text", "image"],
	},
	context_length: 32000,
};

const chatOnly: OpenRouterModelListItem = {
	id: "example/chat",
	name: "Example Chat",
	supported_parameters: ["tools"],
	architecture: { modality: "text->text", output_modalities: ["text"] },
};

describe("OpenRouter catalog parsing", () => {
	it("emits image-only models from the image listing as image models", () => {
		const catalog = buildOpenRouterCatalog([], [imageOnly]);
		expect(catalog.chat).toEqual([]);
		expect(catalog.images).toEqual([
			expect.objectContaining({
				type: "image",
				id: "example/image-model",
				api: "openrouter-images",
				input: ["text", "image"],
				output: ["image"],
				cost: expect.objectContaining({ input: 1, output: 2 }),
			}),
		]);
	});

	it("emits separate chat and image entries for an id that supports both operations", () => {
		const catalog = buildOpenRouterCatalog([chatWithImages, chatOnly], [chatWithImages, imageOnly]);
		expect(catalog.chat.map((model) => model.id)).toEqual(["example/multimodal", "example/chat"]);
		expect(catalog.chat.map((model) => model.type)).toEqual(["chat", "chat"]);
		expect(catalog.images.map((model) => model.id)).toEqual(["example/multimodal", "example/image-model"]);
		expect(catalog.images.every((model) => model.type === "image")).toBe(true);
		expect(catalog.images.map((model) => model.output)).toEqual([["text", "image"], ["image"]]);
	});

	it("ignores listed models that neither support tools nor emit images", () => {
		const catalog = buildOpenRouterCatalog(
			[{ ...chatOnly, supported_parameters: [] }],
			[{ ...imageOnly, architecture: { output_modalities: ["text"] } }],
		);
		expect(catalog.chat).toEqual([]);
		expect(catalog.images).toEqual([]);
	});
});
