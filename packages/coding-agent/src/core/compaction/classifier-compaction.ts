import type { ClassifierContext, ClassifierResult, Usage } from "@bastani/pi-ai";
import type { LineRange, NumberedRegion, VerbatimCompactionParameters } from "./compaction-types.js";
import { validateDeletedRanges } from "./deleted-ranges.js";
import {
	buildStructuredCompactionInput,
	type CompactionInputMessage,
	type StructuredCompactionInput,
} from "./structured-compaction-input.js";

const MAX_UNIT_LINES = 32;
const MAX_UNIT_TOKENS = 1024;
const CLASSIFIER_CONCURRENCY = 4;

export interface ClassifierUnit extends LineRange {
	message: CompactionInputMessage;
	position: string;
}

export function buildClassifierUnits(input: StructuredCompactionInput): ClassifierUnit[] {
	const units: ClassifierUnit[] = [];
	let offset = 0;
	for (const message of input.messages) {
		let start = 0;
		let lines: string[] = [];
		let tokens = 0;
		const flush = () => {
			if (!lines.length) return;
			units.push({
				start: offset + start + 1,
				end: offset + start + lines.length,
				message: { ...message, lines },
				position: `lines ${start + 1}-${start + lines.length} of ${message.lines.length}`,
			});
			lines = [];
			tokens = 0;
		};
		for (let index = 0; index < message.lines.length; index++) {
			const line = message.lines[index];
			const lineTokens = Math.ceil((JSON.stringify(line).length + 1) / 4);
			if (
				input.protected.some(
					(range) => range.id === message.id && range.start <= index + 1 && range.end >= index + 1,
				)
			) {
				flush();
				continue;
			}
			if (lineTokens > MAX_UNIT_TOKENS) throw new Error("Classifier compaction line exceeds the unit token limit");
			if (lines.length >= MAX_UNIT_LINES || tokens + lineTokens > MAX_UNIT_TOKENS) flush();
			if (!lines.length) start = index;
			lines.push(line);
			tokens += lineTokens;
		}
		flush();
		offset += message.lines.length;
	}
	return units;
}

export async function planClassifierRanges(
	region: NumberedRegion,
	parameters: VerbatimCompactionParameters,
	classify: (context: ClassifierContext) => Promise<ClassifierResult>,
	options: { signal?: AbortSignal; onUsage?: (usage: Usage) => void } = {},
): Promise<LineRange[]> {
	const input = buildStructuredCompactionInput(region, parameters);
	const units = buildClassifierUnits(input);
	const ranked: { unit: ClassifierUnit; score: number; confidence: number }[] = [];
	let cursor = 0;
	let failure: Error | undefined;
	await Promise.all(
		Array.from({ length: Math.min(CLASSIFIER_CONCURRENCY, units.length) }, async () => {
			try {
				while (cursor < units.length && !failure) {
					if (options.signal?.aborted) throw new Error("Compaction cancelled");
					const unit = units[cursor++];
					const result = await classify({
						state: {
							query: input.query,
							message: { id: unit.message.id, role: unit.message.role, lines: unit.message.lines },
							position: unit.position,
						},
						questions: {
							score: {
								type: "score",
								instructions:
									"How much does the assistant still need these lines to continue the task? Retain current requirements, decisions, unresolved errors, and unique implementation facts; completed repetitive output is less useful.",
								criteria: ["not needed", "slightly useful", "useful", "important", "essential"],
							},
						},
					});
					if (result.usage) options.onUsage?.(result.usage);
					const answer = result.answers.score;
					if (result.stopReason !== "stop") throw new Error(result.errorMessage || "Classifier compaction failed");
					if (
						answer?.type !== "score" ||
						!Number.isFinite(answer.score) ||
						answer.score < 0 ||
						answer.score > 4 ||
						!Number.isFinite(answer.confidence) ||
						answer.confidence < 0 ||
						answer.confidence > 1
					)
						throw new Error("Invalid classifier compaction score");
					ranked.push({ unit, score: answer.score, confidence: answer.confidence });
				}
			} catch (error) {
				failure ??= error instanceof Error ? error : new Error(String(error));
			}
		}),
	);
	if (failure) throw failure;
	if (options.signal?.aborted) throw new Error("Compaction cancelled");
	ranked.sort((a, b) => a.score - b.score || b.confidence - a.confidence || a.unit.start - b.unit.start);
	let kept = region.lines.length;
	const target = Math.round(kept * parameters.compression_ratio);
	const ranges: LineRange[] = [];
	for (const { unit } of ranked) {
		if (kept <= target) break;
		ranges.push({ start: unit.start, end: unit.end });
		kept -= unit.end - unit.start + 1;
	}
	if (!validateDeletedRanges(ranges, region).length)
		throw new Error("Classifier compaction produced no usable ranges");
	return ranges;
}
