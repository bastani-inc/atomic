import type { Api, Model } from "@earendil-works/pi-ai";

declare module "@earendil-works/pi-ai" {
	interface Model<TApi extends Api> {
		/** Selectable context-window sizes for this model. The scalar contextWindow remains the default/effective value. */
		contextWindowOptions?: readonly number[];
		/** Original/default scalar context window, preserved when contextWindow is overridden for a session. */
		defaultContextWindow?: number;
	}
}

export interface ContextWindowParseResult {
	value?: number;
	error?: string;
}

export interface ContextWindowSelection<TApi extends Api = Api> {
	model: Model<TApi>;
	contextWindow: number;
}

export interface ContextWindowSelectionError {
	error: string;
}

export interface ContextWindowSelectionOptions {
	/**
	 * GitHub Copilot advertises some long-context tiers below their branded 1M size
	 * (for example 936k or 922k input tokens). When enabled, a request above an
	 * advertised long tier selects the largest supported Copilot window not
	 * exceeding the request, but never silently falls back to the model's base
	 * window.
	 */
	allowCopilotLongContextFallback?: boolean;
}

const CONTEXT_WINDOW_UNITS: Record<string, number> = {
	k: 1_000,
	m: 1_000_000,
};

function isPositiveInteger(value: number): boolean {
	return Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

export function validateContextWindowValue(value: number): string | undefined {
	return isPositiveInteger(value) ? undefined : "Context window must be a positive integer token count";
}

export function parseContextWindowValue(input: string): ContextWindowParseResult {
	const trimmed = input.trim();
	if (!trimmed) {
		return { error: "Context window requires a value" };
	}

	const match = /^(\d+(?:\.\d+)?)([kKmM])?$/.exec(trimmed);
	if (!match) {
		return { error: `Invalid context window "${input}". Use a positive number, or a compact value like 400k or 1m.` };
	}

	const numericValue = Number(match[1]);
	const unit = match[2]?.toLowerCase();
	const multiplier = unit ? CONTEXT_WINDOW_UNITS[unit] : 1;
	const tokens = numericValue * multiplier;
	const validationError = validateContextWindowValue(tokens);
	if (validationError) {
		return { error: `Invalid context window "${input}". ${validationError}.` };
	}

	return { value: tokens };
}

export function formatContextWindow(value: number): string {
	if (value >= 1_000_000) {
		const millions = value / 1_000_000;
		return millions % 1 === 0 ? `${millions}m` : `${millions.toFixed(1)}m`;
	}
	if (value >= 1_000) {
		const thousands = value / 1_000;
		return thousands % 1 === 0 ? `${thousands}k` : `${thousands.toFixed(1)}k`;
	}
	return String(value);
}

export function normalizeContextWindowOptions(values: readonly number[] | undefined): number[] {
	const seen = new Set<number>();
	const normalized: number[] = [];
	for (const value of values ?? []) {
		if (!isPositiveInteger(value) || seen.has(value)) continue;
		seen.add(value);
		normalized.push(value);
	}
	return normalized.sort((a, b) => a - b);
}

export function getModelDefaultContextWindow(model: Model<Api>): number {
	return isPositiveInteger(model.defaultContextWindow ?? 0) ? model.defaultContextWindow! : model.contextWindow;
}

export function getSupportedContextWindows(model: Model<Api>): number[] {
	return normalizeContextWindowOptions([getModelDefaultContextWindow(model), ...(model.contextWindowOptions ?? [])]);
}

export function withContextWindowOptions<TApi extends Api>(
	model: Model<TApi>,
	contextWindowOptions: readonly number[],
): Model<TApi> {
	return {
		...model,
		defaultContextWindow: getModelDefaultContextWindow(model as Model<Api>),
		contextWindowOptions: normalizeContextWindowOptions(contextWindowOptions),
	};
}

function resolveSelectableContextWindow(
	model: Model<Api>,
	requestedContextWindow: number,
	supported: readonly number[],
	options: ContextWindowSelectionOptions,
): number | undefined {
	if (supported.includes(requestedContextWindow)) {
		return requestedContextWindow;
	}

	if (options.allowCopilotLongContextFallback !== true || model.provider !== "github-copilot") {
		return undefined;
	}

	const defaultContextWindow = getModelDefaultContextWindow(model);
	const candidates = supported.filter(
		(contextWindow) => contextWindow <= requestedContextWindow && contextWindow > defaultContextWindow,
	);
	return candidates.length > 0 ? Math.max(...candidates) : undefined;
}

export function selectContextWindow<TApi extends Api>(
	model: Model<TApi>,
	contextWindow: number,
	options: ContextWindowSelectionOptions = {},
): ContextWindowSelection<TApi> | ContextWindowSelectionError {
	const validationError = validateContextWindowValue(contextWindow);
	if (validationError) {
		return { error: validationError };
	}

	const apiModel = model as Model<Api>;
	const supported = getSupportedContextWindows(apiModel);
	const selectedContextWindow = resolveSelectableContextWindow(apiModel, contextWindow, supported, options);
	if (selectedContextWindow === undefined) {
		return {
			error: `Context window ${formatContextWindow(contextWindow)} is not supported by ${model.provider}/${model.id}. Supported values: ${supported.map(formatContextWindow).join(", ")}.`,
		};
	}

	return {
		model: {
			...model,
			defaultContextWindow: getModelDefaultContextWindow(apiModel),
			contextWindow: selectedContextWindow,
			contextWindowOptions: supported,
		},
		contextWindow: selectedContextWindow,
	};
}
