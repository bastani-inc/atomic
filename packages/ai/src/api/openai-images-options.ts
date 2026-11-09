import type { ImageEditParamsNonStreaming } from "openai/resources/images";
import { ImageGenerationConfigError, type ImageGenerationConfigReason } from "../image-generation-error.ts";
import type { ImageApi, ImageModel, ImagesInputContent, ImagesInputImage, ImagesOptions } from "../types.ts";

/**
 * Bounds the OpenAI Images API accepts for GPT Image 2.6 request fields. Requests outside them fail
 * before anything is sent. The image generation guide and the API reference both document 2-16 GIF
 * frames, and a live request with 17 frames was rejected ("Use an integer from 2 to 16", #4332).
 */
export const OPENAI_IMAGES_LIMITS = {
	gifFrameCount: { min: 2, max: 16 },
	gifFrameDurationMs: { min: 20, max: 2000 },
	outputCompression: { min: 0, max: 100 },
	safetyIdentifierMaxLength: 128,
} as const;

/**
 * The model SVG output retries with when the API answers that `svg.model` is required and the
 * request carried no `svg`. OpenAI's documentation names no SVG authoring model and no default:
 * the API reference says only that `svg.model` is required when SVG model selection is enabled
 * for the account. `gpt-6.1-sol` is a value observed to work (#4615), not a documented default.
 */
export const DEFAULT_SVG_AUTHOR_MODEL = "gpt-6.1-sol";

export type OpenAIImagesOutputFormat = "png" | "jpeg" | "webp" | "svg" | "gif";

/** The model that writes the SVG for `outputFormat: "svg"`, and its reasoning effort. */
export interface OpenAIImagesSvgOptions {
	/**
	 * Required by the API when SVG model selection is enabled for the account, and rejected when it is
	 * not. Leave `svg` out to let SVG output recover: when the API answers that `svg.model` is
	 * required, the request is retried once with {@link DEFAULT_SVG_AUTHOR_MODEL}.
	 */
	model: string;
	reasoning?: { effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" };
}

/**
 * Request options for OpenAI's Images API. Each field is sent only when set.
 *
 * Image blocks in the context go to `/images/edits`: the first image without a `role` is the base
 * image and every other image without a `role` is a reference. An image block with `role: "markup"`
 * is sent as the `markup` field and one with `role: "mask"` as the `mask` field; both apply to the
 * first image, and they cannot be combined.
 */
export interface OpenAIImagesOptions extends ImagesOptions {
	/** `auto`, a listed size, or a custom `WIDTHxHEIGHT` where the model supports one. */
	size?: "auto" | "1024x1024" | "1536x1024" | "1024x1536" | (string & {});
	quality?: "low" | "medium" | "high" | "xhigh" | "max" | "auto";
	/** Number of images to generate. SVG output requires 1. */
	n?: number;
	/** `transparent` needs a PNG or WebP output format. */
	background?: "transparent" | "opaque" | "auto";
	/**
	 * `svg` and `gif` are generation-only and need a model that supports them (GPT Image 2.6).
	 * `svg` returns UTF-8 XML as `image/svg+xml`; `gif` returns an animation as `image/gif`.
	 */
	outputFormat?: OpenAIImagesOutputFormat;
	/**
	 * Selects the model that authors the SVG. Needs `outputFormat: "svg"`; the API requires `svg.model`
	 * when SVG model selection is enabled for the account and rejects the field otherwise. Without
	 * `svg`, a request the API refuses for a missing `svg.model` is retried once with
	 * {@link DEFAULT_SVG_AUTHOR_MODEL}, and that retry is sent again without `svg` if the API rejects
	 * the field as unsupported. A `svg` you set is always sent as given and never retried or replaced.
	 */
	svg?: OpenAIImagesSvgOptions;
	/** 0-100, for `jpeg` and `webp` output only. */
	outputCompression?: number;
	/** GIF frames, an integer within {@link OPENAI_IMAGES_LIMITS}. The API defaults to 9. Needs `outputFormat: "gif"`. */
	frameCount?: number;
	/** Milliseconds per GIF frame, an integer within {@link OPENAI_IMAGES_LIMITS}; the API rounds to 10 ms and defaults to 200. Needs `outputFormat: "gif"`. */
	frameDurationMs?: number;
	/** How much the model plans before rendering. GPT Image 2.6 only; the API defaults to `high`. */
	complexity?: "low" | "medium" | "high";
	moderation?: "auto" | "low";
	/** A stable, privacy-preserving end-user identifier of at most 128 characters; sent as `safety_identifier`. */
	safetyIdentifier?: string;
}

/** The fields of an Images API request this provider validates. Upload fields are opaque here. */
export interface OpenAIImagesWireParams {
	model: string;
	prompt: string;
	size?: string;
	quality?: string;
	n?: number;
	background?: string;
	output_format?: string;
	output_compression?: number;
	frame_count?: number;
	frame_duration_ms?: number;
	complexity?: string;
	moderation?: string;
	safety_identifier?: string;
	svg?: OpenAIImagesSvgOptions;
	stream?: boolean;
	partial_images?: number;
	image?: ImageEditParamsNonStreaming["image"];
	markup?: object;
	mask?: object;
}

function fail(
	model: ImageModel<ImageApi>,
	field: string,
	reason: ImageGenerationConfigReason,
	detail: string,
	hint: string,
	related?: string,
): never {
	throw new ImageGenerationConfigError({ model: model.id, field, reason, related, detail, hint });
}

function checkIntegerRange(
	model: ImageModel<ImageApi>,
	field: string,
	value: number | undefined,
	range: { min: number; max: number },
): void {
	if (value === undefined) return;
	if (Number.isInteger(value) && value >= range.min && value <= range.max) return;
	fail(
		model,
		field,
		"out-of-range",
		`${field} must be an integer from ${range.min} to ${range.max}`,
		`Set ${field} to an integer from ${range.min} to ${range.max}.`,
	);
}

/**
 * Check a request against the Images API rules before it is sent, and throw an
 * {@link ImageGenerationConfigError} naming the first offending option. Runs on the request as it
 * will be sent, so it also covers a request an `onPayload` hook replaced.
 */
export function validateOpenAIImagesRequest(model: ImageModel<ImageApi>, params: OpenAIImagesWireParams): void {
	const format = params.output_format;
	const isEdit = params.image !== undefined;
	const isGif = format === "gif";
	const isSvg = format === "svg";

	checkIntegerRange(model, "frameCount", params.frame_count, OPENAI_IMAGES_LIMITS.gifFrameCount);
	checkIntegerRange(model, "frameDurationMs", params.frame_duration_ms, OPENAI_IMAGES_LIMITS.gifFrameDurationMs);
	checkIntegerRange(model, "outputCompression", params.output_compression, OPENAI_IMAGES_LIMITS.outputCompression);
	if (
		params.safety_identifier !== undefined &&
		params.safety_identifier.length > OPENAI_IMAGES_LIMITS.safetyIdentifierMaxLength
	) {
		fail(
			model,
			"safetyIdentifier",
			"out-of-range",
			`safetyIdentifier must be at most ${OPENAI_IMAGES_LIMITS.safetyIdentifierMaxLength} characters`,
			"Hash the user name or email address and send the digest.",
		);
	}

	for (const [field, value] of [
		["frameCount", params.frame_count],
		["frameDurationMs", params.frame_duration_ms],
	] as const) {
		if (value !== undefined && !isGif) {
			fail(
				model,
				field,
				"requires-option",
				`${field} applies to animated GIF output only`,
				'Set outputFormat to "gif" or remove the option.',
				"outputFormat",
			);
		}
	}

	if (params.svg !== undefined && !isSvg) {
		fail(
			model,
			"svg",
			"requires-option",
			"svg applies to SVG output only",
			'Set outputFormat to "svg" or remove the option.',
			"outputFormat",
		);
	}
	if ((isGif || isSvg) && isEdit) {
		fail(
			model,
			"outputFormat",
			"generation-only",
			`${format} output is available on generations only, not on edits`,
			"Remove the input images, or choose png, jpeg or webp.",
			"image",
		);
	}
	if (isSvg && params.n !== undefined && params.n !== 1) {
		fail(
			model,
			"n",
			"conflicts-with-option",
			"svg output requires n to be 1",
			"Set n to 1 or remove it.",
			"outputFormat",
		);
	}
	if ((isGif || isSvg) && (params.stream === true || params.partial_images !== undefined)) {
		const field = params.stream === true ? "stream" : "partialImages";
		fail(
			model,
			field,
			"conflicts-with-option",
			`${format} output does not support streaming or partial images`,
			`Remove ${field} from the request.`,
			"outputFormat",
		);
	}
	if (params.background === "transparent" && format !== undefined && format !== "png" && format !== "webp") {
		fail(
			model,
			"background",
			"conflicts-with-option",
			"transparent backgrounds require png or webp output",
			'Set outputFormat to "png" or "webp", or remove the transparent background.',
			"outputFormat",
		);
	}
	if (params.output_compression !== undefined && format !== "jpeg" && format !== "webp") {
		fail(
			model,
			"outputCompression",
			"conflicts-with-option",
			"outputCompression applies to jpeg and webp output only",
			'Set outputFormat to "jpeg" or "webp", or remove outputCompression.',
			"outputFormat",
		);
	}
	const hasBaseImage = Array.isArray(params.image) ? params.image.length > 0 : params.image != null;
	for (const role of ["markup", "mask"] as const) {
		if (params[role] !== undefined && !hasBaseImage) {
			fail(
				model,
				"input",
				"requires-base-image",
				`an image with role "${role}" needs a base image to apply to`,
				"Add an image without a role before it; the first image is the base.",
				role,
			);
		}
	}
	if (params.markup !== undefined && params.mask !== undefined) {
		fail(
			model,
			"markup",
			"conflicts-with-option",
			"a markup image cannot be combined with a mask image",
			'Remove the image with role "markup" or the one with role "mask".',
			"mask",
		);
	}

	const requireFeature = (
		field: string,
		used: boolean,
		feature: keyof NonNullable<ImageModel<ImageApi>["capabilities"]>,
	): void => {
		if (!used || model.capabilities?.[feature] === true) return;
		fail(
			model,
			field,
			"unsupported-by-model",
			`${model.id} does not support ${field}`,
			"Use a GPT Image 2.6 model (gpt-image-2.6-sunburst or gpt-image-2.6-flare).",
		);
	};
	requireFeature("complexity", params.complexity !== undefined, "complexity");
	requireFeature("outputFormat", isGif, "gif");
	requireFeature("outputFormat", isSvg, "svg");
	requireFeature("markup", params.markup !== undefined, "markup");
}

export interface PartitionedInputImages {
	/** Images without a role in order: the first is the base image and the rest are references. */
	images: ImagesInputImage[];
	markup?: ImagesInputImage;
	mask?: ImagesInputImage;
}

/** Split the image blocks of a request by role, rejecting roles the API cannot express. */
export function partitionInputImages(
	model: ImageModel<ImageApi>,
	input: readonly ImagesInputContent[],
): PartitionedInputImages {
	const blocks = input.filter((item): item is ImagesInputImage => item.type === "image");
	const images = blocks.filter((block) => block.role === undefined);
	const markups = blocks.filter((block) => block.role === "markup");
	const masks = blocks.filter((block) => block.role === "mask");
	for (const [role, found] of [
		["markup", markups],
		["mask", masks],
	] as const) {
		if (found.length > 1) {
			fail(
				model,
				"input",
				"duplicate-role",
				`at most one image can have role "${role}"`,
				`Keep one image with role "${role}".`,
				role,
			);
		}
		if (found.length === 1 && images.length === 0) {
			fail(
				model,
				"input",
				"requires-base-image",
				`an image with role "${role}" needs a base image to apply to`,
				"Add an image without a role before it; the first image is the base.",
				role,
			);
		}
	}
	return { images, markup: markups[0], mask: masks[0] };
}
