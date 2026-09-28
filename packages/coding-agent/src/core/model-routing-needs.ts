import { Type } from "typebox";

/** Kinds of work a routed task can be, each described for the router in plain words. */
export const WORK_KINDS = {
	computer_use: "Operating desktop or mobile apps through screenshots, clicks and typing",
	coding: "Writing, changing or debugging code in a repository",
	code_review: "Reviewing code or systems for defects or security problems",
	codebase_lookup: "Finding files, definitions or facts in a codebase without changing anything",
	research: "Reading documents or the web and summarizing findings",
	business_workflow: "Multi-step work across business tools or APIs",
	math_science: "Math, physics or scientific computation",
	writing: "Writing or editing prose, documents or slides",
} as const;

export const DIFFICULTY_LEVELS = {
	trivial: "One obvious step",
	easy: "A few simple steps",
	moderate: "Several steps with some judgment",
	hard: "Many dependent steps, debugging or verification",
	very_hard: "Long work across many tools with frequent recovery",
} as const;

export const MISTAKE_COST_LEVELS = {
	negligible: "Easily noticed and redone",
	low: "Minor rework",
	moderate: "Wasted time or a confusing result",
	high: "Broken builds, bad data or wrong conclusions",
	severe: "Security, money, data loss or production impact",
} as const;

export type WorkKind = keyof typeof WORK_KINDS;
export type Difficulty = keyof typeof DIFFICULTY_LEVELS;
export type MistakeCost = keyof typeof MISTAKE_COST_LEVELS;

/** What a caller may state about a task so routing need not infer it. Every field is optional. */
export interface TaskNeeds {
	readonly work?: WorkKind;
	readonly difficulty?: Difficulty;
	readonly mistakeCost?: MistakeCost;
	readonly needsImages?: boolean;
	readonly longContext?: boolean;
	readonly latencySensitive?: boolean;
}

export type ResolvedTaskNeeds = Required<TaskNeeds>;

const enumOf = <T extends string>(values: Record<T, string>, description: string) =>
	Type.Unsafe<T>(Type.String({ enum: Object.keys(values), description }));

/** Tool and stage schema for caller-stated task needs. */
export const TaskNeedsSchema = Type.Object(
	{
		work: Type.Optional(enumOf(WORK_KINDS, `Main kind of work: ${Object.keys(WORK_KINDS).join(", ")}.`)),
		difficulty: Type.Optional(enumOf(DIFFICULTY_LEVELS, "How hard the task is for a capable agent.")),
		mistakeCost: Type.Optional(enumOf(MISTAKE_COST_LEVELS, "How bad a wrong result would be.")),
		needsImages: Type.Optional(Type.Boolean({ description: "Whether the agent must read screenshots or images." })),
		longContext: Type.Optional(
			Type.Boolean({ description: "Whether the agent must hold a very large codebase or document set in context." }),
		),
		latencySensitive: Type.Optional(
			Type.Boolean({
				description: "Whether a fast answer matters more than extra reasoning, for example quick lookups.",
			}),
		),
	},
	{
		additionalProperties: false,
		description:
			"For model 'auto': what you know about the task. Fill in every field you can judge; routing uses these answers instead of reading the task, and a language model reads the task only for omitted fields.",
	},
);

const WORK_KEYS = Object.keys(WORK_KINDS) as WorkKind[];
const DIFFICULTY_KEYS = Object.keys(DIFFICULTY_LEVELS) as Difficulty[];
const MISTAKE_COST_KEYS = Object.keys(MISTAKE_COST_LEVELS) as MistakeCost[];

const CHOICE_FIELDS = ["work", "difficulty", "mistakeCost"] as const;
const BOOLEAN_FIELDS = ["needsImages", "longContext", "latencySensitive"] as const;

const oneOf = <T extends string>(keys: readonly T[], value: unknown, field: string): T => {
	if (typeof value === "string" && (keys as readonly string[]).includes(value)) return value as T;
	throw new Error(`Invalid taskNeeds.${field}: expected one of ${keys.join(", ")}.`);
};

/** Validate caller-stated needs. Unknown keys and values fail rather than being guessed. */
export function parseTaskNeeds(value: unknown): TaskNeeds | undefined {
	if (value === undefined) return undefined;
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error(
			"Invalid taskNeeds: expected an object with work, difficulty, mistakeCost, needsImages, longContext or latencySensitive.",
		);
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record))
		if (!([...CHOICE_FIELDS, ...BOOLEAN_FIELDS] as readonly string[]).includes(key))
			throw new Error(`Invalid taskNeeds: unknown field ${key}.`);
	for (const field of BOOLEAN_FIELDS)
		if (record[field] !== undefined && typeof record[field] !== "boolean")
			throw new Error(`Invalid taskNeeds.${field}: expected true or false.`);
	return {
		...(record.work !== undefined ? { work: oneOf(WORK_KEYS, record.work, "work") } : {}),
		...(record.difficulty !== undefined
			? { difficulty: oneOf(DIFFICULTY_KEYS, record.difficulty, "difficulty") }
			: {}),
		...(record.mistakeCost !== undefined
			? { mistakeCost: oneOf(MISTAKE_COST_KEYS, record.mistakeCost, "mistakeCost") }
			: {}),
		...Object.fromEntries(
			BOOLEAN_FIELDS.flatMap((field) => (record[field] === undefined ? [] : [[field, record[field]]])),
		),
	};
}

/** Later stated needs win field by field (for example a call over an agent default). */
export function mergeTaskNeeds(...needs: readonly (TaskNeeds | undefined)[]): TaskNeeds | undefined {
	const merged = Object.assign({}, ...needs.filter((entry) => entry !== undefined)) as TaskNeeds;
	return Object.keys(merged).length ? merged : undefined;
}

export interface NeedsQuestion {
	readonly id: "work" | "difficulty" | "mistake_cost" | "needs_images" | "long_context" | "latency_sensitive";
	readonly instructions: string;
	readonly criteria: Record<string, string>;
}

/** Questions for only the needs the caller did not state, in a fixed order. */
export function missingNeedsQuestions(stated: TaskNeeds | undefined): NeedsQuestion[] {
	const questions: NeedsQuestion[] = [];
	if (!stated?.work)
		questions.push({
			id: "work",
			instructions: "What kind of work is this task mainly?",
			criteria: { ...WORK_KINDS },
		});
	if (!stated?.difficulty)
		questions.push({
			id: "difficulty",
			instructions: "How hard is this task for a capable AI agent to complete correctly?",
			criteria: { ...DIFFICULTY_LEVELS },
		});
	if (!stated?.mistakeCost)
		questions.push({
			id: "mistake_cost",
			instructions: "How bad is it if the agent gets this task wrong?",
			criteria: { ...MISTAKE_COST_LEVELS },
		});
	if (stated?.needsImages === undefined)
		questions.push({
			id: "needs_images",
			instructions: "Does doing this task require the agent to look at screenshots or images?",
			criteria: {
				yes: "The agent must read screenshots, images or a GUI",
				no: "Text and tool output are enough",
			},
		});
	if (stated?.longContext === undefined)
		questions.push({
			id: "long_context",
			instructions: "Must the agent hold a very large codebase, log or document set in context at once?",
			criteria: {
				yes: "Hundreds of thousands of tokens of material at once",
				no: "Ordinary amounts, read piece by piece",
			},
		});
	if (stated?.latencySensitive === undefined)
		questions.push({
			id: "latency_sensitive",
			instructions: "Does a fast answer matter more than extra reasoning?",
			criteria: {
				yes: "Speed matters: a quick lookup, an interactive step or many small calls",
				no: "Quality matters more than speed",
			},
		});
	return questions;
}

/**
 * Combine stated needs with the router's answers keyed by question id. Computer
 * use always works from screenshots, so it needs image input unless the caller
 * explicitly said otherwise.
 */
export function resolveTaskNeeds(stated: TaskNeeds | undefined, answers: Record<string, string>): ResolvedTaskNeeds {
	const work = stated?.work ?? oneOf(WORK_KEYS, answers.work, "work");
	const yes = (answer: string | undefined, field: string) =>
		answer !== undefined && oneOf(["yes", "no"], answer, field) === "yes";
	return {
		work,
		difficulty: stated?.difficulty ?? oneOf(DIFFICULTY_KEYS, answers.difficulty, "difficulty"),
		mistakeCost: stated?.mistakeCost ?? oneOf(MISTAKE_COST_KEYS, answers.mistake_cost, "mistakeCost"),
		needsImages: stated?.needsImages ?? (work === "computer_use" || yes(answers.needs_images, "needsImages")),
		longContext: stated?.longContext ?? yes(answers.long_context, "longContext"),
		latencySensitive: stated?.latencySensitive ?? yes(answers.latency_sensitive, "latencySensitive"),
	};
}

/** 0 for the easiest or cheapest-to-get-wrong task, 1 for the hardest or costliest. */
export function taskDemand(needs: ResolvedTaskNeeds): number {
	const difficulty = DIFFICULTY_KEYS.indexOf(needs.difficulty) / (DIFFICULTY_KEYS.length - 1);
	const mistake = MISTAKE_COST_KEYS.indexOf(needs.mistakeCost) / (MISTAKE_COST_KEYS.length - 1);
	return Math.max(difficulty, mistake);
}

const EFFORT_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const EFFORT_FOR_DIFFICULTY: Record<Difficulty, string> = {
	trivial: "minimal",
	easy: "low",
	moderate: "medium",
	hard: "high",
	very_hard: "xhigh",
};

/**
 * Effort for a model from the task's difficulty, one level lower (never below
 * `minimal`) when speed matters: the supported level closest to the target,
 * preferring the lower one on a tie. `null` for models without
 * configurable reasoning.
 */
export function effortForDifficulty(
	efforts: readonly (string | null)[],
	difficulty: Difficulty,
	latencySensitive = false,
): string | null {
	const supported = efforts.filter((effort): effort is string => effort !== null && EFFORT_ORDER.includes(effort));
	if (supported.length === 0) return efforts.includes(null) ? null : (efforts[0] ?? null);
	const target = Math.max(1, EFFORT_ORDER.indexOf(EFFORT_FOR_DIFFICULTY[difficulty]) - (latencySensitive ? 1 : 0));
	return [...supported].sort(
		(a, b) =>
			Math.abs(EFFORT_ORDER.indexOf(a) - target) - Math.abs(EFFORT_ORDER.indexOf(b) - target) ||
			EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b),
	)[0]!;
}
