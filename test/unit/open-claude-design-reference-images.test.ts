import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { AuthStorage } from "@bastani/atomic";
import type { AssistantImages, ImagesContext, OpenAIImagesOptions } from "@bastani/pi-ai";
import { Value } from "typebox/value";
import { afterEach, describe, test } from "vitest";
import openClaudeDesign from "../../packages/workflows/builtin/open-claude-design.js";
import {
	buildReferenceImagePrompt,
	createBuiltinReferenceImageProvider,
	existingReferenceImagePaths,
	generateReferenceImages,
	REFERENCE_IMAGE_DIRECTIONS,
	REFERENCE_IMAGES_TOOL_TIMEOUT_MS,
	type ReferenceImageModel,
	type ReferenceImageProvider,
	type ReferenceImagesRequest,
	type ReferenceImagesStatus,
	referenceImagesStatusSchema,
	runReferenceImagesStep,
	selectReferenceImageModel,
} from "../../packages/workflows/builtin/open-claude-design-images.js";
import { buildLiveSessionStartPrompt } from "../../packages/workflows/builtin/open-claude-design-live-protocol.js";
import { runOpenClaudeDesignWorkflow } from "../../packages/workflows/builtin/open-claude-design-runner.js";
import { buildLiveReviewGateMessage } from "../../packages/workflows/builtin/open-claude-design-setup.js";
import {
	referenceImageFileUrl,
	referenceImageRelativeSrc,
} from "../../packages/workflows/builtin/open-claude-design-utils.js";
import {
	schemaDescription,
	schemaFieldKind,
	schemaIsRequired,
} from "../../packages/workflows/src/shared/schema-introspection.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";
import { makeMockCtx, readPaths } from "./builtin-workflows-helpers.js";

const directories: string[] = [];

function tempDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "ocd-reference-images-"));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function imageModel(provider: string, id: string): ReferenceImageModel {
	return {
		type: "image",
		id,
		name: id,
		api: provider === "openrouter" ? "openrouter-images" : "openai-images",
		provider,
		baseUrl: "https://images.example.test/v1",
		input: ["text"],
		output: ["image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

const OPENAI_IMAGES_IDS = [
	"gpt-image-2.6-sunburst",
	"gpt-image-2.6-flare",
	"gpt-image-2.5-sunburst",
	"gpt-image-2.5-flare",
	"gpt-image-2",
	"gpt-image-1.5",
	"gpt-image-1",
	"gpt-image-1-mini",
];
const OPENAI_IMAGES_BY_PREFERENCE = [
	"gpt-image-2.6-flare",
	"gpt-image-2.6-sunburst",
	"gpt-image-2.5-flare",
	"gpt-image-2.5-sunburst",
	"gpt-image-2",
	"gpt-image-1.5",
	"gpt-image-1",
	"gpt-image-1-mini",
];

function rankedIds(models: readonly ReferenceImageModel[]): string[] {
	const remaining = [...models];
	const order: string[] = [];
	while (remaining.length > 0) {
		const best = selectReferenceImageModel(remaining, undefined);
		assert.ok(best);
		order.push(`${best.provider}/${best.id}`);
		remaining.splice(remaining.indexOf(best), 1);
	}
	return order;
}

function permutations<T>(items: readonly T[]): T[][] {
	if (items.length <= 1) return [[...items]];
	return items.flatMap((item, index) =>
		permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
	);
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
	const result = [...items];
	let state = seed;
	for (let index = result.length - 1; index > 0; index -= 1) {
		state = (state * 1103515245 + 12345) % 2147483648;
		const swap = state % (index + 1);
		[result[index], result[swap]] = [result[swap] as T, result[index] as T];
	}
	return result;
}

function orderings<T>(items: readonly T[]): T[][] {
	if (items.length <= 5) return permutations(items);
	const rotations = items.map((_, index) => [...items.slice(index), ...items.slice(0, index)]);
	const reversed = [...items].reverse();
	const reversedRotations = items.map((_, index) => [...reversed.slice(index), ...reversed.slice(0, index)]);
	return [...rotations, ...reversedRotations, ...Array.from({ length: 24 }, (_, seed) => shuffled(items, seed + 1))];
}

function assertRanking(models: readonly ReferenceImageModel[], expected: readonly string[]): void {
	for (const ordering of orderings(models)) {
		assert.deepEqual(
			rankedIds(ordering),
			expected,
			`input order ${ordering.map((model) => `${model.provider}/${model.id}`).join(", ")}`,
		);
	}
}

function openaiImagesCatalog(): ReferenceImageModel[] {
	return OPENAI_IMAGES_IDS.map((id) => imageModel("openai-images", id));
}

function base64Of(text: string): string {
	return Buffer.from(text.repeat(40)).toString("base64");
}

function directionIndexOf(prompt: string): number {
	return REFERENCE_IMAGE_DIRECTIONS.findIndex((direction) => prompt.includes(direction.composition));
}

function imagesResult(overrides: Partial<AssistantImages> = {}): AssistantImages {
	return {
		api: "openai-images",
		provider: "openai-images",
		model: "gpt-image-2.6-flare",
		output: [],
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

function pngFor(prompt: string): AssistantImages {
	const marker = `direction-${directionIndexOf(prompt)}-pixels`;
	return imagesResult({ output: [{ type: "image", mimeType: "image/png", data: base64Of(marker) }] });
}

type GenerateCall = {
	readonly model: ReferenceImageModel;
	readonly input: ImagesContext["input"];
	readonly prompt: string;
	readonly options: OpenAIImagesOptions;
};

function fakeProvider(
	models: readonly ReferenceImageModel[],
	respond: (call: GenerateCall) => AssistantImages | Promise<AssistantImages> = (call) => pngFor(call.prompt),
): { readonly provider: ReferenceImageProvider; readonly calls: GenerateCall[] } {
	const calls: GenerateCall[] = [];
	const provider: ReferenceImageProvider = {
		availableImageModels: async () => models,
		generateImages: async (model, context, options) => {
			const prompt = context.input.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
			const call = { model, input: context.input, prompt, options };
			calls.push(call);
			return respond(call);
		},
	};
	return { provider, calls };
}

function request(overrides: Partial<ReferenceImagesRequest> = {}): ReferenceImagesRequest {
	return {
		brief: "A kanban board for a support team",
		outputType: "component",
		artifactDir: join(tempDirectory(), "artifacts"),
		workflowCwd: tempDirectory(),
		curatedReferences: "",
		...overrides,
	};
}

function generate(
	req: ReferenceImagesRequest,
	provider: ReferenceImageProvider,
	signal: AbortSignal = new AbortController().signal,
): Promise<ReferenceImagesStatus> {
	return generateReferenceImages(req, async () => provider, signal);
}

describe("open-claude-design reference images: model selection", () => {
	test("ranks the openai-images catalog newest GPT Image first, flare before sunburst, base before mini, for any input order (#4590)", () => {
		assertRanking(
			openaiImagesCatalog(),
			OPENAI_IMAGES_BY_PREFERENCE.map((id) => `openai-images/${id}`),
		);
	});

	test("a newer GPT Image version wins without being named anywhere (#4590)", () => {
		const catalog = [
			...openaiImagesCatalog(),
			imageModel("openai-images", "gpt-image-2.7-sunburst"),
			imageModel("openai-images", "gpt-image-2.7-flare"),
			imageModel("openai-images", "gpt-image-3"),
		];
		assert.deepEqual(rankedIds(catalog).slice(0, 4), [
			"openai-images/gpt-image-3",
			"openai-images/gpt-image-2.7-flare",
			"openai-images/gpt-image-2.7-sunburst",
			"openai-images/gpt-image-2.6-flare",
		]);
	});

	test("compares GPT Image versions numerically, segment by segment (#4590)", () => {
		assertRanking(
			[
				imageModel("openai-images", "gpt-image-2.9"),
				imageModel("openai-images", "gpt-image-2.10"),
				imageModel("openai-images", "gpt-image-10"),
				imageModel("openai-images", "gpt-image-2.1.5"),
				imageModel("openai-images", "gpt-image-2.1"),
			],
			[
				"openai-images/gpt-image-10",
				"openai-images/gpt-image-2.10",
				"openai-images/gpt-image-2.9",
				"openai-images/gpt-image-2.1.5",
				"openai-images/gpt-image-2.1",
			],
		);
	});

	test("an unlisted codename ranks between the preferred codenames and the base model, small variants last (#4590)", () => {
		assertRanking(
			[
				imageModel("openai-images", "gpt-image-3-mini"),
				imageModel("openai-images", "gpt-image-3"),
				imageModel("openai-images", "gpt-image-3-ember"),
				imageModel("openai-images", "gpt-image-3-sunburst"),
				imageModel("openai-images", "gpt-image-3-flare"),
			],
			[
				"openai-images/gpt-image-3-flare",
				"openai-images/gpt-image-3-sunburst",
				"openai-images/gpt-image-3-ember",
				"openai-images/gpt-image-3",
				"openai-images/gpt-image-3-mini",
			],
		);
		assert.equal(
			rankedIds([imageModel("openai-images", "gpt-image-3-nano"), imageModel("openai-images", "gpt-image-3")])[0],
			"openai-images/gpt-image-3",
		);
	});

	test("GPT Image models rank above other providers, and OpenRouter ranks first among the rest (#4590)", () => {
		assertRanking(
			[
				imageModel("zeta", "zeta-image-1"),
				imageModel("openrouter", "google/gemini-2.5-flash-image"),
				imageModel("acme", "acme-image-2"),
				imageModel("openai-images", "gpt-image-1-mini"),
			],
			[
				"openai-images/gpt-image-1-mini",
				"openrouter/google/gemini-2.5-flash-image",
				"acme/acme-image-2",
				"zeta/zeta-image-1",
			],
		);
	});

	test("among models of one non-GPT provider the higher id ranks first (#4590)", () => {
		assertRanking(
			[imageModel("acme", "acme-image-2"), imageModel("acme", "acme-image-9"), imageModel("acme", "acme-image-5")],
			["acme/acme-image-9", "acme/acme-image-5", "acme/acme-image-2"],
		);
	});

	test("a GPT Image model served through another provider keeps its GPT Image rank (#4590)", () => {
		assertRanking(
			[
				imageModel("openai-images", "gpt-image-1"),
				imageModel("openrouter", "openai/gpt-image-2"),
				imageModel("openrouter", "google/gemini-2.5-flash-image"),
			],
			["openrouter/openai/gpt-image-2", "openai-images/gpt-image-1", "openrouter/google/gemini-2.5-flash-image"],
		);
	});

	test("an id that only resembles a GPT Image id is not ranked as one (#4590)", () => {
		assertRanking(
			[
				imageModel("openrouter", "vendor/flux"),
				imageModel("openai-images", "gpt-image-2x"),
				imageModel("acme", "my-gpt-image-9"),
				imageModel("openai-images", "gpt-image-1"),
			],
			["openai-images/gpt-image-1", "openrouter/vendor/flux", "acme/my-gpt-image-9", "openai-images/gpt-image-2x"],
		);
	});

	test("the same GPT Image model from several providers resolves the same way for any input order (#4590)", () => {
		assertRanking(
			[
				imageModel("zeta-images", "gpt-image-2"),
				imageModel("openai-images", "gpt-image-2"),
				imageModel("azure-images", "gpt-image-2"),
			],
			["azure-images/gpt-image-2", "openai-images/gpt-image-2", "zeta-images/gpt-image-2"],
		);
	});

	test("two entries for one model keep the first one listed (#4590)", () => {
		const first = { ...imageModel("openai-images", "gpt-image-2"), name: "first" };
		const second = { ...imageModel("openai-images", "gpt-image-2"), name: "second" };
		assert.equal(selectReferenceImageModel([first, second], undefined)?.name, "first");
		assert.equal(selectReferenceImageModel([second, first], undefined)?.name, "second");
	});

	test("an override selects the model named provider/id, including ids that contain slashes (#4590)", () => {
		const models = [
			...openaiImagesCatalog(),
			imageModel("openrouter", "google/gemini-2.5-flash-image"),
			imageModel("openrouter", "black-forest-labs/flux.2-pro"),
		];
		assert.equal(selectReferenceImageModel(models, "openai-images/gpt-image-1")?.id, "gpt-image-1");
		assert.equal(
			selectReferenceImageModel(models, "openrouter/black-forest-labs/flux.2-pro")?.id,
			"black-forest-labs/flux.2-pro",
		);
		assert.equal(selectReferenceImageModel(models, "  openai-images/gpt-image-2  ")?.id, "gpt-image-2");
	});

	test("an override that names no available model selects nothing instead of falling back (#4590)", () => {
		const models = openaiImagesCatalog();
		for (const unavailable of [
			"openai-images/gpt-image-9",
			"gpt-image-2.6-flare",
			"openrouter/gpt-image-2.6-flare",
			"OPENAI-IMAGES/gpt-image-2.6-flare",
			"openai-images/",
			"/gpt-image-2.6-flare",
		]) {
			assert.equal(selectReferenceImageModel(models, unavailable), undefined, unavailable);
		}
	});

	test("an empty or blank override leaves the automatic choice in place (#4590)", () => {
		const models = openaiImagesCatalog();
		assert.equal(selectReferenceImageModel(models, "")?.id, "gpt-image-2.6-flare");
		assert.equal(selectReferenceImageModel(models, "   ")?.id, "gpt-image-2.6-flare");
		assert.equal(selectReferenceImageModel(models, undefined)?.id, "gpt-image-2.6-flare");
	});

	test("selection does not reorder or mutate the caller's list (#4590)", () => {
		const models = openaiImagesCatalog();
		const before = models.map((model) => model.id);
		selectReferenceImageModel(models, undefined);
		assert.deepEqual(
			models.map((model) => model.id),
			before,
		);
		assert.equal(selectReferenceImageModel([], undefined), undefined);
	});
});

describe("open-claude-design reference images: prompts", () => {
	const context = {
		brief: "  A kanban board for a support team  ",
		outputType: "component" as const,
		productContext: "PRODUCT-MARKER support agents triage tickets",
		designContext: "DESIGN-MARKER warm paper background, serif headings",
		curatedReferences: "REFERENCES-MARKER Linear-style dense lists",
	};

	test("offers between two and four distinct directions (#4590)", () => {
		assert.ok(REFERENCE_IMAGE_DIRECTIONS.length >= 2 && REFERENCE_IMAGE_DIRECTIONS.length <= 4);
		const prompts = REFERENCE_IMAGE_DIRECTIONS.map((direction) => buildReferenceImagePrompt(context, direction));
		assert.equal(new Set(prompts).size, prompts.length);
		assert.equal(new Set(REFERENCE_IMAGE_DIRECTIONS.map((direction) => direction.slug)).size, prompts.length);
	});

	test("each prompt carries the brief, its direction, PRODUCT.md, DESIGN.md and the curated references (#4590)", () => {
		for (const direction of REFERENCE_IMAGE_DIRECTIONS) {
			const prompt = buildReferenceImagePrompt(context, direction);
			assert.ok(prompt.includes("for: A kanban board for a support team"));
			assert.ok(prompt.includes(direction.composition));
			assert.ok(prompt.includes("PRODUCT-MARKER"));
			assert.ok(prompt.includes("DESIGN-MARKER"));
			assert.ok(prompt.includes("REFERENCES-MARKER"));
			for (const other of REFERENCE_IMAGE_DIRECTIONS.filter((candidate) => candidate !== direction)) {
				assert.equal(prompt.includes(other.composition), false);
			}
		}
	});

	test("a prompt with only a brief is exactly the surface, the rendering rules, the direction and the closing rule (#4590)", () => {
		const direction = REFERENCE_IMAGE_DIRECTIONS[0];
		assert.ok(direction);
		const prompt = buildReferenceImagePrompt(
			{ brief: "A pricing page", outputType: "page", productContext: "   ", curatedReferences: "" },
			direction,
		);
		assert.equal(
			prompt,
			[
				"A finished desktop web page for: A pricing page",
				"Render the surface edge to edge with crisp, readable text and real, brief-specific content. No browser window, device, desk or poster framing, and no lorem ipsum.",
				`Direction: ${direction.composition}`,
				"Keep the palette, typography and component character the context describes; the direction changes only composition and emphasis.",
			].join("\n\n"),
		);
	});

	test("labels each excerpt and orders curated references, DESIGN.md, then PRODUCT.md before the closing rule (#4590)", () => {
		const direction = REFERENCE_IMAGE_DIRECTIONS[1];
		assert.ok(direction);
		const prompt = buildReferenceImagePrompt(context, direction);
		const sections = [
			"Curated references (inspiration to adapt into this product; do not copy their layout or content):\nREFERENCES-MARKER Linear-style dense lists",
			"Design system (DESIGN.md):\nDESIGN-MARKER warm paper background, serif headings",
			"Product context (PRODUCT.md):\nPRODUCT-MARKER support agents triage tickets",
			"Keep the palette, typography and component character the context describes; the direction changes only composition and emphasis.",
		];
		const positions = sections.map((section) => prompt.indexOf(section));
		assert.ok(
			positions.every((position) => position > 0),
			JSON.stringify(positions),
		);
		assert.deepEqual(
			positions,
			[...positions].sort((left, right) => left - right),
		);
		assert.ok(prompt.includes("Render the surface edge to edge with crisp, readable text"));
		assert.ok(prompt.includes("No browser window, device, desk or poster framing, and no lorem ipsum."));
	});

	test("an excerpt cut at the limit drops trailing whitespace instead of leaving it before the next section (#4590)", () => {
		const direction = REFERENCE_IMAGE_DIRECTIONS[0];
		assert.ok(direction);
		const prompt = buildReferenceImagePrompt(
			{ brief: "A dashboard", outputType: "page", designContext: `${"x".repeat(1_499)} tail` },
			direction,
		);
		assert.ok(prompt.includes(`Design system (DESIGN.md):\n${"x".repeat(1_499)}\n\nKeep the palette`));
	});

	test("caps each excerpt so a long file cannot flood the image prompt (#4590)", () => {
		const direction = REFERENCE_IMAGE_DIRECTIONS[0];
		assert.ok(direction);
		const prompt = buildReferenceImagePrompt(
			{
				brief: "A dashboard",
				outputType: "page",
				productContext: `${"p".repeat(1_000)}${"P".repeat(500)}`,
				designContext: `${"d".repeat(1_500)}${"D".repeat(500)}`,
				curatedReferences: `${"r".repeat(1_500)}${"R".repeat(500)}`,
			},
			direction,
		);
		assert.equal(prompt.includes("p".repeat(1_000)), true);
		assert.equal(prompt.includes("d".repeat(1_500)), true);
		assert.equal(prompt.includes("r".repeat(1_500)), true);
		assert.equal(/[PDR]/.test(prompt.replace(/PRODUCT\.md|DESIGN\.md|[A-Z][a-z]+/g, "")), false);
	});

	test("describes the surface for every output type (#4590)", () => {
		const direction = REFERENCE_IMAGE_DIRECTIONS[0];
		assert.ok(direction);
		const surfaces = (["prototype", "wireframe", "page", "component", "theme", "tokens"] as const).map(
			(outputType) => {
				const prompt = buildReferenceImagePrompt({ brief: "A product", outputType }, direction);
				const first = prompt.split("\n")[0] ?? "";
				assert.match(first, /^A finished .+ for: A product$/);
				return first;
			},
		);
		assert.equal(new Set(surfaces).size, surfaces.length);
	});
});

describe("open-claude-design reference images: generation", () => {
	test("writes one image per direction under <artifact_dir>/references and returns only paths and metadata (#4590)", async () => {
		const req = request();
		const catalog = openaiImagesCatalog();
		const mimeByDirection = ["image/png", "image/jpeg", "image/webp"];
		const { provider } = fakeProvider(catalog, (call) => {
			const index = directionIndexOf(call.prompt);
			return imagesResult({
				output: [
					{ type: "image", mimeType: mimeByDirection[index] ?? "", data: base64Of(`direction-${index}-pixels`) },
				],
			});
		});

		const status = await generate(req, provider);

		const referencesDir = join(req.artifactDir, "references");
		const expected = [
			join(referencesDir, "01-reference-led.png"),
			join(referencesDir, "02-brand-forward.jpg"),
			join(referencesDir, "03-information-dense.webp"),
		];
		assert.deepEqual(status, {
			status: "generated",
			model: "openai-images/gpt-image-2.6-flare",
			paths: expected,
		});
		assert.deepEqual(
			readdirSync(referencesDir).sort(),
			expected.map((path) => basename(path)),
		);
		expected.forEach((path, index) => {
			assert.equal(readFileSync(path, "utf8"), `direction-${index}-pixels`.repeat(40));
		});
		for (let index = 0; index < 3; index += 1) {
			assert.equal(JSON.stringify(status).includes(base64Of(`direction-${index}-pixels`)), false);
		}
	});

	test("requests three distinct text-only high-quality directions with the forwarded signal and bounded timeouts (#4590)", async () => {
		const controller = new AbortController();
		const { provider, calls } = fakeProvider(openaiImagesCatalog());

		await generate(request(), provider, controller.signal);

		assert.equal(calls.length, REFERENCE_IMAGE_DIRECTIONS.length);
		assert.equal(new Set(calls.map((call) => call.prompt)).size, calls.length);
		for (const call of calls) {
			assert.equal(call.model.id, "gpt-image-2.6-flare");
			assert.equal(call.input.length, 1);
			assert.equal(call.input[0]?.type, "text");
			assert.equal(call.options.signal, controller.signal);
			assert.equal(call.options.quality, "high");
			assert.equal(call.options.n, 1);
			assert.equal(call.options.size, "1536x1024");
			assert.ok(Number.isFinite(call.options.timeoutMs) && (call.options.timeoutMs ?? 0) > 0);
			assert.ok(
				(call.options.timeoutMs ?? 0) * (1 + (call.options.maxRetries ?? 0)) < REFERENCE_IMAGES_TOOL_TIMEOUT_MS,
			);
		}
	});

	test("prompts are built from the brief, PRODUCT.md, DESIGN.md and the curated references (#4590)", async () => {
		const workflowCwd = tempDirectory();
		writeFileSync(join(workflowCwd, "PRODUCT.md"), "PRODUCT-FILE-MARKER for support agents");
		writeFileSync(join(workflowCwd, "DESIGN.md"), "DESIGN-FILE-MARKER warm paper");
		const { provider, calls } = fakeProvider(openaiImagesCatalog());

		await generate(request({ workflowCwd, curatedReferences: "CURATED-MARKER dense lists" }), provider);

		for (const call of calls) {
			assert.ok(call.prompt.includes("A kanban board for a support team"));
			assert.ok(call.prompt.includes("PRODUCT-FILE-MARKER"));
			assert.ok(call.prompt.includes("DESIGN-FILE-MARKER"));
			assert.ok(call.prompt.includes("CURATED-MARKER"));
		}
	});

	test("missing PRODUCT.md and DESIGN.md do not stop generation (#4590)", async () => {
		const { provider, calls } = fakeProvider(openaiImagesCatalog());
		const status = await generate(request(), provider);
		assert.equal(status.status, "generated");
		assert.equal(calls.length, REFERENCE_IMAGE_DIRECTIONS.length);
		assert.equal(calls[0]?.prompt.includes("PRODUCT.md"), false);
	});

	test("an unreadable PRODUCT.md is recorded as a failure rather than hidden (#4590)", async () => {
		const workflowCwd = tempDirectory();
		mkdirSync(join(workflowCwd, "PRODUCT.md"));
		const { provider, calls } = fakeProvider(openaiImagesCatalog());

		const status = await generate(request({ workflowCwd }), provider);

		assert.deepEqual(status, { status: "failed", reason: "unexpected-error", paths: [] });
		assert.equal(calls.length, 0);
	});

	test("uses the image_model override instead of the automatic choice (#4590)", async () => {
		const { provider, calls } = fakeProvider(openaiImagesCatalog());

		const status = await generate(request({ imageModel: "openai-images/gpt-image-1" }), provider);

		assert.equal(status.model, "openai-images/gpt-image-1");
		assert.ok(calls.length > 0);
		assert.ok(calls.every((call) => call.model.id === "gpt-image-1"));
	});

	test("an override naming an unavailable model skips with image-model-unavailable and generates nothing (#4590)", async () => {
		const req = request({ imageModel: "openai-images/gpt-image-9" });
		const { provider, calls } = fakeProvider(openaiImagesCatalog());

		const status = await generate(req, provider);

		assert.deepEqual(status, { status: "skipped", reason: "image-model-unavailable", paths: [] });
		assert.equal(calls.length, 0);
		assert.equal(existsSync(join(req.artifactDir, "references")), false);
	});

	test("with no image model the step is skipped with no-image-model and writes nothing (#4590)", async () => {
		const req = request();
		const { provider, calls } = fakeProvider([]);

		const status = await generate(req, provider);

		assert.deepEqual(status, { status: "skipped", reason: "no-image-model", paths: [] });
		assert.equal(calls.length, 0);
		assert.equal(existsSync(req.artifactDir), false);
	});

	test("with no image model an override still reports no-image-model (#4590)", async () => {
		const { provider } = fakeProvider([]);
		const status = await generate(request({ imageModel: "openai-images/gpt-image-2.6-flare" }), provider);
		assert.deepEqual(status, { status: "skipped", reason: "no-image-model", paths: [] });
	});

	test("each classified failure records its error.code and retryable, never the message (#4590)", async () => {
		const failures = [
			{ code: "moderation-blocked", retryable: false },
			{ code: "quota-exceeded", retryable: false },
			{ code: "rate-limited", retryable: true },
			{ code: "server-error", retryable: true },
			{ code: "timeout", retryable: true },
			{ code: "invalid-option", retryable: false },
			{ code: "user-error", retryable: false },
			{ code: "api-error", retryable: false },
		];
		for (const failure of failures) {
			const req = request();
			const { provider } = fakeProvider(openaiImagesCatalog(), () =>
				imagesResult({
					stopReason: "error",
					errorMessage: "PROMPT-TEXT-SECRET rate-limited quota-exceeded",
					error: {
						name: "ImageGenerationError",
						code: failure.code,
						message: "PROMPT-TEXT-SECRET rate-limited quota-exceeded",
						retryable: failure.retryable,
						fields: {},
					},
				}),
			);

			const status = await generate(req, provider);

			assert.deepEqual(
				status,
				{
					status: "failed",
					reason: failure.code,
					model: "openai-images/gpt-image-2.6-flare",
					paths: [],
					retryable: failure.retryable,
				},
				failure.code,
			);
			assert.equal(JSON.stringify(status).includes("PROMPT-TEXT-SECRET"), false);
			assert.equal(existsSync(join(req.artifactDir, "references")), false);
		}
	});

	test("a failure without a typed error is recorded as unclassified with no retryable claim (#4590)", async () => {
		const { provider } = fakeProvider(openaiImagesCatalog(), () =>
			imagesResult({ stopReason: "error", errorMessage: "Provider is not configured: openai-images" }),
		);

		const status = await generate(request(), provider);

		assert.deepEqual(status, {
			status: "failed",
			reason: "unclassified",
			model: "openai-images/gpt-image-2.6-flare",
			paths: [],
		});
	});

	test("a provider that throws is recorded as unexpected-error and generation of the others is not required (#4590)", async () => {
		const { provider } = fakeProvider(openaiImagesCatalog(), () => {
			throw new Error("socket hang up with PROMPT-TEXT-SECRET");
		});

		const status = await generate(request(), provider);

		assert.deepEqual(status, {
			status: "failed",
			reason: "unexpected-error",
			model: "openai-images/gpt-image-2.6-flare",
			paths: [],
		});
	});

	test("a provider factory or model lookup that throws is recorded as unexpected-error (#4590)", async () => {
		const brokenFactory = await generateReferenceImages(
			request(),
			async () => {
				throw new Error("provider import failed");
			},
			new AbortController().signal,
		);
		assert.deepEqual(brokenFactory, { status: "failed", reason: "unexpected-error", paths: [] });

		const brokenLookup = await generate(request(), {
			availableImageModels: async () => {
				throw new Error("credential store unreadable");
			},
			generateImages: async () => imagesResult(),
		});
		assert.deepEqual(brokenLookup, { status: "failed", reason: "unexpected-error", paths: [] });
	});

	test("one failed direction keeps the images that were generated (#4590)", async () => {
		const req = request();
		const { provider } = fakeProvider(openaiImagesCatalog(), (call) =>
			directionIndexOf(call.prompt) === 1
				? imagesResult({
						stopReason: "error",
						error: {
							name: "ImageModerationBlockedError",
							code: "moderation-blocked",
							message: "blocked",
							retryable: false,
							fields: {},
						},
					})
				: pngFor(call.prompt),
		);

		const status = await generate(req, provider);

		assert.deepEqual(status, {
			status: "generated",
			model: "openai-images/gpt-image-2.6-flare",
			paths: [
				join(req.artifactDir, "references", "01-reference-led.png"),
				join(req.artifactDir, "references", "03-information-dense.png"),
			],
		});
	});

	test("a stopped request with no usable image is recorded as no-images-written (#4590)", async () => {
		const unusable: AssistantImages["output"][] = [
			[],
			[{ type: "text", text: "I cannot draw that" }],
			[{ type: "image", mimeType: "image/png", data: "" }],
			[{ type: "image", mimeType: "image/svg+xml", data: base64Of("<svg/>") }],
			[{ type: "image", mimeType: "image/gif", data: base64Of("GIF89a") }],
		];
		for (const output of unusable) {
			const req = request();
			const { provider } = fakeProvider(openaiImagesCatalog(), () => imagesResult({ output }));

			const status = await generate(req, provider);

			assert.deepEqual(status, {
				status: "failed",
				reason: "no-images-written",
				model: "openai-images/gpt-image-2.6-flare",
				paths: [],
			});
			assert.equal(existsSync(join(req.artifactDir, "references")), false);
		}
	});

	test("takes the first usable image block when the provider returns several (#4590)", async () => {
		const req = request();
		const { provider } = fakeProvider(openaiImagesCatalog(), (call) =>
			imagesResult({
				output: [
					{ type: "text", text: "caption" },
					{ type: "image", mimeType: "image/svg+xml", data: base64Of("<svg/>") },
					{ type: "image", mimeType: "image/jpeg", data: base64Of(`first-${directionIndexOf(call.prompt)}`) },
					{ type: "image", mimeType: "image/png", data: base64Of("second") },
				],
			}),
		);

		const status = await generate(req, provider);

		assert.deepEqual(
			status.paths.map((path) => basename(path)),
			["01-reference-led.jpg", "02-brand-forward.jpg", "03-information-dense.jpg"],
		);
		assert.equal(readFileSync(status.paths[0] ?? "", "utf8"), "first-0".repeat(40));
	});

	test("a references directory that cannot be created is recorded as write-failed (#4590)", async () => {
		const artifactDir = join(tempDirectory(), "artifacts");
		mkdirSync(artifactDir, { recursive: true });
		writeFileSync(join(artifactDir, "references"), "a file where the directory belongs");
		const { provider } = fakeProvider(openaiImagesCatalog());

		const status = await generate(request({ artifactDir }), provider);

		assert.deepEqual(status, {
			status: "failed",
			reason: "write-failed",
			model: "openai-images/gpt-image-2.6-flare",
			paths: [],
		});
	});

	test("a working directory that is not a directory has no PRODUCT.md or DESIGN.md and does not stop generation (#4590)", async () => {
		const workflowCwd = join(tempDirectory(), "not-a-directory");
		writeFileSync(workflowCwd, "a file where the project directory should be");
		const { provider, calls } = fakeProvider(openaiImagesCatalog());

		const status = await generate(request({ workflowCwd }), provider);

		assert.equal(status.status, "generated");
		assert.equal(calls.length, REFERENCE_IMAGE_DIRECTIONS.length);
	});

	test("a classified failure outranks a direction that returned no image, and the first classified failure wins (#4590)", async () => {
		const failure = (code: string, retryable: boolean) =>
			imagesResult({
				stopReason: "error",
				error: { name: "ImageGenerationError", code, message: "failed", retryable, fields: {} },
			});
		const { provider } = fakeProvider(openaiImagesCatalog(), (call) => {
			const index = directionIndexOf(call.prompt);
			if (index === 0) return imagesResult({ output: [] });
			return index === 1 ? failure("rate-limited", true) : failure("quota-exceeded", false);
		});

		const status = await generate(request(), provider);

		assert.deepEqual(status, {
			status: "failed",
			reason: "rate-limited",
			model: "openai-images/gpt-image-2.6-flare",
			paths: [],
			retryable: true,
		});
	});

	test("cancellation is rethrown from every step and never recorded as a failure (#4590)", async () => {
		const reason = new Error("run quit");
		const aborted = () => {
			const controller = new AbortController();
			controller.abort(reason);
			return controller.signal;
		};

		await assert.rejects(
			generateReferenceImages(
				request(),
				async () => {
					throw new Error("provider import interrupted");
				},
				aborted(),
			),
			(error) => error === reason,
		);

		await assert.rejects(
			generate(
				request(),
				{
					availableImageModels: async () => {
						throw new Error("lookup interrupted");
					},
					generateImages: async () => imagesResult(),
				},
				aborted(),
			),
			(error) => error === reason,
		);

		const controller = new AbortController();
		const { provider } = fakeProvider(openaiImagesCatalog(), () => {
			controller.abort(reason);
			return imagesResult({ stopReason: "aborted", errorMessage: "Request was aborted" });
		});
		await assert.rejects(generate(request(), provider, controller.signal), (error) => error === reason);

		const throwing = new AbortController();
		const { provider: throwingProvider } = fakeProvider(openaiImagesCatalog(), () => {
			throwing.abort(reason);
			throw new Error("The operation was aborted");
		});
		await assert.rejects(generate(request(), throwingProvider, throwing.signal), (error) => error === reason);
	});
});

describe("open-claude-design reference images: the durable tool node", () => {
	type ToolCall = {
		readonly name: string;
		readonly args: Readonly<Record<string, WorkflowSerializableValue>>;
		readonly options: { readonly timeoutMs?: number; readonly failureMode?: string } | undefined;
	};

	function recordingTool(outcome?: { ok: boolean }) {
		const calls: ToolCall[] = [];
		const tool = (async (
			name: string,
			args: Readonly<Record<string, WorkflowSerializableValue>>,
			fn: (handle: { signal: AbortSignal }) => Promise<WorkflowSerializableValue>,
			options?: ToolCall["options"],
		) => {
			calls.push({ name, args, options });
			if (outcome?.ok === false) {
				return { ok: false, error: { name: "TimeoutError", message: "timed out" }, attempts: 1, cached: false };
			}
			return { ok: true, value: await fn({ signal: new AbortController().signal }), attempts: 1, cached: false };
		}) as unknown as Parameters<typeof runReferenceImagesStep>[0];
		return { tool, calls };
	}

	test("runs as one durable node with an explicit positive timeout and failureMode return (#4590)", async () => {
		const { tool, calls } = recordingTool();
		const { provider } = fakeProvider(openaiImagesCatalog());

		const status = await runReferenceImagesStep(tool, request(), { createImageProvider: async () => provider });

		assert.equal(status.status, "generated");
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.name, "reference-images");
		assert.equal(calls[0]?.options?.failureMode, "return");
		assert.equal(calls[0]?.options?.timeoutMs, REFERENCE_IMAGES_TOOL_TIMEOUT_MS);
		assert.ok(Number.isFinite(REFERENCE_IMAGES_TOOL_TIMEOUT_MS) && REFERENCE_IMAGES_TOOL_TIMEOUT_MS > 0);
	});

	test("the node arguments identify the request without carrying file contents or image data (#4590)", async () => {
		const { tool, calls } = recordingTool();
		const { provider } = fakeProvider(openaiImagesCatalog());
		const req = request({ imageModel: "openai-images/gpt-image-1", curatedReferences: "CURATED-MARKER" });

		await runReferenceImagesStep(tool, req, { createImageProvider: async () => provider });

		assert.deepEqual(calls[0]?.args, {
			brief: req.brief,
			outputType: req.outputType,
			artifactDir: req.artifactDir,
			imageModel: "openai-images/gpt-image-1",
		});
		assert.equal(JSON.stringify(calls[0]?.args).includes("CURATED-MARKER"), false);
	});

	test("an unset override is left out of the node arguments (#4590)", async () => {
		const { tool, calls } = recordingTool();
		const { provider } = fakeProvider([]);
		const req = request();

		await runReferenceImagesStep(tool, req, { createImageProvider: async () => provider });

		assert.deepEqual(Object.keys(calls[0]?.args ?? {}).sort(), ["artifactDir", "brief", "outputType"]);
	});

	test("a failed tool outcome, such as the outer timeout, becomes a failed status instead of an error (#4590)", async () => {
		const { tool } = recordingTool({ ok: false });
		const { provider } = fakeProvider(openaiImagesCatalog());

		const status = await runReferenceImagesStep(tool, request(), { createImageProvider: async () => provider });

		assert.deepEqual(status, { status: "failed", reason: "tool-failed", paths: [] });
	});

	test("lists only generated images that still exist on disk, in direction order (#4590)", () => {
		const directory = tempDirectory();
		const first = join(directory, "01-a.png");
		const second = join(directory, "02-b.png");
		writeFileSync(first, "x");
		writeFileSync(second, "y");
		const missing = join(directory, "03-gone.png");

		assert.deepEqual(existingReferenceImagePaths({ status: "generated", paths: [first, missing, second] }), [
			first,
			second,
		]);
		assert.deepEqual(existingReferenceImagePaths({ status: "failed", paths: [first] }), []);
		assert.deepEqual(existingReferenceImagePaths({ status: "skipped", paths: [first] }), []);
	});
});

describe("open-claude-design reference images: builtin provider", () => {
	test("lists no image model without credentials, so the default flow skips (#4590)", async () => {
		const provider = await createBuiltinReferenceImageProvider(AuthStorage.inMemory({}));
		assert.deepEqual(await provider.availableImageModels(new AbortController().signal), []);
	});

	test("the builtin model lookup honors cancellation (#4590)", async () => {
		const provider = await createBuiltinReferenceImageProvider(
			AuthStorage.inMemory({ "openai-api": { type: "api_key", key: "sk-test-4590" } }),
		);
		const reason = new Error("run quit");
		const controller = new AbortController();
		controller.abort(reason);

		await assert.rejects(provider.availableImageModels(controller.signal), (error) => error === reason);
		const available = await provider.availableImageModels(new AbortController().signal);
		assert.ok(available.length >= 1);
	});

	test("an OpenAI API key makes gpt-image-2.6-flare the choice, and the request reaches the wire with the quality and prompt (#4590)", async () => {
		const credentials = AuthStorage.inMemory({ "openai-api": { type: "api_key", key: "sk-test-4590" } });
		const builtin = await createBuiltinReferenceImageProvider(credentials);
		const requests: { url: string; body: Record<string, unknown>; authorization: string | null }[] = [];
		const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requests.push({
				url: String(input instanceof Request ? input.url : input),
				body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
				authorization: new Headers(init?.headers).get("authorization"),
			});
			return new Response(JSON.stringify({ data: [{ b64_json: base64Of("wire-pixels") }], output_format: "png" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
		const provider: ReferenceImageProvider = {
			availableImageModels: builtin.availableImageModels,
			generateImages: (model, context, options) =>
				builtin.generateImages(model, context, { ...options, fetch: fakeFetch as typeof fetch }),
		};
		const req = request({ curatedReferences: "CURATED-MARKER" });

		const status = await generate(req, provider);

		assert.equal(status.status, "generated");
		assert.equal(status.model, "openai-images/gpt-image-2.6-flare");
		assert.equal(requests.length, REFERENCE_IMAGE_DIRECTIONS.length);
		for (const wire of requests) {
			assert.match(wire.url, /\/images\/generations$/);
			assert.equal(wire.body.model, "gpt-image-2.6-flare");
			assert.equal(wire.body.quality, "high");
			assert.equal(wire.body.size, "1536x1024");
			assert.equal(wire.body.n, 1);
			assert.match(String(wire.body.prompt), /A kanban board for a support team/);
			assert.match(String(wire.body.prompt), /CURATED-MARKER/);
			assert.equal(wire.authorization, "Bearer sk-test-4590");
		}
		assert.equal(JSON.stringify(status).includes("sk-test-4590"), false);
		for (const path of status.paths) assert.equal(readFileSync(path, "utf8"), "wire-pixels".repeat(40));
	});
});

describe("open-claude-design reference images: status schema", () => {
	test("accepts every status the step produces and rejects shapes it never produces (#4590)", () => {
		const valid: unknown[] = [
			{ status: "skipped", reason: "no-image-model", paths: [] },
			{ status: "generated", model: "openai-images/gpt-image-2.6-flare", paths: ["/a/01.png", "/a/02.png"] },
			{ status: "failed", reason: "rate-limited", model: "openai-images/gpt-image-1", paths: [], retryable: true },
		];
		for (const status of valid)
			assert.equal(Value.Check(referenceImagesStatusSchema, status), true, JSON.stringify(status));

		const invalid: unknown[] = [
			{ status: "done", paths: [] },
			{ status: "skipped" },
			{ status: "skipped", paths: "none" },
			{ status: "skipped", paths: [1] },
			{ status: "skipped", paths: [], reason: 1 },
			{ status: "skipped", paths: [], model: 1 },
			{ status: "failed", paths: [], retryable: "yes" },
			{ status: "skipped", paths: [], extra: true },
			{ paths: [] },
			"skipped",
		];
		for (const status of invalid)
			assert.equal(Value.Check(referenceImagesStatusSchema, status), false, JSON.stringify(status));
		for (const status of ["skipped", "generated", "failed"]) {
			assert.equal(Value.Check(referenceImagesStatusSchema, { status, paths: [] }), true, status);
		}
	});

	test("the statuses produced by generation, failure and skipping all satisfy the schema (#4590)", async () => {
		const failing = fakeProvider(openaiImagesCatalog(), () =>
			imagesResult({
				stopReason: "error",
				error: {
					name: "ImageModerationBlockedError",
					code: "moderation-blocked",
					message: "x",
					retryable: false,
					fields: {},
				},
			}),
		);
		const produced = [
			await generate(request(), fakeProvider(openaiImagesCatalog()).provider),
			await generate(request(), failing.provider),
			await generate(request(), fakeProvider([]).provider),
			await generate(request({ imageModel: "nope/none" }), fakeProvider(openaiImagesCatalog()).provider),
		];
		assert.deepEqual(
			produced.map((status) => status.status),
			["generated", "failed", "skipped", "skipped"],
		);
		for (const status of produced)
			assert.equal(Value.Check(referenceImagesStatusSchema, status), true, JSON.stringify(status));
	});
});

const GENERATE_PROMPT_TAGS = [
	"design_brief",
	"design_context_file",
	"reference_context",
	"reference_inspiration_file",
	"reference_precedence",
	"preview_artifact_path",
	"html_rules",
	"anti_design_slop_rules",
	"role",
	"objective",
	"instructions",
	"output_format",
];

const EXPORTER_PROMPT_TAGS = [
	"design_context_file",
	"reference_inspiration_file",
	"preview_artifact_path",
	"spec_artifact_path",
	"final_design_summary",
	"html_rules",
	"anti_design_slop_rules",
	"role",
	"objective",
	"instructions",
	"output_format",
];

function promptTags(prompt: string): string[] {
	return [...prompt.matchAll(/^<([A-Za-z_]+)>$/gm)].map((match) => match[1] ?? "");
}

function promptSection(prompt: string, tag: string): string {
	return new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(prompt)?.[1] ?? "";
}

function instructionLines(prompt: string): number {
	return promptSection(prompt, "instructions").split("\n").length;
}

type FlowOptions = {
	readonly inputs?: { readonly discover_references?: boolean; readonly image_model?: string };
	readonly models?: readonly ReferenceImageModel[];
	readonly respond?: Parameters<typeof fakeProvider>[1];
	readonly references?: string[];
	readonly referenceDiscovery?: string;
	readonly toolOverride?: (name: string) => WorkflowSerializableValue | undefined;
	readonly files?: Readonly<Record<string, string>>;
};

async function runFlow(options: FlowOptions = {}) {
	const cwd = tempDirectory();
	for (const [name, content] of Object.entries(options.files ?? {})) writeFileSync(join(cwd, name), content);
	const ctx = makeMockCtx(
		{ prompt: "Design a kanban board", ...options.inputs },
		{
			cwd,
			task: (name) => {
				if (name === "discovery") {
					return JSON.stringify({
						brief: "A kanban board component for a support team.",
						output_type: "component",
						references: options.references ?? [],
					});
				}
				if (name === "reference-discovery")
					return options.referenceDiscovery ?? "CURATED-REFERENCES-TEXT strong list density";
				return undefined;
			},
			...(options.toolOverride === undefined ? {} : { tool: (name) => options.toolOverride?.(name) }),
		},
	);
	const tasksWhenGenerating: string[][] = [];
	const fake = fakeProvider(options.models ?? [], (call) => {
		tasksWhenGenerating.push([...ctx.calls.task]);
		return (options.respond ?? ((pending) => pngFor(pending.prompt)))(call);
	});
	const result = await runOpenClaudeDesignWorkflow(ctx, { createImageProvider: async () => fake.provider });
	directories.push(String(result.artifact_dir));
	return { ctx, result, fake, cwd, tasksWhenGenerating };
}

function generationReads(ctx: Awaited<ReturnType<typeof runFlow>>["ctx"]): readonly string[] {
	return readPaths(ctx.calls.taskOptions["generate-1"]?.[0]).map((path) => basename(path));
}

describe("open-claude-design reference images: workflow flow", () => {
	test("with no image model the flow is unchanged and nothing warns the user (#4590)", async () => {
		const { ctx, result } = await runFlow({ models: [] });

		assert.deepEqual(result.reference_images_status, { status: "skipped", reason: "no-image-model", paths: [] });
		assert.deepEqual(generationReads(ctx), ["design-context.md", "references.md"]);
		assert.deepEqual(
			readPaths(ctx.calls.taskOptions.exporter?.[0]).map((path) => basename(path)),
			["design-context.md", "references.md"],
		);
		for (const name of ["generate-1", "exporter", "user-feedback-1-start"]) {
			for (const prompt of ctx.calls.prompts[name] ?? []) {
				assert.equal(prompt.includes("reference_images"), false, name);
				assert.equal(prompt.includes("references/"), false, name);
			}
		}
		assert.equal(ctx.calls.taskOptions["generate-1"]?.[0]?.taskNeeds, undefined);
		assert.equal(ctx.calls.uiSelects.length, 1);
		assert.equal(ctx.calls.uiSelects[0]?.message.includes("Reference images"), false);
		assert.deepEqual(promptTags(ctx.calls.prompts["generate-1"]?.[0] ?? ""), GENERATE_PROMPT_TAGS);
		assert.equal(instructionLines(ctx.calls.prompts["generate-1"]?.[0] ?? ""), 6);
		assert.deepEqual(promptTags(ctx.calls.prompts.exporter?.[0] ?? ""), EXPORTER_PROMPT_TAGS);
		assert.equal(instructionLines(ctx.calls.prompts.exporter?.[0] ?? ""), 4);
		const startPrompt = ctx.calls.prompts["user-feedback-1-start"]?.[0] ?? "";
		assert.equal((startPrompt.match(/^\d+\. /gm) ?? []).length, 4);
		assert.equal(startPrompt.includes("reference_images"), false);
		assert.equal(existsSync(join(String(result.artifact_dir), "references")), false);
		assert.deepEqual(ctx.calls.task, [
			"discovery",
			"ds-locator",
			"ds-analyzer",
			"ds-patterns",
			"reference-discovery",
			"generate-1",
			"user-feedback-1-start",
			"exporter",
			"final-display",
		]);
	});

	test("generation failures never fail the run, leave the flow as it was, and are recorded in reference_images_status (#4590)", async () => {
		const unchanged = await runFlow({ models: [] });
		const { ctx, result } = await runFlow({
			models: openaiImagesCatalog(),
			respond: () =>
				imagesResult({
					stopReason: "error",
					error: {
						name: "ImageModerationBlockedError",
						code: "moderation-blocked",
						message: "blocked",
						retryable: false,
						fields: {},
					},
				}),
		});

		assert.deepEqual(result.reference_images_status, {
			status: "failed",
			reason: "moderation-blocked",
			model: "openai-images/gpt-image-2.6-flare",
			paths: [],
			retryable: false,
		});
		assert.deepEqual(ctx.calls.task, unchanged.ctx.calls.task);
		assert.deepEqual(generationReads(ctx), generationReads(unchanged.ctx));
		assert.equal(ctx.calls.prompts["generate-1"]?.[0]?.includes("reference_images"), false);
		assert.equal(ctx.calls.uiSelects.length, 1);
		assert.equal(typeof result.handoff, "string");
	});

	test("a failed tool outcome is recorded and the run still completes (#4590)", async () => {
		const { ctx, result } = await runFlow({
			models: openaiImagesCatalog(),
			toolOverride: (name) =>
				name === "reference-images"
					? { ok: false, error: { name: "TimeoutError", message: "timed out" }, attempts: 1, cached: false }
					: undefined,
		});

		assert.deepEqual(result.reference_images_status, { status: "failed", reason: "tool-failed", paths: [] });
		assert.ok(ctx.calls.task.includes("exporter"));
		assert.deepEqual(generationReads(ctx), ["design-context.md", "references.md"]);
	});

	test("the step runs once as a durable tool node after reference discovery and before generation (#4590)", async () => {
		const { ctx, tasksWhenGenerating } = await runFlow({ models: openaiImagesCatalog() });

		assert.equal(ctx.calls.tool.filter((name) => name === "reference-images").length, 1);
		assert.equal(ctx.calls.toolOptions["reference-images"]?.[0]?.failureMode, "return");
		assert.ok((ctx.calls.toolOptions["reference-images"]?.[0]?.timeoutMs ?? 0) > 0);
		assert.equal(tasksWhenGenerating.length, REFERENCE_IMAGE_DIRECTIONS.length);
		for (const tasks of tasksWhenGenerating) {
			assert.ok(tasks.includes("reference-discovery"));
			assert.equal(tasks.includes("generate-1"), false);
		}
	});

	test("when an image model exists the generation stage receives the image paths via reads and a prompt section (#4590)", async () => {
		const { ctx, result, cwd } = await runFlow({
			models: openaiImagesCatalog(),
			files: { "PRODUCT.md": "PRODUCT-FILE-MARKER", "DESIGN.md": "DESIGN-FILE-MARKER" },
		});

		const status = result.reference_images_status as ReferenceImagesStatus;
		assert.equal(status.status, "generated");
		assert.equal(status.paths.length, REFERENCE_IMAGE_DIRECTIONS.length);
		const referencesDir = join(String(result.artifact_dir), "references");
		assert.deepEqual(status.paths, [
			join(referencesDir, "01-reference-led.png"),
			join(referencesDir, "02-brand-forward.png"),
			join(referencesDir, "03-information-dense.png"),
		]);
		for (const path of status.paths) assert.ok(existsSync(path), path);

		const reads = readPaths(ctx.calls.taskOptions["generate-1"]?.[0]);
		assert.deepEqual(reads, [
			join(String(result.artifact_dir), "design-context.md"),
			join(String(result.artifact_dir), "references.md"),
			...status.paths,
		]);
		assert.deepEqual(ctx.calls.taskOptions["generate-1"]?.[0]?.taskNeeds, { needsImages: true });
		assert.equal(ctx.calls.taskOptions["generate-1"]?.[0]?.model, "auto");
		const prompt = ctx.calls.prompts["generate-1"]?.[0] ?? "";
		const section = promptSection(prompt, "reference_images").split("\n");
		assert.equal(
			section[0],
			"AI-generated design reference images for this brief, one per visual direction (named by file). They were rendered from the brief, PRODUCT.md/DESIGN.md, and the curated references.",
		);
		assert.deepEqual(
			section.slice(1),
			status.paths.map((path) => `- ${path}`),
		);
		assert.deepEqual(promptTags(prompt), [
			...GENERATE_PROMPT_TAGS.slice(0, 4),
			"reference_images",
			...GENERATE_PROMPT_TAGS.slice(4),
		]);
		assert.equal(instructionLines(prompt), 7);
		assert.match(prompt, /Open every file listed in <reference_images> with the read tool/);
		assert.match(prompt, /match its composition, palette, type character, density, and imagery stance/);
		assert.equal(existsSync(join(cwd, "references")), false);
	});

	test("the live review gate and session-start prompt show the images, and the spec links them relative to spec.html (#4590)", async () => {
		const { ctx, result } = await runFlow({ models: openaiImagesCatalog() });

		const status = result.reference_images_status as ReferenceImagesStatus;
		const gate = ctx.calls.uiSelects[0]?.message ?? "";
		const start = ctx.calls.prompts["user-feedback-1-start"]?.[0] ?? "";
		const exporter = ctx.calls.prompts.exporter?.[0] ?? "";
		for (const path of status.paths) {
			assert.ok(gate.includes(`- ${path} (file://${path})`), path);
			assert.ok(start.includes(`${path} (file://${path})`), path);
			assert.ok(exporter.includes(`- ${path} (src="references/${basename(path)}")`), path);
		}
		assert.deepEqual(
			promptSection(start, "reference_images").split("\n"),
			status.paths.map((path) => `${path} (file://${path})`),
		);
		assert.equal((start.match(/^\d+\. /gm) ?? []).length, 5);
		const exportSection = promptSection(exporter, "reference_images").split("\n");
		assert.equal(
			exportSection[0],
			"AI-generated design reference images, one per visual direction (named by file), stored next to the spec. They are illustrations, not specifications.",
		);
		assert.deepEqual(
			exportSection.slice(1),
			status.paths.map((path) => `- ${path} (src="references/${basename(path)}")`),
		);
		assert.deepEqual(promptTags(exporter), [
			...EXPORTER_PROMPT_TAGS.slice(0, 4),
			"reference_images",
			...EXPORTER_PROMPT_TAGS.slice(4),
		]);
		assert.equal(instructionLines(exporter), 5);
		assert.match(exporter, /Design References/);
		assert.match(exporter, /never inline their data into the HTML/);
	});

	test("the exporter is given the image paths in its prompt without reading the image files (#4590)", async () => {
		const { ctx } = await runFlow({ models: openaiImagesCatalog() });

		assert.deepEqual(
			readPaths(ctx.calls.taskOptions.exporter?.[0]).map((path) => basename(path)),
			["design-context.md", "references.md"],
		);
		assert.equal(ctx.calls.taskOptions.exporter?.[0]?.taskNeeds, undefined);
	});

	test("base64 image data never reaches the node result, outputs, tool arguments or prompts (#4590)", async () => {
		const { ctx, result } = await runFlow({ models: openaiImagesCatalog() });

		const status = result.reference_images_status as ReferenceImagesStatus;
		assert.equal(status.status, "generated");
		for (let index = 0; index < REFERENCE_IMAGE_DIRECTIONS.length; index += 1) {
			const encoded = base64Of(`direction-${index}-pixels`);
			const needle = encoded.slice(0, 48);
			assert.equal(JSON.stringify(result).includes(needle), false);
			assert.equal(JSON.stringify(ctx.calls.toolArgs).includes(needle), false);
			assert.equal(JSON.stringify(ctx.calls.taskOptions).includes(needle), false);
			assert.equal(JSON.stringify(ctx.calls.prompts).includes(needle), false);
			assert.equal(JSON.stringify(ctx.calls.uiSelects).includes(needle), false);
			assert.equal(readFileSync(status.paths[index] ?? "", "utf8"), `direction-${index}-pixels`.repeat(40));
		}
	});

	test("reference_images_status records generated, the model and the paths (#4590)", async () => {
		const { result } = await runFlow({ models: openaiImagesCatalog() });

		const referencesDir = join(String(result.artifact_dir), "references");
		assert.deepEqual(result.reference_images_status, {
			status: "generated",
			model: "openai-images/gpt-image-2.6-flare",
			paths: [
				join(referencesDir, "01-reference-led.png"),
				join(referencesDir, "02-brand-forward.png"),
				join(referencesDir, "03-information-dense.png"),
			],
		});
	});

	test("the image_model input overrides the choice for the whole run (#4590)", async () => {
		const { fake, result } = await runFlow({
			models: openaiImagesCatalog(),
			inputs: { image_model: "openai-images/gpt-image-1.5" },
		});

		assert.equal((result.reference_images_status as ReferenceImagesStatus).model, "openai-images/gpt-image-1.5");
		assert.ok(fake.calls.length > 0);
		assert.ok(fake.calls.every((call) => call.model.id === "gpt-image-1.5"));
	});

	test("an image_model that is not available skips the images and leaves the flow unchanged (#4590)", async () => {
		const { ctx, result, fake } = await runFlow({
			models: openaiImagesCatalog(),
			inputs: { image_model: "openai-images/gpt-image-9" },
		});

		assert.deepEqual(result.reference_images_status, {
			status: "skipped",
			reason: "image-model-unavailable",
			paths: [],
		});
		assert.equal(fake.calls.length, 0);
		assert.deepEqual(generationReads(ctx), ["design-context.md", "references.md"]);
	});

	test("with discover_references=false the images are still generated, without curated references (#4590)", async () => {
		const { fake, result } = await runFlow({
			models: openaiImagesCatalog(),
			inputs: { discover_references: false },
		});

		assert.equal((result.reference_images_status as ReferenceImagesStatus).status, "generated");
		for (const call of fake.calls) {
			assert.equal(call.prompt.includes("Curated references"), false);
			assert.equal(call.prompt.includes("Reference discovery was skipped"), false);
		}
	});

	test("curated references and PRODUCT.md/DESIGN.md reach the image prompts through the flow (#4590)", async () => {
		const { fake } = await runFlow({
			models: openaiImagesCatalog(),
			files: { "PRODUCT.md": "PRODUCT-FILE-MARKER", "DESIGN.md": "DESIGN-FILE-MARKER" },
			referenceDiscovery: "CURATED-REFERENCES-TEXT strong list density",
		});

		assert.equal(fake.calls.length, REFERENCE_IMAGE_DIRECTIONS.length);
		for (const call of fake.calls) {
			assert.ok(call.prompt.includes("A kanban board component for a support team."));
			assert.ok(call.prompt.includes("CURATED-REFERENCES-TEXT"));
			assert.ok(call.prompt.includes("PRODUCT-FILE-MARKER"));
			assert.ok(call.prompt.includes("DESIGN-FILE-MARKER"));
		}
	});

	test("a cached generated status whose files are gone passes no image reads to generation (#4590)", async () => {
		const directory = tempDirectory();
		const { ctx } = await runFlow({
			models: openaiImagesCatalog(),
			toolOverride: (name) =>
				name === "reference-images"
					? {
							ok: true,
							value: {
								status: "generated",
								model: "openai-images/gpt-image-2.6-flare",
								paths: [join(directory, "01-reference-led.png")],
							},
							attempts: 1,
							cached: true,
						}
					: undefined,
		});

		assert.deepEqual(generationReads(ctx), ["design-context.md", "references.md"]);
		assert.equal(ctx.calls.prompts["generate-1"]?.[0]?.includes("reference_images"), false);
	});
});

const BASE_GATE_MESSAGE = [
	"Design review session 1 is ready for your browser review.",
	"",
	"Preview file: /run/preview.html",
	"Preview URL: file:///run/preview.html",
	"",
	'"Start live review" opens an interactive browser session; the session-start stage prints the live http:// review URL as soon as its server is up (attach with /workflow connect to see it, or open the preview URL above directly).',
	"The session is unbounded: pick elements, accept variants, and steer for as long as you like, and everything you accept lands in the preview as you go.",
	"",
	"YOU end the review, and nothing else does. It keeps waiting through any amount of silence.",
	'End it by clicking exit in the Impeccable overlay, closing the browser tab, or saying "exit live".',
	"The moment you do, the design you are looking at is exported. There is no further round and no confirmation, so end the session only when the preview is what you want handed off.",
	'"Skip remaining review rounds and export as-is" accepts the current design and proceeds to export without opening a session.',
].join("\n");

const BASE_SESSION_START_PROMPT = [
	"<preview_path>/run/preview.html</preview_path>",
	"",
	"<preview_file_url>file:///run/preview.html</preview_file_url>",
	"",
	"<browser_use_guidelines><rules/></browser_use_guidelines>",
	"",
	"<role>You are an opinionated staff design engineer opening an impeccable `live` review session.</role>",
	"",
	"<objective>",
	"Start review session 1: boot live against the static preview and open it in the user's browser. Then STOP.",
	"</objective>",
	"",
	"<instructions>",
	"1. Drive `/skill:impeccable live` against the static preview: run the bundled launcher's `impeccable live` verb with `--target` pointed at the preview file, or the equivalent `.impeccable/live/config.json` entry, and open the URL that serves it.",
	"2. Print the live `http://` review URL in plain text, plus the preview file URL as the manual fallback, so anyone attaching to this run can find the review.",
	"3. Directly under the URL, print how the user ends the review, in plain text: click exit in the Impeccable overlay, close the browser tab, or say `exit live`. State that the review waits indefinitely until they do, and that ending it exports the design as it then stands, with no further round.",
	"4. Do NOT start a poll loop. The workflow owns polling and will call you back for each event that needs you. Ending your turn does not end the review.",
	"</instructions>",
	"",
	"<output_format>Under 150 words: the live review URL, the manual fallback path, how to end the review, and whether the browser opened.</output_format>",
].join("\n");

describe("open-claude-design reference images: workflow definition", () => {
	test("declares the optional image_model input with its provider/id description (#4590)", () => {
		const schema = openClaudeDesign.inputs.image_model;
		assert.ok(schema);
		assert.equal(schemaFieldKind(schema), "text");
		assert.equal(schemaIsRequired(schema), false);
		const description = schemaDescription(schema) ?? "";
		assert.match(
			description,
			/^Image model for design reference images, as provider\/id \(for example openai-images\/gpt-image-2\.6-flare\)\./,
		);
		assert.match(description, /newest available GPT Image model/);
		assert.match(description, /skipped when no image model is available\.$/);
	});

	test("declares reference_images_status as an optional object with a description (#4590)", () => {
		const schema = openClaudeDesign.outputs?.reference_images_status;
		assert.ok(schema);
		assert.equal(schemaFieldKind(schema), "object");
		assert.equal(schemaIsRequired(schema), false);
		assert.match(
			schemaDescription(schema) ?? "",
			/^Outcome of the reference image step: status \(skipped, generated, or failed\)/,
		);
	});
});

describe("open-claude-design reference images: review surfaces", () => {
	const paths = ["/run/references/01-reference-led.png", "/run/references/02-brand-forward.png"];

	test("the gate message is unchanged without images and lists each image with its file URL with them (#4590)", () => {
		const base = { round: 1, previewPath: "/run/preview.html", previewFileUrl: "file:///run/preview.html" };
		const without = buildLiveReviewGateMessage(base);
		assert.equal(without, BASE_GATE_MESSAGE);
		assert.equal(buildLiveReviewGateMessage({ ...base, referenceImagePaths: [] }), BASE_GATE_MESSAGE);

		const withImages = buildLiveReviewGateMessage({ ...base, referenceImagePaths: paths });
		assert.equal(
			withImages,
			BASE_GATE_MESSAGE.replace(
				"Preview URL: file:///run/preview.html\n",
				[
					"Preview URL: file:///run/preview.html",
					"",
					"Reference images (AI-generated design directions the preview was built from):",
					...paths.map((path) => `- ${path} (file://${path})`),
					"",
				].join("\n"),
			),
		);
	});

	test("the session-start prompt is unchanged without images and prints each image with them (#4590)", () => {
		const base = {
			previewPath: "/run/preview.html",
			previewFileUrl: "file:///run/preview.html",
			browserBootstrapRules: "<rules/>",
			round: 1,
		};
		const without = buildLiveSessionStartPrompt(base);
		assert.equal(without, BASE_SESSION_START_PROMPT);
		assert.equal(buildLiveSessionStartPrompt({ ...base, referenceImagePaths: [] }), BASE_SESSION_START_PROMPT);

		const withImages = buildLiveSessionStartPrompt({ ...base, referenceImagePaths: paths });
		const section = /<reference_images>\n([\s\S]*?)\n<\/reference_images>/.exec(withImages)?.[1];
		assert.equal(section, paths.map((path) => `${path} (file://${path})`).join("\n"));
		assert.match(withImages, /^5\. Under the review URL, also print each <reference_images> path/m);
		assert.match(withImages, /Leave the live review tab on the preview\./);
		assert.match(withImages, /Do NOT start a poll loop/);
	});

	test("file URLs and spec-relative sources follow the preview convention (#4590)", () => {
		assert.equal(referenceImageFileUrl("/run/references/a.png"), "file:///run/references/a.png");
		assert.equal(referenceImageRelativeSrc("/run/spec.html", "/run/references/a.png"), "references/a.png");
		assert.equal(
			referenceImageRelativeSrc(join("/run", "spec.html"), join("/run", "references", "a.png")),
			"references/a.png",
		);
	});
});
