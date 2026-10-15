import type { WorkflowSerializableValue } from "./types.js";

export function isRouterSelection<T>(value: T): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, WorkflowSerializableValue>;
	const isPair = (pair: WorkflowSerializableValue): boolean => {
		if (typeof pair !== "object" || pair === null || Array.isArray(pair)) return false;
		const fields = pair as Record<string, WorkflowSerializableValue>;
		return (
			Object.keys(pair).length === 2 &&
			typeof fields.model === "string" &&
			(fields.effort === null || isReasoningLevel(fields.effort))
		);
	};
	return (
		Object.keys(record).every((key) => ["model", "effort", "fallbacks", "candidates"].includes(key)) &&
		typeof record.model === "string" &&
		(record.effort === null || isReasoningLevel(record.effort)) &&
		(record.fallbacks === undefined ||
			(Array.isArray(record.fallbacks) &&
				record.fallbacks.length <= 2 &&
				record.fallbacks.every(isPair) &&
				new Set([
					record.model,
					...record.fallbacks.map((pair) => (pair as Record<string, WorkflowSerializableValue>).model),
				]).size ===
					record.fallbacks.length + 1)) &&
		(record.candidates === undefined ||
			(Array.isArray(record.candidates) && record.candidates.every((id) => typeof id === "string")))
	);
}

export function isModelAttempts<T>(value: T): boolean {
	return (
		Array.isArray(value) &&
		value.every((attempt) => {
			if (typeof attempt !== "object" || attempt === null || Array.isArray(attempt)) return false;
			const record = attempt as Record<string, WorkflowSerializableValue>;
			return (
				typeof record.model === "string" &&
				typeof record.success === "boolean" &&
				(record.reasoningLevel === undefined || isReasoningLevel(record.reasoningLevel)) &&
				(record.error === undefined || typeof record.error === "string") &&
				(record.usage === undefined || isModelUsage(record.usage))
			);
		})
	);
}

function isReasoningLevel(value: WorkflowSerializableValue): boolean {
	return (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh" ||
		value === "max"
	);
}

function isModelUsage(value: WorkflowSerializableValue): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const usage = value as Record<string, WorkflowSerializableValue>;
	return ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"].every(
		(key) =>
			usage[key] === undefined || (typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0),
	);
}
