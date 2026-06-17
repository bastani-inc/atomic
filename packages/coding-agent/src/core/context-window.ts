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

export function selectContextWindow<TApi extends Api>(
	model: Model<TApi>,
	contextWindow: number,
): ContextWindowSelection<TApi> | ContextWindowSelectionError {
	const validationError = validateContextWindowValue(contextWindow);
	if (validationError) {
		return { error: validationError };
	}

	const supported = getSupportedContextWindows(model as Model<Api>);
	if (!supported.includes(contextWindow)) {
		return {
			error: `Context window ${formatContextWindow(contextWindow)} is not supported by ${model.provider}/${model.id}. Supported values: ${supported.map(formatContextWindow).join(", ")}.`,
		};
	}

	return {
		model: {
			...model,
			defaultContextWindow: getModelDefaultContextWindow(model as Model<Api>),
			contextWindow,
			contextWindowOptions: supported,
		},
		contextWindow,
	};
}
