import {
	type BenchmarkCompletion,
	completeBenchmarks,
	type Observation,
	type QualityEstimate,
} from "./model-routing-estimates.js";
import {
	candidateEvidenceRows,
	catalogModelIdentity,
	type EvalsCatalog,
	modelEvidenceTokens,
} from "./model-routing-evals.js";
import { EFFORT_ORDER, effortForDifficulty, type ResolvedTaskNeeds, taskDemand } from "./model-routing-needs.js";

/** What ranking needs to know about one eligible model. */
export interface CandidateModel {
	/** `provider/id`, as used in router selections. */
	readonly model: string;
	readonly name: string;
	readonly cost: { readonly input: number; readonly output: number };
	readonly input: readonly string[];
	/** `provider/id` of the base model when this entry is its derived fast route (`fastRoute` metadata). */
	readonly fastRouteOf?: string;
	/** Explicit provider tier, used to avoid claiming measured latency for ultrafast. */
	readonly fastRouteServiceTier?: "priority" | "ultrafast";
	/** True when `cost` already holds the route tier's published rates rather than the base model's. */
	readonly fastRoutePriced?: boolean;
	/**
	 * Reasoning efforts the model can run at (`null` without configurable reasoning). Routing ranks the
	 * model at the effort it would run for the task; absent, every measured effort counts alike.
	 */
	readonly efforts?: readonly (string | null)[];
}

interface Metric {
	readonly key: string;
	readonly label: string;
	readonly unit: "%" | "";
	/** How much this benchmark counts toward quality for the task; quoted results follow this order. */
	readonly weight: number;
}

const percent = (key: string, label: string, weight = 1): Metric => ({ key, label, unit: "%", weight });
const points = (key: string, label: string, weight = 1): Metric => ({ key, label, unit: "", weight });

const OVERALL: Metric = points("aa:idx", "AA Intelligence Index");

/**
 * Weight of each long-task benchmark (DeepSWE, FrontierCode) for long coding and
 * review: together they outweigh every other benchmark of the work, so the
 * quality estimate rests mainly on them. A model without a measured result has
 * them estimated, and the estimate's uncertainty lowers its cautious quality.
 */
const LONG_TASK_WEIGHT = 4;

/** True when the task is long implementation work: hard, very hard, or holding a large codebase in context. */
const longWork = (needs: ResolvedTaskNeeds) =>
	needs.difficulty === "hard" || needs.difficulty === "very_hard" || needs.longContext;
/** True when the task is short, terminal-shaped work: trivial or easy, or latency-sensitive. */
const shortWork = (needs: ResolvedTaskNeeds) =>
	needs.difficulty === "trivial" || needs.difficulty === "easy" || needs.latencySensitive;

/**
 * evals.md benchmarks that measure the task's kind of work, weighted by its
 * shape: long implementation leans on DeepSWE and FrontierCode, short terminal
 * work on Terminal-Bench 4.0, review on FrontierCode and security suites.
 */
function workMetrics(needs: ResolvedTaskNeeds): Metric[] {
	const long = longWork(needs);
	const short = shortWork(needs) && !long;
	const metrics: Metric[] = (() => {
		switch (needs.work) {
			case "computer_use":
				return [
					percent("pub:OSW2", "OSWorld 2.0"),
					percent("pub:OSW21", "OSWorld 2.1"),
					percent("pub:SSP", "ScreenSpot-Pro"),
					percent("pub:ALE", "Agents' Last Exam"),
					percent("aa:MMMU", "MMMU-Pro"),
				];
			case "coding":
				return [
					percent("aa:TB4", "Terminal-Bench 4.0", short ? 2 : 1),
					percent("dswe:Pass@1", "DeepSWE", long ? LONG_TASK_WEIGHT : short ? 0.5 : 1),
					percent("pub:DSWE", "DeepSWE", long ? LONG_TASK_WEIGHT : short ? 0.5 : 1),
					percent("fc:Main", "FrontierCode", long ? LONG_TASK_WEIGHT : short ? 0.5 : 1),
					percent("pub:FC11", "FrontierCode", long ? LONG_TASK_WEIGHT : short ? 0.5 : 1),
					percent("aa:TB21", "Terminal-Bench 2.1", 0.5),
				];
			case "code_review":
				return [
					percent("fc:Main", "FrontierCode", long ? LONG_TASK_WEIGHT : 2),
					percent("pub:FC11", "FrontierCode", long ? LONG_TASK_WEIGHT : 2),
					percent("pub:XGym", "ExploitGym"),
					percent("pub:SECPro", "SEC-Bench Pro"),
					percent("pub:CWE", "CWE-bench"),
					percent("aa:TB4", "Terminal-Bench 4.0", 0.5),
				];
			case "codebase_lookup":
				return [
					percent("aa:TB4", "Terminal-Bench 4.0", 2),
					percent("aa:tau2", "τ²-Bench", 0.5),
					percent("aa:IF", "IFBench", 0.5),
					percent("aa:LCR", "AA-LCR", needs.longContext ? 1.5 : 0.5),
				];
			case "research":
				return [
					percent("aa:HLE", "Humanity's Last Exam"),
					percent("pub:BComp", "BrowseComp"),
					percent("pub:HLEt", "Humanity's Last Exam with tools"),
					percent("aa:GPQA", "GPQA Diamond"),
					percent("aa:LCR", "AA-LCR", needs.longContext ? 2 : 1),
				];
			case "business_workflow":
				return [
					percent("aa:Auto", "AutomationBench-AA"),
					percent("pub:ABench", "AutomationBench"),
					percent("aa:tau2", "τ²-Bench"),
					percent("aa:Ent", "EnterpriseOps-Gym"),
				];
			case "math_science":
				return [
					percent("pub:FMT4", "FrontierMath Tier 4"),
					percent("pub:TBSci", "Terminal-Bench-Science"),
					percent("aa:Crit", "CritPt"),
					percent("aa:Sci", "SciCode"),
				];
			case "writing":
				return [
					percent("aa:IF", "IFBench"),
					points("aa:Gn", "GDPval"),
					points("aa:Brief", "AA-Briefcase"),
					percent("aa:LCR", "AA-LCR", needs.longContext ? 2 : 1),
				];
		}
	})();
	return metrics.sort((a, b) => b.weight - a.weight);
}

/**
 * Catalog columns that describe a run rather than a model's ability: price,
 * tokens, steps, confidence intervals, flag rates, openness, and FrontierCode's
 * pass-rate and Extended columns, which restate Main.
 */
const NOT_ABILITY = new Set([
	"aa:Open",
	"dswe:CI",
	"dswe:Cost",
	"dswe:Out tok",
	"dswe:Steps",
	"fc:Main pass",
	"fc:Extended",
	"fc:Ext pass",
	"fc:Flag",
	"fc:Cost",
]);

/**
 * Published benchmarks that an independent table also measures. A vendor's
 * report uses its own harness, so it is not ranked against the independent
 * results, but it is evidence about the same ability: the completion takes it
 * as a noisier observation of the independent benchmark.
 */
const SAME_BENCHMARK: Readonly<Record<string, string>> = {
	"pub:DSWE": "dswe:Pass@1",
	"pub:TB4": "aa:TB4",
	"pub:FC11": "fc:Main",
	"pub:GDPpdf": "aa:PDF",
	"pub:HLE": "aa:HLE",
};

/** A model's results as the completion sees them: its ability measurements, and published reports of the same benchmarks. */
function abilityResults(values: ReadonlyMap<string, number>): {
	results: Map<string, number>;
	reported: Map<string, number>;
} {
	const results = new Map<string, number>();
	const reports = new Map<string, number[]>();
	for (const [key, value] of values) {
		if (NOT_ABILITY.has(key)) continue;
		results.set(key, value);
		const same = key.startsWith("pub:") ? SAME_BENCHMARK[key.slice(0, key.lastIndexOf("@"))] : undefined;
		if (same) reports.set(same, [...(reports.get(same) ?? []), value]);
	}
	const reported = new Map([...reports].map(([key, all]) => [key, all.reduce((a, b) => a + b, 0) / all.length]));
	return { results, reported };
}

/** A result reported under another harness counts as this many times noisier than a direct measurement. */
const REPORTED_NOISE = 2;
const EFFORT_WORD = /\b(non[- ]reasoning|minimal|low|medium|high|xhigh|max)\b/iu;
const EFFORT_SETTING = /\b(non[- ]reasoning|(?:minimal|low|medium|high|xhigh|max)(?=\s+effort))\b/iu;

/** The reasoning effort a measurement names, `off` for non-reasoning, or "" when it names none. */
function effortLabel(text: string | undefined, pattern: RegExp = EFFORT_WORD): string {
	const word = pattern.exec(text ?? "")?.[1]?.toLowerCase();
	if (word === undefined) return "";
	return word.startsWith("non") ? "off" : word;
}

/**
 * Position of an effort on the reasoning scale, centered on `high`. A result
 * that names no effort is taken at `high`, the setting leaderboards most often
 * report by default.
 */
const effortPosition = (label: string) => (EFFORT_ORDER.indexOf(label || "high") - EFFORT_ORDER.indexOf("high")) / 2;

/** A model's results at every effort it was measured at, as observations for the completion. */
function observationsOf(byEffort: ReadonlyMap<string, ReadonlyMap<string, number>>, direct = false): Observation[] {
	const observations: Observation[] = [];
	for (const [label, values] of byEffort) {
		const effort = effortPosition(label);
		const { results, reported } = abilityResults(values);
		for (const [key, value] of results) observations.push({ key, value, effort });
		if (!direct)
			for (const [key, value] of reported) observations.push({ key, value, effort, noise: REPORTED_NOISE });
	}
	return observations;
}

/** Benchmarks of long, multi-step software work: DeepSWE and FrontierCode, from their leaderboards or vendors. */
const LONG_TASK_BENCHMARKS = ["dswe:Pass@1", "fc:Main", "pub:DSWE", "pub:FC11"];

/** True when the model has a measured long-task result; an estimate of one never counts. */
const hasLongTaskEvidence = (values: ReadonlyMap<string, number>) =>
	[...values.keys()].some((key) =>
		LONG_TASK_BENCHMARKS.some((benchmark) => key === benchmark || key.startsWith(`${benchmark}@`)),
	);

/**
 * Hard coding and review, and long-context coding, are long tasks that short
 * benchmarks predict poorly. For them, models measured on a long-task benchmark
 * rank ahead of models that are not; the rest stay eligible behind them.
 */
const needsLongTaskEvidence = (needs: ResolvedTaskNeeds) =>
	(needs.work === "coding" || needs.work === "code_review") &&
	(needs.difficulty === "hard" || needs.difficulty === "very_hard" || (needs.work === "coding" && needs.longContext));

/** Quality is ranked on the estimate minus this many standard errors, so thin evidence counts less. */
const CONSERVATIVE_ERRORS = 1;

/** When speed matters, a fast route edges out its standard route for the model's single slot. */
const FAST_ROUTE_BONUS = 0.02;

/** A standing is stated only when enough benchmarked models share the measurement. */
const MIN_RANKED_MODELS = 4;

export interface RankedCandidate extends CandidateModel {
	/** Identity shared by one model's providers and its derived fast route, which collapse onto it. */
	readonly baseKey: string;
	readonly score: number;
	readonly values: ReadonlyMap<string, number>;
	/** How each quoted value was measured, for example its effort, harness or reporter. */
	readonly conditions: ReadonlyMap<string, string>;
	readonly released?: string;
	/**
	 * Standing among benchmarked catalog models of the conservative quality
	 * estimate for this work, present when the model has any result in the fit.
	 */
	readonly workStanding?: number;
	readonly overallStanding?: number;
	/** Quality for this work, from measured results and the completion's estimates of missing ones. */
	readonly estimate?: QualityEstimate;
	/** True when the model has a measured DeepSWE or FrontierCode result, from a leaderboard or its vendor. */
	readonly longTaskEvidence?: boolean;
	/** The effort the model is ranked at: the one routing would run it at for this task. */
	readonly effort?: string | null;
	/** Results measured at `effort`, quoted in preference to results at other efforts. */
	readonly effortValues?: ReadonlyMap<string, number>;
	readonly effortConditions?: ReadonlyMap<string, string>;
}

function sectionKind(intro: readonly string[]): "aa" | "dswe" | "fc" | "pub" {
	const heading = intro.find((line) => line.startsWith("## ")) ?? "";
	if (/DeepSWE/u.test(heading)) return "dswe";
	if (/FrontierCode/u.test(heading)) return "fc";
	if (/Published/u.test(heading)) return "pub";
	return "aa";
}

const cells = (line: string) =>
	line
		.split("|")
		.slice(1, -1)
		.map((cell) => cell.trim());

const nameWords = (text: string) => new Set(text.match(/\p{Lu}[\p{L}]{2,}/gu) ?? []);

/**
 * The parts of a published result's setting that apply to this row: a clause
 * naming other models (for example "Fable values are Mythos" on a GPT row) is a
 * footnote for them and is dropped.
 */
function ownSetting(setting: string, rowModel: string, modelWords: ReadonlySet<string>): string {
	const own = nameWords(rowModel);
	return setting
		.split(";")
		.map((clause) => clause.trim())
		.filter((clause) => {
			const named = [...nameWords(clause)].filter((word) => modelWords.has(word));
			return named.length === 0 || named.some((word) => own.has(word));
		})
		.join(", ");
}

/** Parenthetical measurement setting in an Artificial Analysis model name, for example "Max Effort". */
function nameCondition(name: string | undefined): string | undefined {
	const setting = /\(([^)]+)\)\s*$/u.exec(name ?? "")?.[1];
	return setting && /^(?:minimal|low|medium|high|xhigh|max)$/u.test(setting) ? `${setting} effort` : setting;
}

interface Reading {
	readonly key: string;
	readonly value: number;
	readonly condition?: string;
	/** The reasoning effort the row was measured at, or "" when it names none. */
	readonly effort: string;
}

interface CatalogReadings {
	/** Readings of each catalog row, indexed by the row's `order`. */
	readonly rows: readonly (readonly Reading[])[];
	/** Per measurement, the best value of each catalog model. */
	readonly cohorts: ReadonlyMap<string, ReadonlyMap<string, number>>;
	/** Per catalog model, its results at each measured effort. */
	readonly models: ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, number>>>;
	/** Low-rank completion of every ability measurement, fitted on first use. */
	completion(): BenchmarkCompletion;
	/** Per benchmark weighting, every fitted catalog model's conservative quality, computed on first use. */
	readonly populations: Map<string, readonly (readonly [string, number])[]>;
}

const readingsByCatalog = new WeakMap<EvalsCatalog, CatalogReadings>();

/** Every measured value in the catalog, read once per parsed catalog. */
function catalogReadings(catalog: EvalsCatalog): CatalogReadings {
	const cached = readingsByCatalog.get(catalog);
	if (cached) return cached;
	const kinds = catalog.sections.map((section) => sectionKind(section.intro));
	const headers = catalog.sections.map((section) =>
		cells(section.intro.find((line) => line.startsWith("| slug |")) ?? ""),
	);
	const modelColumn = headers.map((header) => header.indexOf("Model"));
	const modelWords = catalog.sections.map((_, section) => {
		const words = new Set<string>();
		for (const row of catalog.rows)
			if (row.section === section)
				for (const word of nameWords(cells(row.line)[modelColumn[section]!] ?? "")) words.add(word);
		return words;
	});
	const rows = catalog.rows.map((row) => {
		const header = headers[row.section]!;
		const rowCells = cells(row.line);
		const column = (name: string) => (header.includes(name) ? rowCells[header.indexOf(name)] : undefined);
		const readings: Reading[] = [];
		const read = (key: string, raw: string | undefined, condition: string | undefined, effort: string) => {
			const value = Number.parseFloat(raw ?? "");
			if (Number.isFinite(value)) readings.push({ key, value, effort, ...(condition ? { condition } : {}) });
		};
		if (kinds[row.section] === "pub") {
			const reporter = column("Source");
			const setting = ownSetting(column("Setting") ?? "", column("Model") ?? "", modelWords[row.section]!);
			const condition = [setting, reporter ? `reported by ${reporter}` : undefined].filter(Boolean).join(", ");
			// Each reporter's results form their own cohort: a vendor harness and an
			// official leaderboard are not ranked against each other.
			read(
				`pub:${column("Benchmark")}@${reporter ?? ""}`,
				column("Score"),
				condition,
				effortLabel(setting, EFFORT_SETTING),
			);
		} else {
			const effort = column("Effort");
			const condition = effort ? `${effort} effort` : nameCondition(column("Model"));
			const label = effortLabel(effort ?? /\(([^)]+)\)\s*$/u.exec(column("Model") ?? "")?.[1]);
			for (const [index, name] of header.entries())
				if (index > 1 && name !== "Effort" && name !== "Release date")
					read(`${kinds[row.section]}:${name}`, rowCells[index], condition, label);
		}
		return readings;
	});
	const cohorts = new Map<string, Map<string, number>>();
	for (const row of catalog.rows) {
		const identity = catalogModelIdentity(row.tokens);
		for (const { key, value } of rows[row.order]!) {
			const cohort = cohorts.get(key) ?? new Map<string, number>();
			cohort.set(identity, Math.max(cohort.get(identity) ?? value, value));
			cohorts.set(key, cohort);
		}
	}
	// Per catalog model and effort, the best value of each measurement.
	const models = new Map<string, Map<string, Map<string, number>>>();
	for (const row of catalog.rows) {
		const identity = catalogModelIdentity(row.tokens);
		const efforts = models.get(identity) ?? new Map<string, Map<string, number>>();
		models.set(identity, efforts);
		for (const { key, value, effort } of rows[row.order]!) {
			const values = efforts.get(effort) ?? new Map<string, number>();
			values.set(key, Math.max(values.get(key) ?? value, value));
			efforts.set(effort, values);
		}
	}
	let completion: BenchmarkCompletion | undefined;
	const readings: CatalogReadings = {
		rows,
		cohorts,
		models,
		completion: () => {
			if (completion === undefined) {
				completion = completeBenchmarks(
					new Map([...models].map(([identity, efforts]) => [identity, observationsOf(efforts, true)])),
					MIN_RANKED_MODELS,
				);
			}
			return completion;
		},
		populations: new Map(),
	};
	readingsByCatalog.set(catalog, readings);
	return readings;
}

/**
 * Best value per metric across every evals row describing the model, with the
 * conditions it was measured under, the catalog models those rows belong to,
 * and the model's newest release date.
 */
function measure(
	catalog: EvalsCatalog,
	model: string,
): {
	values: Map<string, number>;
	conditions: Map<string, string>;
	byEffort: Map<string, Map<string, number>>;
	effortConditions: Map<string, Map<string, string>>;
	identities: Set<string>;
	released?: string;
} {
	const readings = catalogReadings(catalog);
	const values = new Map<string, number>();
	const conditions = new Map<string, string>();
	const byEffort = new Map<string, Map<string, number>>();
	const effortConditions = new Map<string, Map<string, string>>();
	const identities = new Set<string>();
	let released: string | undefined;
	const keepBest = (
		into: Map<string, number>,
		notes: Map<string, string>,
		key: string,
		value: number,
		condition: string | undefined,
	) => {
		if (value <= (into.get(key) ?? Number.NEGATIVE_INFINITY)) return;
		into.set(key, value);
		if (condition) notes.set(key, condition);
		else notes.delete(key);
	};
	for (const row of candidateEvidenceRows(catalog, model)) {
		identities.add(catalogModelIdentity(row.tokens));
		for (const { key, value, condition, effort } of readings.rows[row.order]!) {
			keepBest(values, conditions, key, value, condition);
			if (!byEffort.has(effort)) {
				byEffort.set(effort, new Map());
				effortConditions.set(effort, new Map());
			}
			keepBest(byEffort.get(effort)!, effortConditions.get(effort)!, key, value, condition);
		}
		if (row.releaseDate && (!released || row.releaseDate > released)) released = row.releaseDate;
	}
	return { values, conditions, byEffort, effortConditions, identities, ...(released ? { released } : {}) };
}

/** Value keys measuring `metric`: the column itself, or one per reporter for published results. */
const cohortKeys = (values: ReadonlyMap<string, number>, metric: Metric) =>
	[...values.keys()].filter((key) => key === metric.key || key.startsWith(`${metric.key}@`));

const baseKey = (candidate: CandidateModel) => modelEvidenceTokens(candidate.fastRouteOf ?? candidate.model).join("-");

const blended = (candidate: CandidateModel) => (3 * candidate.cost.input + candidate.cost.output) / 4;

/** The weight of each of `metrics` the completion fitted. */
function benchmarkWeights(completion: BenchmarkCompletion, metrics: readonly Metric[]): Map<string, number> {
	const weights = new Map<string, number>();
	for (const metric of metrics) {
		const keys = [...completion.keys].filter((key) => key === metric.key || key.startsWith(`${metric.key}@`));
		for (const key of keys) weights.set(key, (weights.get(key) ?? 0) + metric.weight / keys.length);
	}
	return weights;
}

/** True when any of a model's observations is a benchmark the completion fitted. */
const fitsAny = (completion: BenchmarkCompletion, observations: readonly Observation[]) =>
	observations.some((observation) => completion.keys.has(observation.key));

const conservative = (estimate: QualityEstimate) => estimate.mean - CONSERVATIVE_ERRORS * estimate.error;

/**
 * Rank every eligible model for the task in code. Quality is a conservative
 * estimate for this kind of work: the model's weighted results on the work's
 * benchmarks, with missing ones estimated from all of its other results, less
 * one standard error, scaled from the weakest to the strongest candidate. A
 * model with one strong result therefore ranks below models with broader,
 * consistent evidence. The standing quoted to the router compares the same
 * estimate with every benchmarked catalog model, so it does not depend on
 * which other models are eligible. Quality is weighed against price by how
 * demanding the task is, with a small preference for newer releases.
 */
export function rankCandidates(
	catalog: EvalsCatalog,
	candidates: readonly CandidateModel[],
	needs: ResolvedTaskNeeds,
): RankedCandidate[] {
	const readings = catalogReadings(catalog);
	const { cohorts } = readings;
	const completion = readings.completion();
	const weights = benchmarkWeights(completion, workMetrics(needs));
	const signature = JSON.stringify([...weights]);
	let population = readings.populations.get(signature);
	if (population === undefined) {
		// Every catalog model at each effort it was measured at.
		population = [...readings.models].flatMap(([identity, efforts]) => {
			const observations = observationsOf(efforts);
			if (!fitsAny(completion, observations)) return [];
			return [...efforts.keys()].flatMap((label) => {
				const estimate = completion.estimate(observations, weights, effortPosition(label));
				return estimate ? [[identity, conservative(estimate)] as const] : [];
			});
		});
		readings.populations.set(signature, population);
	}
	const fitted = population;
	const measured = candidates.map((candidate) => {
		const evidence = measure(catalog, candidate.fastRouteOf ?? candidate.model);
		// The model is ranked at the effort routing would run it at for this task.
		const effort = candidate.efforts
			? effortForDifficulty(candidate.efforts, needs.difficulty, needs.latencySensitive)
			: undefined;
		// Without known efforts, the model is ranked at the highest effort it was measured at.
		const label =
			effort === undefined
				? [...evidence.byEffort.keys()].sort((a, b) => EFFORT_ORDER.indexOf(b) - EFFORT_ORDER.indexOf(a))[0]
				: (effort ?? "");
		const observations = observationsOf(evidence.byEffort);
		return {
			candidate,
			base: baseKey(candidate),
			...evidence,
			effort,
			effortValues: label === undefined ? undefined : evidence.byEffort.get(label),
			effortNotes: label === undefined ? undefined : evidence.effortConditions.get(label),
			estimate: completion.estimate(observations, weights, effortPosition(label ?? "")),
			// Only a model with a result in the fit has a standing of its own; an
			// unbenchmarked model is ranked on the catalog-wide prior, whose wide
			// uncertainty keeps it below measured models.
			evidenced: fitsAny(completion, observations),
		};
	});
	// Quality for ranking spans the candidates being ranked: catalog standings
	// crowd every frontier model into the top few percent, where price would
	// decide, while the cautious estimates themselves still separate them.
	const cautious = measured.flatMap((entry) => (entry.estimate ? [conservative(entry.estimate)] : []));
	const [weakest, strongest] = [Math.min(...cautious), Math.max(...cautious)];
	const relativeQuality = (estimate: QualityEstimate) =>
		strongest > weakest ? (conservative(estimate) - weakest) / (strongest - weakest) : 1;
	const rankOf = (key: string, value: number, own: ReadonlySet<string>): number | undefined => {
		const cohort = cohorts.get(key);
		if (cohort === undefined || cohort.size < MIN_RANKED_MODELS) return undefined;
		const others = [...cohort].filter(([identity]) => !own.has(identity)).map(([, other]) => other);
		return others.length ? others.filter((other) => other < value).length / others.length : undefined;
	};
	const estimateStanding = (value: number, own: ReadonlySet<string>): number | undefined => {
		if (fitted.length < MIN_RANKED_MODELS) return undefined;
		const others = fitted.filter(([identity]) => !own.has(identity));
		return others.length ? others.filter(([, other]) => other < value).length / others.length : undefined;
	};
	const overallOf = (values: ReadonlyMap<string, number>, own: ReadonlySet<string>) => {
		const ranks = cohortKeys(values, OVERALL)
			.map((key) => rankOf(key, values.get(key)!, own))
			.filter((rank): rank is number => rank !== undefined);
		return ranks.length ? ranks.reduce((a, b) => a + b, 0) / ranks.length : undefined;
	};
	const logPrices = measured
		.map((entry) => blended(entry.candidate))
		.filter((price) => price > 0)
		.map(Math.log);
	const [low, high] = [Math.min(...logPrices), Math.max(...logPrices)];
	const newest = measured
		.map((entry) => entry.released ?? "")
		.sort()
		.at(-1);
	const demand = taskDemand(needs);
	const gated = needsLongTaskEvidence(needs);
	// Quality is relative to the candidates, so it spans the whole range between
	// them even for modest tasks. Below moderate demand its weight therefore falls
	// with the square of demand, and an easy, low-stakes task goes to an adequate
	// cheaper model; from moderate demand up the weights are unchanged.
	const qualityWeight = demand >= 0.5 ? 0.25 + 0.65 * demand : 0.575 * (demand / 0.5) ** 2;
	const priceWeight = 0.65 - 0.65 * demand;

	return measured
		.map(
			({
				candidate,
				base,
				values,
				conditions,
				identities,
				released,
				estimate,
				evidenced,
				effort,
				effortValues,
				effortNotes,
			}) => {
				const standing = estimate ? estimateStanding(conservative(estimate), identities) : undefined;
				const workStanding = evidenced ? standing : undefined;
				const overallStanding = overallOf(values, identities);
				const quality =
					estimate && standing !== undefined
						? relativeQuality(estimate)
						: overallStanding !== undefined
							? 0.8 * overallStanding
							: 0.2;
				const price = blended(candidate);
				const cheapness = price > 0 && high > low ? 1 - (Math.log(price) - low) / (high - low) : 1;
				const ageDays = released && newest ? (Date.parse(newest) - Date.parse(released)) / 86_400_000 : 365;
				const recency = 1 - Math.min(1, ageDays / 365);
				return {
					...candidate,
					baseKey: base,
					score:
						qualityWeight * quality +
						priceWeight * cheapness +
						0.1 * recency +
						(needs.latencySensitive && candidate.fastRouteOf && candidate.fastRouteServiceTier !== "ultrafast"
							? FAST_ROUTE_BONUS
							: 0),
					values,
					conditions,
					...(released ? { released } : {}),
					...(workStanding !== undefined ? { workStanding } : {}),
					...(overallStanding !== undefined ? { overallStanding } : {}),
					...(estimate && evidenced ? { estimate } : {}),
					...(effort !== undefined ? { effort } : {}),
					...(hasLongTaskEvidence(values) ? { longTaskEvidence: true } : {}),
					...(effortValues ? { effortValues } : {}),
					...(effortNotes ? { effortConditions: effortNotes } : {}),
				};
			},
		)
		.sort(
			(a, b) =>
				Number(gated && !a.longTaskEvidence) - Number(gated && !b.longTaskEvidence) ||
				b.score - a.score ||
				Number(a.fastRouteOf !== undefined) - Number(b.fastRouteOf !== undefined) ||
				a.model.localeCompare(b.model),
		);
}

/** The best `size` candidates with at most one per base model. */
export function distinctTop(ranked: readonly RankedCandidate[], size: number): RankedCandidate[] {
	const seen = new Set<string>();
	const top: RankedCandidate[] = [];
	for (const candidate of ranked) {
		if (seen.has(candidate.baseKey)) continue;
		seen.add(candidate.baseKey);
		top.push(candidate);
		if (top.length === size) break;
	}
	return top;
}

function standingLabel(fraction: number): string {
	if (fraction >= 0.9) return "top 10%";
	if (fraction >= 0.75) return "top quarter";
	if (fraction >= 0.5) return "above median";
	if (fraction >= 0.25) return "below median";
	return "bottom quarter";
}

const round = (value: number) => Number(value.toFixed(1));

const money = (value: number) => `$${Number(value.toPrecision(3))}`;

/**
 * One shortlisted option described with its own evidence, so the router compares
 * options directly: release date, price tier, image input, and results for this
 * kind of work and overall. The work standing compares the conservative
 * quality estimate with every benchmarked catalog model's, and says which
 * results are measured and which are estimated from the model's other results.
 */
export function describeOption(
	option: RankedCandidate,
	needs: ResolvedTaskNeeds,
	eligible: readonly RankedCandidate[],
): string {
	const prices = eligible.map(blended).sort((a, b) => a - b);
	const position = prices.filter((other) => other < blended(option)).length / Math.max(1, prices.length - 1);
	const tier = position < 1 / 3 ? "low" : position < 2 / 3 ? "mid" : "high";
	const newest = eligible
		.map((candidate) => candidate.released ?? "")
		.sort()
		.at(-1);
	// Work results at the effort the model is ranked at take the place of its best results at
	// other efforts; the overall result stays the best one, which its standing describes.
	interface Source {
		readonly values: ReadonlyMap<string, number>;
		readonly notes: ReadonlyMap<string, string>;
	}
	const best: Source = { values: option.values, notes: option.conditions };
	const atEffort: Source = {
		values: new Map([...option.values, ...(option.effortValues ?? [])]),
		notes: new Map([...option.conditions, ...(option.effortConditions ?? [])]),
	};
	const measuredOf = (metrics: readonly Metric[], source: Source) =>
		metrics
			.map((metric) => {
				const keys = cohortKeys(source.values, metric);
				const top = keys.sort((a, b) => source.values.get(b)! - source.values.get(a)!)[0];
				return top === undefined ? undefined : { metric, key: top };
			})
			.filter((entry) => entry !== undefined);
	const results = (metrics: readonly Metric[], source: Source, count = 2) =>
		measuredOf(metrics, source)
			.slice(0, count)
			.map(({ metric, key }) => {
				const condition = source.notes.get(key);
				return `${metric.label} ${source.values.get(key)}${metric.unit}${condition ? ` measured with ${condition}` : ""}`;
			})
			.join("; ");
	const quote = (metrics: readonly Metric[], standing: number | undefined, source: Source) => {
		const measured = results(metrics, source);
		if (!measured) return "no published results";
		return `${standing === undefined ? "measured" : `${standingLabel(standing)} of models with the same benchmark and source`} (${measured})`;
	};
	const metrics = workMetrics(needs);
	const work = () => {
		const { estimate, workStanding } = option;
		if (estimate === undefined || workStanding === undefined) return quote(metrics, undefined, atEffort);
		const measured = results(metrics, atEffort, 3);
		const quotedLabels = new Set(measuredOf(metrics, atEffort).map(({ metric }) => metric.label));
		const estimated = metrics
			.flatMap((metric) =>
				estimate.estimated
					.filter((result) => result.key === metric.key || result.key.startsWith(`${metric.key}@`))
					.map((result) => ({ metric, result })),
			)
			.filter(
				({ metric }, index, all) =>
					!quotedLabels.has(metric.label) &&
					all.findIndex((entry) => entry.metric.label === metric.label) === index,
			)
			.slice(0, 2)
			.map(
				({ metric, result }) =>
					`${metric.label} about ${round(result.value)}${metric.unit} ± ${round(result.error)}${metric.unit === "%" ? " points" : ""}`,
			)
			.join("; ");
		const parts = [
			measured ? `measured: ${measured}` : "no result measured for this work",
			...(estimated ? [`estimated from its other results, not measured: ${estimated}`] : []),
		];
		const at = typeof option.effort === "string" ? ` at ${option.effort} effort` : "";
		return `${standingLabel(workStanding)} of benchmarked models on a cautious estimate for this work${at}, above ${round(100 * workStanding)}% of them (${parts.join("; ")})`;
	};
	let released = "unknown";
	if (option.released) {
		const months = newest ? Math.round((Date.parse(newest) - Date.parse(option.released)) / (30.44 * 86_400_000)) : 0;
		released =
			months <= 1
				? `${option.released}, among the newest`
				: `${option.released}, ${months} months older than the newest`;
	}
	const fastBase = option.fastRouteOf
		? eligible.find((candidate) => candidate.model === option.fastRouteOf)
		: undefined;
	return JSON.stringify({
		model: option.name,
		id: option.model,
		released,
		price: `${tier}: ${money(option.cost.input)} / ${money(option.cost.output)} per million tokens`,
		reads_images: option.input.includes("image"),
		[needs.work]: work(),
		overall: quote([OVERALL], option.overallStanding, best),
		...(option.fastRouteOf
			? {
					route:
						option.fastRouteServiceTier === "ultrafast"
							? `ultrafast request for ${fastBase?.name ?? option.fastRouteOf}; base-model evidence only, no separate latency or benchmark score; account access required`
							: `faster route of ${fastBase?.name ?? option.fastRouteOf} with the same results; ${option.fastRoutePriced ? "the listed prices are its Fast rates" : "billed above the listed prices"}`,
				}
			: {}),
	});
}
