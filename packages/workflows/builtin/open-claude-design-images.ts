/**
 * open-claude-design reference images.
 *
 * When an image model is available, one durable `ctx.tool` node renders a few
 * distinct design directions for the confirmed brief and writes them under
 * `<artifact_dir>/references/`. Later stages receive file paths only: image
 * data stays inside the tool callback and never enters workflow state,
 * outputs, or prompts. With no image model, or on any generation failure, the
 * run continues unchanged and `reference_images_status` records why.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AuthStorage } from "@bastani/atomic";
import type {
  AssistantImages,
  CredentialStore,
  ImageApi,
  ImageModel,
  ImagesContext,
  OpenAIImagesOptions,
} from "@bastani/pi-ai";
import { builtinModels } from "@bastani/pi-ai/providers/all";
import { type Static, Type } from "typebox";
import type { WorkflowToolPrimitive } from "../src/shared/types.js";
import type { OutputType } from "./open-claude-design-utils.js";

export const referenceImagesStatusSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("skipped"), Type.Literal("generated"), Type.Literal("failed")]),
    reason: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    paths: Type.Array(Type.String()),
    retryable: Type.Optional(Type.Boolean()),
  },
  {
    additionalProperties: false,
    description:
      "Outcome of the reference image step: status (skipped, generated, or failed), the reason, the model used, the image paths under <artifact_dir>/references/, and whether a failure is retryable.",
  },
);

export type ReferenceImagesStatus = Static<typeof referenceImagesStatusSchema>;

export type ReferenceImageModel = ImageModel<ImageApi>;

export type ReferenceImageProvider = {
  availableImageModels(signal: AbortSignal): Promise<readonly ReferenceImageModel[]>;
  generateImages(
    model: ReferenceImageModel,
    context: ImagesContext,
    options: OpenAIImagesOptions,
  ): Promise<AssistantImages>;
};

export type ReferenceImagesDeps = {
  readonly createImageProvider?: () => Promise<ReferenceImageProvider>;
};

export type ReferenceImagesRequest = {
  readonly brief: string;
  readonly outputType: OutputType;
  readonly artifactDir: string;
  readonly workflowCwd: string;
  readonly curatedReferences: string;
  readonly imageModel?: string;
};

const REFERENCE_IMAGES_DIRNAME = "references";
export const REFERENCE_IMAGES_TOOL_TIMEOUT_MS = 15 * 60_000;
const IMAGE_REQUEST_TIMEOUT_MS = 5 * 60_000;
const IMAGE_REQUEST_MAX_RETRIES = 1;
const IMAGE_SIZE = "1536x1024";

const PRODUCT_EXCERPT_CHARS = 1_000;
const DESIGN_EXCERPT_CHARS = 1_500;
const REFERENCES_EXCERPT_CHARS = 1_500;

type ReferenceImageDirection = { readonly slug: string; readonly composition: string };

export const REFERENCE_IMAGE_DIRECTIONS: readonly ReferenceImageDirection[] = [
  {
    slug: "reference-led",
    composition:
      "Reference-led. Stay closest to the curated references and the project's design system: lead with the composition the strongest reference uses and show the product concept it implies.",
  },
  {
    slug: "brand-forward",
    composition:
      "Brand-forward. One dominant, memorable focal move at large scale carries the brand; generous space, and every other region holds still at real reading size.",
  },
  {
    slug: "information-dense",
    composition:
      "Information-dense. Summary-led, with a compact structured grid and a tight hierarchy that shows more real content at real reading size.",
  },
];

const SURFACE_BY_OUTPUT_TYPE: Readonly<Record<OutputType, string>> = {
  prototype: "desktop web app screen",
  wireframe: "high-fidelity desktop screen",
  page: "desktop web page",
  component: "desktop screen showing the component in two or three representative contexts",
  theme: "representative product screen showing the theme applied across navigation, type, color and components",
  tokens: "style-guide screen showing the color, type and spacing tokens applied to real components",
};

const GPT_IMAGE_ID = /^(?:[^/]+\/)?gpt-image-(?<version>\d+(?:\.\d+)*)(?:-(?<variant>.+))?$/;
const PREFERRED_VARIANTS = ["flare", "sunburst"] as const;
const LOWER_TIER_VARIANTS: ReadonlySet<string> = new Set(["mini", "nano"]);
const PREFERRED_FALLBACK_PROVIDER = "openrouter";

type RankableModel = { readonly provider: string; readonly id: string };

type GptImageRank = { readonly version: readonly number[]; readonly variant: string | undefined };

function parseGptImageId(id: string): GptImageRank | undefined {
  const groups = GPT_IMAGE_ID.exec(id)?.groups;
  if (groups?.version === undefined) return undefined;
  return { version: groups.version.split(".").map(Number), variant: groups.variant };
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  const differences = Array.from(
    { length: Math.max(left.length, right.length) },
    (_, index) => (left[index] ?? 0) - (right[index] ?? 0),
  );
  return differences.find((difference) => difference !== 0) ?? 0;
}

function variantRank(variant: string | undefined): number {
  if (variant === undefined) return 0;
  if (LOWER_TIER_VARIANTS.has(variant)) return -1;
  const preferred = (PREFERRED_VARIANTS as readonly string[]).indexOf(variant);
  return preferred === -1 ? 1 : PREFERRED_VARIANTS.length - preferred + 1;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

function fallbackProviderRank(model: RankableModel): number {
  return model.provider === PREFERRED_FALLBACK_PROVIDER ? 0 : 1;
}

function compareImageModels(left: RankableModel, right: RankableModel): number {
  const leftGpt = parseGptImageId(left.id);
  const rightGpt = parseGptImageId(right.id);
  if (leftGpt !== undefined && rightGpt !== undefined) {
    return (
      compareVersions(rightGpt.version, leftGpt.version) ||
      variantRank(rightGpt.variant) - variantRank(leftGpt.variant) ||
      compareText(left.provider, right.provider) ||
      compareText(left.id, right.id)
    );
  }
  if (leftGpt !== undefined) return -1;
  if (rightGpt !== undefined) return 1;
  return (
    fallbackProviderRank(left) - fallbackProviderRank(right) ||
    compareText(left.provider, right.provider) ||
    compareText(right.id, left.id)
  );
}

export function selectReferenceImageModel<T extends RankableModel>(
  available: readonly T[],
  override: string | undefined,
): T | undefined {
  const requested = override?.trim() ?? "";
  if (requested.length > 0) return available.find((model) => `${model.provider}/${model.id}` === requested);
  return [...available].sort(compareImageModels)[0];
}

function excerpt(label: string, text: string | undefined, limit: number): string | undefined {
  const trimmed = text?.trim() ?? "";
  if (trimmed.length === 0) return undefined;
  return `${label}:\n${trimmed.slice(0, limit).trimEnd()}`;
}

export type ReferenceImagePromptContext = {
  readonly brief: string;
  readonly outputType: OutputType;
  readonly productContext?: string;
  readonly designContext?: string;
  readonly curatedReferences?: string;
};

export function buildReferenceImagePrompt(
  context: ReferenceImagePromptContext,
  direction: ReferenceImageDirection,
): string {
  return [
    `A finished ${SURFACE_BY_OUTPUT_TYPE[context.outputType]} for: ${context.brief.trim()}`,
    "Render the surface edge to edge with crisp, readable text and real, brief-specific content. No browser window, device, desk or poster framing, and no lorem ipsum.",
    `Direction: ${direction.composition}`,
    excerpt(
      "Curated references (inspiration to adapt into this product; do not copy their layout or content)",
      context.curatedReferences,
      REFERENCES_EXCERPT_CHARS,
    ),
    excerpt("Design system (DESIGN.md)", context.designContext, DESIGN_EXCERPT_CHARS),
    excerpt("Product context (PRODUCT.md)", context.productContext, PRODUCT_EXCERPT_CHARS),
    "Keep the palette, typography and component character the context describes; the direction changes only composition and emphasis.",
  ]
    .filter((section): section is string => section !== undefined)
    .join("\n\n");
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

const IMAGE_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);

type DirectionFailure = { readonly reason: string; readonly retryable?: boolean };

type DirectionOutcome = { readonly path?: string; readonly failure?: DirectionFailure };

function firstWritableImage(output: AssistantImages["output"]): { readonly data: string; readonly extension: string } | undefined {
  for (const block of output) {
    if (block.type !== "image" || block.data.length === 0) continue;
    const extension = IMAGE_EXTENSIONS.get(block.mimeType);
    if (extension !== undefined) return { data: block.data, extension };
  }
  return undefined;
}

type RenderDirectionInput = {
  readonly provider: ReferenceImageProvider;
  readonly model: ReferenceImageModel;
  readonly prompt: string;
  readonly outputBase: string;
  readonly signal: AbortSignal;
};

async function renderDirection(input: RenderDirectionInput): Promise<DirectionOutcome> {
  const { provider, model, prompt, outputBase, signal } = input;
  let result: AssistantImages;
  try {
    result = await provider.generateImages(
      model,
      { input: [{ type: "text", text: prompt }] },
      {
        signal,
        quality: "high",
        size: IMAGE_SIZE,
        n: 1,
        timeoutMs: IMAGE_REQUEST_TIMEOUT_MS,
        maxRetries: IMAGE_REQUEST_MAX_RETRIES,
      },
    );
  } catch {
    signal.throwIfAborted();
    return { failure: { reason: "unexpected-error" } };
  }
  signal.throwIfAborted();
  if (result.stopReason !== "stop") {
    return {
      failure: {
        reason: result.error?.code ?? "unclassified",
        ...(result.error === undefined ? {} : { retryable: result.error.retryable }),
      },
    };
  }
  const image = firstWritableImage(result.output);
  if (image === undefined) return {};
  const path = `${outputBase}.${image.extension}`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(image.data, "base64"));
  } catch {
    return { failure: { reason: "write-failed" } };
  }
  return { path };
}

async function loadPromptContext(request: ReferenceImagesRequest): Promise<ReferenceImagePromptContext> {
  const [productContext, designContext] = await Promise.all([
    readOptionalText(join(request.workflowCwd, "PRODUCT.md")),
    readOptionalText(join(request.workflowCwd, "DESIGN.md")),
  ]);
  return {
    brief: request.brief,
    outputType: request.outputType,
    curatedReferences: request.curatedReferences,
    productContext,
    designContext,
  };
}

function directionOutputBase(artifactDir: string, index: number, direction: ReferenceImageDirection): string {
  return join(artifactDir, REFERENCE_IMAGES_DIRNAME, `${String(index + 1).padStart(2, "0")}-${direction.slug}`);
}

async function renderReferenceImages(
  request: ReferenceImagesRequest,
  provider: ReferenceImageProvider,
  model: ReferenceImageModel,
  signal: AbortSignal,
): Promise<ReferenceImagesStatus> {
  const promptContext = await loadPromptContext(request);
  const outcomes = await Promise.all(
    REFERENCE_IMAGE_DIRECTIONS.map((direction, index) =>
      renderDirection({
        provider,
        model,
        prompt: buildReferenceImagePrompt(promptContext, direction),
        outputBase: directionOutputBase(request.artifactDir, index, direction),
        signal,
      }),
    ),
  );
  const modelId = `${model.provider}/${model.id}`;
  const paths = outcomes.flatMap(({ path }) => (path === undefined ? [] : [path]));
  if (paths.length > 0) return { status: "generated", model: modelId, paths };
  const failure = outcomes.find((outcome) => outcome.failure !== undefined)?.failure;
  return {
    status: "failed",
    reason: failure?.reason ?? "no-images-written",
    model: modelId,
    paths: [],
    ...(failure?.retryable === undefined ? {} : { retryable: failure.retryable }),
  };
}

function skipped(reason: string): ReferenceImagesStatus {
  return { status: "skipped", reason, paths: [] };
}

export async function generateReferenceImages(
  request: ReferenceImagesRequest,
  createProvider: () => Promise<ReferenceImageProvider>,
  signal: AbortSignal,
): Promise<ReferenceImagesStatus> {
  try {
    const provider = await createProvider();
    const available = await provider.availableImageModels(signal);
    if (available.length === 0) return skipped("no-image-model");
    const model = selectReferenceImageModel(available, request.imageModel);
    if (model === undefined) return skipped("image-model-unavailable");
    return await renderReferenceImages(request, provider, model, signal);
  } catch {
    signal.throwIfAborted();
    return { status: "failed", reason: "unexpected-error", paths: [] };
  }
}

export async function createBuiltinReferenceImageProvider(
  credentials: CredentialStore = AuthStorage.create(),
): Promise<ReferenceImageProvider> {
  const models = builtinModels({ credentials });
  return {
    availableImageModels: (signal) => models.getAvailableOfType("image", undefined, { signal }),
    generateImages: (model, context, options) => models.generateImages(model, context, options),
  };
}

export async function runReferenceImagesStep(
  tool: WorkflowToolPrimitive,
  request: ReferenceImagesRequest,
  deps: ReferenceImagesDeps = {},
): Promise<ReferenceImagesStatus> {
  const createProvider = deps.createImageProvider ?? createBuiltinReferenceImageProvider;
  const outcome = await tool(
    "reference-images",
    {
      brief: request.brief,
      outputType: request.outputType,
      artifactDir: request.artifactDir,
      ...(request.imageModel === undefined ? {} : { imageModel: request.imageModel }),
    },
    ({ signal }) => generateReferenceImages(request, createProvider, signal),
    { timeoutMs: REFERENCE_IMAGES_TOOL_TIMEOUT_MS, failureMode: "return" },
  );
  return outcome.ok ? outcome.value : { status: "failed", reason: "tool-failed", paths: [] };
}

export function existingReferenceImagePaths(status: ReferenceImagesStatus): readonly string[] {
  return status.status === "generated" ? status.paths.filter((path) => existsSync(path)) : [];
}
