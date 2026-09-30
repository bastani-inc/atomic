import { jsonBytes, truncateToBytes } from "./model-routing-bytes.js";

/** Bounds the evaluation evidence sent with one routing request. */
export const MODEL_SELECTION_EVALS_JSON_BYTES = 14_200;

const VENDOR_OR_REGION_PREFIX = /^(?:[a-z][a-z-]*\.)+/u;
const SNAPSHOT_TOKEN = /^\d{4}$/u;
const DEPLOYMENT_TOKENS = new Set([
	"highspeed",
	"ultraspeed",
	"lightning",
	"beta",
	"exp",
	"free",
	"it",
	"instruct",
	"contributor",
]);
const ROW_EDITION_TOKENS = new Set(["preview", "instruct", "it"]);
const VARIANT_TOKENS = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"adaptive",
	"thinking",
	"reasoning",
	"non",
	"effort",
	"preview",
]);
const CLAUDE_FAMILIES = new Set(["opus", "sonnet", "haiku", "fable"]);

/** Artificial Analysis names older Claude models `claude-4-5-sonnet`; catalogs use `claude-sonnet-4-5`. */
function canonicalClaudeOrder(tokens: string[]): string[] {
	if (tokens[0] !== "claude" || !CLAUDE_FAMILIES.has(tokens[1] ?? "")) return tokens;
	const versionEnd = tokens.findIndex((token, index) => index > 1 && !/^\d+$/u.test(token));
	const end = versionEnd < 0 ? tokens.length : versionEnd;
	if (end === 2) return tokens;
	return ["claude", ...tokens.slice(2, end), tokens[1]!, ...tokens.slice(end)];
}

/** Provider-independent model tokens: `us.anthropic.claude-opus-4-6-v1` and `anthropic/claude-opus-4.6` agree. */
export function modelEvidenceTokens(id: string): string[] {
	const normalized = id.trim().toLowerCase();
	const model = normalized
		.slice(normalized.lastIndexOf("/") + 1)
		.replace(/^~/u, "")
		.replace(VENDOR_OR_REGION_PREFIX, "")
		.replace(/(?<=[a-z])-\d+:\d+$/u, "")
		.replace(/:[a-z0-9]+$/u, "")
		.replace(/-v\d+$/u, "")
		.replace(/-\d{8}$/u, "");
	const tokens = model
		.split(/[-._]/u)
		.filter(Boolean)
		.map((token) => (token === "thinking" ? "reasoning" : token));
	return canonicalClaudeOrder(tokens);
}

const isVariantSuffix = (token: string) =>
	VARIANT_TOKENS.has(token) || ROW_EDITION_TOKENS.has(token) || SNAPSHOT_TOKEN.test(token);

/** True when `slug` is the candidate model or one of its effort, edition or snapshot variants. */
function slugMatchesCandidate(slug: readonly string[], candidate: readonly string[]): boolean {
	if (slug.length < candidate.length || candidate.some((token, index) => slug[index] !== token)) return false;
	return slug.slice(candidate.length).every(isVariantSuffix);
}

/** One catalog model across its effort, edition and snapshot rows: `astra-high` and `astra-0902` are `astra`. */
export function catalogModelIdentity(slug: readonly string[]): string {
	let end = slug.length;
	while (end > 1 && isVariantSuffix(slug[end - 1]!)) end--;
	return slug.slice(0, end).join("-");
}

/**
 * The candidate's own tokens first, then the same model without trailing
 * deployment, reasoning-mode or snapshot suffixes (`grok-4.20-reasoning`,
 * `qwen3.8-max-0902`). Fast is part of the owned identity, not a deployment
 * alias: only explicit route metadata at the caller permits base-model reuse.
 * A fallback applies only when the more specific form matched no row.
 */
function candidateForms(tokens: readonly string[]): string[][] {
	const forms = [[...tokens]];
	let current = [...tokens];
	while (current.length > 1) {
		const last = current[current.length - 1]!;
		if (!DEPLOYMENT_TOKENS.has(last) && !VARIANT_TOKENS.has(last) && !SNAPSHOT_TOKEN.test(last)) break;
		current = current.slice(0, -1);
		forms.push(current);
	}
	return forms;
}

interface CatalogRow {
	readonly line: string;
	readonly section: number;
	readonly order: number;
	readonly tokens: readonly string[];
	readonly releaseDate?: string;
}

/** One `## ` section of `evals.md` that holds a model table keyed by `slug`. */
interface CatalogSection {
	/** The section heading, its notes and key, the table header and separator. */
	readonly intro: readonly string[];
}

/** `evals.md` parsed once so batch packing can query evidence per candidate cheaply. */
export interface EvalsCatalog {
	/** Text before the first table section: title, access date and the shared key. */
	readonly preamble: readonly string[];
	readonly sections: readonly CatalogSection[];
	readonly rows: readonly CatalogRow[];
	/** The unparsed document when it has no model table. */
	readonly raw?: string;
	readonly matches: Map<string, readonly CatalogRow[]>;
}

const TABLE_HEADER = /^\|\s*slug\s*\|/u;

export function parseEvalsCatalog(evals: string): EvalsCatalog {
	const lines = evals.split("\n");
	const headers = lines.flatMap((line, index) => (TABLE_HEADER.test(line) ? [index] : []));
	if (headers.length === 0) return { preamble: [], sections: [], rows: [], raw: evals, matches: new Map() };
	const sections: CatalogSection[] = [];
	const rows: CatalogRow[] = [];
	let preambleEnd = 0;
	let previousTableEnd = 0;
	for (const [section, headerIndex] of headers.entries()) {
		let start = headerIndex;
		for (let index = headerIndex - 1; index >= previousTableEnd; index--)
			if (lines[index]!.startsWith("## ")) {
				start = index;
				break;
			}
		if (section === 0) preambleEnd = start;
		sections.push({ intro: lines.slice(start, headerIndex + 2) });
		const header = lines[headerIndex]!.split("|").map((cell) => cell.trim());
		const releaseColumn = header.indexOf("Release date");
		let index = headerIndex + 2;
		for (; index < lines.length && lines[index]!.startsWith("|"); index++) {
			const cells = lines[index]!.split("|").map((cell) => cell.trim());
			if (!cells[1]) continue;
			const release = releaseColumn > 0 ? cells[releaseColumn] : undefined;
			rows.push({
				line: lines[index]!,
				section,
				order: rows.length,
				tokens: modelEvidenceTokens(cells[1]),
				...(release && /^\d{4}-\d{2}-\d{2}$/u.test(release) ? { releaseDate: release } : {}),
			});
		}
		previousTableEnd = index;
	}
	return { preamble: lines.slice(0, preambleEnd), sections, rows, matches: new Map() };
}

/**
 * Rows describing `candidate`: in each section, its own model and variants, or
 * its base model when that section has none. Sections resolve independently, so
 * an exact snapshot row in one table does not hide the base model's rows in another.
 */
export function candidateEvidenceRows(catalog: EvalsCatalog, candidate: string): readonly CatalogRow[] {
	const cached = catalog.matches.get(candidate);
	if (cached) return cached;
	const forms = candidateForms(modelEvidenceTokens(candidate));
	const matches = catalog.sections.flatMap((_, section) => {
		const sectionRows = catalog.rows.filter((row) => row.section === section);
		for (const form of forms) {
			const found = sectionRows.filter((row) => slugMatchesCandidate(row.tokens, form));
			if (found.length > 0) return found;
		}
		return [];
	});
	catalog.matches.set(candidate, matches);
	return matches;
}

/** Latest release date among the candidate's evidence rows, when any row has one. */
export function candidateReleaseDate(catalog: EvalsCatalog, candidate: string): string | undefined {
	const dates = candidateEvidenceRows(catalog, candidate).flatMap((row) => (row.releaseDate ? [row.releaseDate] : []));
	return dates.length ? dates.sort().at(-1) : undefined;
}

/**
 * The catalog preamble plus, for every section with rows for `candidates`, that
 * section's heading, key and table header followed by only those rows.
 * Sections without a matching row are left out. `maxBytes` bounds the
 * JSON-encoded result; batched routing omits it because its request budget
 * already decides how many candidates, and so how many rows, one batch holds.
 */
export function catalogEvidence(
	catalog: EvalsCatalog,
	candidates: readonly string[],
	maxBytes = Number.POSITIVE_INFINITY,
): string {
	if (catalog.raw !== undefined) return truncateToBytes(catalog.raw, maxBytes);
	const selected = new Set<number>();
	for (const candidate of new Set(candidates))
		for (const row of candidateEvidenceRows(catalog, candidate)) selected.add(row.order);
	const kept = catalog.rows.filter((row) => selected.has(row.order));
	const parts = [...catalog.preamble];
	for (const [index, section] of catalog.sections.entries()) {
		const sectionRows = kept.filter((row) => row.section === index);
		if (index > 0 && sectionRows.length === 0) continue;
		if (index > 0 && parts.at(-1) !== "") parts.push("");
		parts.push(...section.intro, ...sectionRows.map((row) => row.line));
	}
	const filtered = parts.join("\n");
	return jsonBytes(filtered) <= maxBytes ? filtered : truncateToBytes(filtered, maxBytes);
}

/**
 * Keep the catalog preamble and only the table rows that describe an eligible
 * candidate model, bounded to the routing evidence budget.
 */
export function filterModelSelectionEvals(evals: string, candidates: readonly string[]): string {
	return catalogEvidence(parseEvalsCatalog(evals), candidates, MODEL_SELECTION_EVALS_JSON_BYTES);
}
