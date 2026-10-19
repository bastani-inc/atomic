import type {
	ClassifierAnswer,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierOptions,
	ClassifierResult,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { isRecord, parseClassifierUsage, postClassifierRequest, requiredNumber } from "./classifier-shared.ts";

/** Base64 image in the System One request's top-level `assets` map. */
export interface SystemOneImageAsset {
	type: "image";
	format: "png" | "jpg";
	data_base64: string;
}

/** TypeSafe System One request body without the transport-specific envelope. */
export interface SystemOneWireRequest {
	state: ClassifierContext["state"];
	questions: Record<string, unknown>;
	/** Images keyed by the references listed in `state.images`. */
	assets?: Record<string, SystemOneImageAsset>;
}

/** Differences between services that serve System One models. */
export interface SystemOneTransport {
	/** Classifier API implemented by this transport. */
	api: ClassifierApi;
	/** Service name used in error messages. */
	label: string;
	/** Absolute request URL. */
	url(model: ClassifierModel<ClassifierApi>): URL;
	/** Wraps the System One request in the service's request envelope. */
	payload(model: ClassifierModel<ClassifierApi>, request: SystemOneWireRequest): unknown;
	/** Extracts the System One output, including answers and usage. */
	output(body: unknown): Record<string, unknown>;
	/** Whether the service accepts `context.images` as `assets` for this model. Images are rejected when omitted. */
	acceptsImages?(model: ClassifierModel<ClassifierApi>): boolean;
}

const IMAGES_STATE_FIELD = "images";
const IMAGE_FORMATS = new Map<string, SystemOneImageAsset["format"]>([
	["image/png", "png"],
	["image/jpeg", "jpg"],
	["image/jpg", "jpg"],
]);

/** Lists each image once in `assets` under a fresh UUID and writes the UUIDs into `state.images`, in order. */
function imageAssets(label: string, context: ClassifierContext): Pick<SystemOneWireRequest, "state" | "assets"> {
	const images = context.images ?? [];
	if (images.length === 0) return { state: context.state };
	if (Object.hasOwn(context.state, IMAGES_STATE_FIELD)) {
		throw new Error(`${label} lists images in state.${IMAGES_STATE_FIELD}; rename that state field to send images`);
	}
	const assets: Record<string, SystemOneImageAsset> = {};
	for (const image of images) {
		const format = IMAGE_FORMATS.get(image.mimeType.toLowerCase());
		if (!format) throw new Error(`${label} accepts only PNG or JPEG images, got ${image.mimeType}`);
		assets[crypto.randomUUID()] = {
			type: "image",
			format,
			data_base64: image.data.replace(/^data:[^,]*,/u, ""),
		};
	}
	return { state: { ...context.state, [IMAGES_STATE_FIELD]: Object.keys(assets) }, assets };
}


function unitInterval(label: string, value: unknown, field: string): number {
	const number = requiredNumber(label, value, field);
	if (number < 0 || number > 1) throw new Error(`${label} returned an invalid ${field}`);
	return number;
}

function probabilities(label: string, value: unknown, id: string): Record<string, number> {
	if (!isRecord(value)) throw new Error(`${label} returned invalid probabilities for ${id}`);
	return Object.fromEntries(
		Object.entries(value).map(([key, probability]) => [
			key,
			unitInterval(label, probability, `probability for ${id}.${key}`),
		]),
	);
}

function parseAnswers(label: string, value: unknown, context: ClassifierContext): Record<string, ClassifierAnswer> {
	if (!isRecord(value)) throw new Error(`${label} returned an unexpected response`);
	const answers: Array<[string, ClassifierAnswer]> = [];
	for (const [id, question] of Object.entries(context.questions)) {
		const answer = value[id];
		if (!isRecord(answer)) throw new Error(`${label} did not return an answer for ${id}`);
		if (question.type === "choice") {
			if (
				answer.type !== "choice" ||
				typeof answer.choice !== "string" ||
				!Object.hasOwn(question.criteria, answer.choice)
			) {
				throw new Error(`${label} did not return a valid choice answer for ${id}`);
			}
			const choiceProbabilities = probabilities(label, answer.probabilities, id);
			if (Object.keys(choiceProbabilities).some((key) => !Object.hasOwn(question.criteria, key))) {
				throw new Error(`${label} returned an unknown choice probability for ${id}`);
			}
			answers.push([
				id,
				{
					type: "choice",
					choice: answer.choice,
					probabilities: choiceProbabilities,
					confidence: unitInterval(label, answer.confidence, `confidence for ${id}`),
				},
			]);
		} else if (question.type === "score") {
			if (answer.type !== "score") throw new Error(`${label} did not return a score answer for ${id}`);
			const score = requiredNumber(label, answer.score, `score for ${id}`);
			if (score < 0 || score > question.criteria.length - 1) {
				throw new Error(`${label} returned an invalid score for ${id}`);
			}
			answers.push([
				id,
				{
					type: "score",
					score,
					confidence: unitInterval(label, answer.confidence, `confidence for ${id}`),
				},
			]);
		} else {
			if (answer.type !== "noul") throw new Error(`${label} did not return a bool answer for ${id}`);
			answers.push([
				id,
				{
					type: "bool",
					probability: unitInterval(label, answer.noul, `probability for ${id}`),
				},
			]);
		}
	}
	return Object.fromEntries(answers);
}


/** Maps public `bool` questions to TypeSafe's wire-level `noul` type. */
function wireRequest(label: string, context: ClassifierContext): SystemOneWireRequest {
	const { state, assets } = imageAssets(label, context);
	return {
		state,
		questions: Object.fromEntries(
			Object.entries(context.questions).map(([id, question]) => [
				id,
				question.type === "bool" ? { ...question, type: "noul" } : question,
			]),
		),
		...(assets ? { assets } : {}),
	};
}


/** Runs one System One classification over the given transport. */
export async function classifySystemOne(
	transport: SystemOneTransport,
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
	options: ClassifierOptions | undefined,
): Promise<ClassifierResult> {
	const output: ClassifierResult = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	try {
		if (model.api !== transport.api) throw new Error(`Unsupported classifier API: ${model.api}`);
		if (context.images?.length && !transport.acceptsImages?.(model)) {
			throw new Error(`${transport.label} does not support image input`);
		}
		const body = await postClassifierRequest(
			transport.label,
			transport.url(model),
			model,
			transport.payload(model, wireRequest(transport.label, context)),
			options,
		);
		const result = transport.output(body);
		// Malformed answers may still be billed, so retain usage before parsing them.
		const usage = parseClassifierUsage(result.usage, model);
		if (usage) output.usage = usage;
		output.answers = parseAnswers(transport.label, result.answers, context);
		return output;
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error), `${transport.label} error`);
		return output;
	}
}
