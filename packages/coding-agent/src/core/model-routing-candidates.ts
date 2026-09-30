import {
	candidateEvidenceRows,
	catalogModelIdentity,
	type EvalsCatalog,
	modelEvidenceTokens,
} from "./model-routing-evals.js";
import { type ResolvedTaskNeeds, taskDemand, type WorkKind } from "./model-routing-needs.js";

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
	/** True when the provider has not published this ultrafast route's rates, so `cost` is the standard rate. */
	readonly ultrafastPriceUnpublished?: boolean;
}

interface Metric {
	readonly key: string;
	readonly label: string;
	readonly unit: "%" | "";
}

const percent = (key: string, label: string): Metric => ({ key, label, unit: "%" });
const points = (key: string, label: string): Metric => ({ key, label, unit: "" });

const OVERALL: Metric = points("aa:idx", "AA Intelligence Index");

/** evals.md columns that measure each kind of work, in the order results are quoted. */
const WORK_METRICS: Record<WorkKind, readonly Metric[]> = {
	computer_use: [
		percent("pub:OSW2", "OSWorld 2.0"),
		percent("pub:SSP", "ScreenSpot-Pro"),
		percent("pub:ALE", "Agents' Last Exam"),
		percent("aa:MMMU", "MMMU-Pro"),
	],
	coding: [
		percent("aa:TB4", "Terminal-Bench 4.0"),
		percent("dswe:Pass@1", "DeepSWE"),
		percent("pub:DSWE", "DeepSWE"),
		percent("fc:Main", "FrontierCode"),
		percent("aa:TB21", "Terminal-Bench 2.1"),
	],
	code_review: [
		percent("fc:Main", "FrontierCode"),
		percent("aa:TB4", "Terminal-Bench 4.0"),
		percent("pub:XGym", "ExploitGym"),
		percent("pub:SECPro", "SEC-Bench Pro"),
	],
	codebase_lookup: [
		percent("aa:TB4", "Terminal-Bench 4.0"),
		percent("aa:tau2", "τ²-Bench"),
		percent("aa:IF", "IFBench"),
	],
	research: [
		percent("aa:HLE", "Humanity's Last Exam"),
		percent("pub:BComp", "BrowseComp"),
		percent("aa:GPQA", "GPQA Diamond"),
		percent("aa:LCR", "AA-LCR"),
	],
	business_workflow: [
		percent("aa:Auto", "AutomationBench-AA"),
		percent("pub:ABench", "AutomationBench"),
		percent("aa:tau2", "τ²-Bench"),
		percent("aa:Ent", "EnterpriseOps-Gym"),
	],
	math_science: [
		percent("pub:FMT4", "FrontierMath Tier 4"),
		percent("pub:TBSci", "Terminal-Bench-Science"),
		percent("aa:Crit", "CritPt"),
		percent("aa:Sci", "SciCode"),
	],
	writing: [
		percent("aa:IF", "IFBench"),
		points("aa:Gn", "GDPval"),
		points("aa:Brief", "AA-Briefcase"),
		percent("aa:LCR", "AA-LCR"),
	],
};

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
	readonly workStanding?: number;
	readonly overallStanding?: number;
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
}

interface CatalogReadings {
	/** Readings of each catalog row, indexed by the row's `order`. */
	readonly rows: readonly (readonly Reading[])[];
	/** Per measurement, the best value of each catalog model. */
	readonly cohorts: ReadonlyMap<string, ReadonlyMap<string, number>>;
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
		const read = (key: string, raw: string | undefined, condition: string | undefined) => {
			const value = Number.parseFloat(raw ?? "");
			if (Number.isFinite(value)) readings.push({ key, value, ...(condition ? { condition } : {}) });
		};
		if (kinds[row.section] === "pub") {
			const reporter = column("Source");
			const setting = ownSetting(column("Setting") ?? "", column("Model") ?? "", modelWords[row.section]!);
			const condition = [setting, reporter ? `reported by ${reporter}` : undefined].filter(Boolean).join(", ");
			// Each reporter's results form their own cohort: a vendor harness and an
			// official leaderboard are not ranked against each other.
			read(`pub:${column("Benchmark")}@${reporter ?? ""}`, column("Score"), condition);
		} else {
			const effort = column("Effort");
			const condition = effort ? `${effort} effort` : nameCondition(column("Model"));
			for (const [index, name] of header.entries())
				if (index > 1 && name !== "Effort" && name !== "Release date")
					read(`${kinds[row.section]}:${name}`, rowCells[index], condition);
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
	const readings = { rows, cohorts };
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
): { values: Map<string, number>; conditions: Map<string, string>; identities: Set<string>; released?: string } {
	const readings = catalogReadings(catalog);
	const values = new Map<string, number>();
	const conditions = new Map<string, string>();
	const identities = new Set<string>();
	let released: string | undefined;
	for (const row of candidateEvidenceRows(catalog, model)) {
		identities.add(catalogModelIdentity(row.tokens));
		for (const { key, value, condition } of readings.rows[row.order]!) {
			if (value <= (values.get(key) ?? Number.NEGATIVE_INFINITY)) continue;
			values.set(key, value);
			if (condition) conditions.set(key, condition);
			else conditions.delete(key);
		}
		if (row.releaseDate && (!released || row.releaseDate > released)) released = row.releaseDate;
	}
	return { values, conditions, identities, ...(released ? { released } : {}) };
}

/** Value keys measuring `metric`: the column itself, or one per reporter for published results. */
const cohortKeys = (values: ReadonlyMap<string, number>, metric: Metric) =>
	[...values.keys()].filter((key) => key === metric.key || key.startsWith(`${metric.key}@`));

const baseKey = (candidate: CandidateModel) => modelEvidenceTokens(candidate.fastRouteOf ?? candidate.model).join("-");

const blended = (candidate: CandidateModel) => (3 * candidate.cost.input + candidate.cost.output) / 4;

/**
 * Rank every eligible model for the task in code. Quality is the model's
 * standing among every benchmarked model in the catalog on the benchmarks for
 * this kind of work (overall intelligence when it has none), so it does not
 * depend on which other models are eligible. It is weighed against price by how
 * demanding the task is, with a small preference for newer releases.
 */
export function rankCandidates(
	catalog: EvalsCatalog,
	candidates: readonly CandidateModel[],
	needs: ResolvedTaskNeeds,
): RankedCandidate[] {
	const { cohorts } = catalogReadings(catalog);
	const measured = candidates.map((candidate) => ({
		candidate,
		base: baseKey(candidate),
		...measure(catalog, candidate.fastRouteOf ?? candidate.model),
	}));
	const rankOf = (key: string, value: number, own: ReadonlySet<string>): number | undefined => {
		const cohort = cohorts.get(key);
		if (cohort === undefined || cohort.size < MIN_RANKED_MODELS) return undefined;
		const others = [...cohort].filter(([identity]) => !own.has(identity)).map(([, other]) => other);
		return others.length ? others.filter((other) => other < value).length / others.length : undefined;
	};
	const standingOf = (values: ReadonlyMap<string, number>, own: ReadonlySet<string>, metrics: readonly Metric[]) => {
		const ranks = metrics
			.flatMap((metric) => cohortKeys(values, metric))
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
	const qualityWeight = 0.25 + 0.65 * demand;
	const priceWeight = 0.65 - 0.65 * demand;

	return measured
		.map(({ candidate, base, values, conditions, identities, released }) => {
			const workStanding = standingOf(values, identities, WORK_METRICS[needs.work]);
			const overallStanding = standingOf(values, identities, [OVERALL]);
			const quality = workStanding ?? (overallStanding !== undefined ? 0.8 * overallStanding : 0.2);
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
			};
		})
		.sort(
			(a, b) =>
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

const money = (value: number) => `$${Number(value.toPrecision(3))}`;

/**
 * One shortlisted option described with its own evidence, so the router compares
 * options directly: release date, price tier, image input, and results for this
 * kind of work and overall, with standings among catalog models measured on the same benchmark by the same source.
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
	const quote = (metrics: readonly Metric[], standing: number | undefined) => {
		const present = metrics
			.map((metric) => {
				const keys = cohortKeys(option.values, metric);
				const best = keys.sort((a, b) => option.values.get(b)! - option.values.get(a)!)[0];
				return best === undefined ? undefined : { metric, key: best };
			})
			.filter((entry) => entry !== undefined)
			.slice(0, 2);
		if (present.length === 0) return "no published results";
		const results = present
			.map(({ metric, key }) => {
				const condition = option.conditions.get(key);
				return `${metric.label} ${option.values.get(key)}${metric.unit}${condition ? ` measured with ${condition}` : ""}`;
			})
			.join("; ");
		return `${standing === undefined ? "measured" : `${standingLabel(standing)} of models with the same benchmark and source`} (${results})`;
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
		price: `${tier}: ${money(option.cost.input)} / ${money(option.cost.output)} per million tokens${option.ultrafastPriceUnpublished ? "; Ultrafast pricing is not published; this is the standard rate" : ""}`,
		reads_images: option.input.includes("image"),
		[needs.work]: quote(WORK_METRICS[needs.work], option.workStanding),
		overall: quote([OVERALL], option.overallStanding),
		...(option.fastRouteOf
			? {
					route:
						option.fastRouteServiceTier === "ultrafast"
							? `ultrafast request for ${fastBase?.name ?? option.fastRouteOf}; base-model evidence only, no separate latency or benchmark score; account access required`
							: `faster route of ${fastBase?.name ?? option.fastRouteOf} with the same results; billed above the listed prices`,
				}
			: {}),
	});
}
