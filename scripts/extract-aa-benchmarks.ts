#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
/**
 * Regenerates packages/coding-agent/docs/models/evals.md from the public Artificial
 * Analysis Next.js RSC payloads, without an API key. The GPL-3.0
 * artificialanalysis-ai-parser project is prior art for this approach; this
 * MIT-licensed implementation is independently written.
 *
 *   bun run scripts/extract-aa-benchmarks.ts
 *   bun run scripts/extract-aa-benchmarks.ts --leaderboard a.rsc --index b.rsc --date 2026-09-25
 */
import { readFile, writeFile } from "node:fs/promises";

const ORIGIN = "https://artificialanalysis.ai";
const LEADERBOARD_ROUTE = "/leaderboards/providers";
const INDEX_ROUTE = "/evaluations/artificial-analysis-intelligence-index";
const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const DESTINATION = "packages/coding-agent/docs/models/evals.md";

type Unit = "percent" | "points" | "elo";
type Column = { name: string; fields: readonly string[]; unit: Unit };
type Benchmark = Record<string, unknown>;
type ListedModel = { slug: string; name: string; releaseDate?: string };

export interface CatalogSources {
	/** RSC stream listing every leaderboard model and its per-host benchmark objects. */
	readonly leaderboard: string;
	/** RSC stream of the Intelligence Index page, carrying constituent fields for default-chart models. */
	readonly index?: string;
	/** Access date recorded in the catalog, YYYY-MM-DD. */
	readonly accessed: string;
}

const COLUMNS: readonly Column[] = [
	{ name: "idx", fields: ["intelligenceIndex"], unit: "points" },
	{ name: "Brief", fields: ["briefcaseElo", "briefcase"], unit: "elo" },
	{ name: "Gn", fields: ["gdpval", "gdpvalNormalized"], unit: "elo" },
	{ name: "Auto", fields: ["automationBench", "automationBenchPartialScore"], unit: "percent" },
	{ name: "TB4", fields: ["terminalBench40"], unit: "percent" },
	{ name: "Sci", fields: ["scicode"], unit: "percent" },
	{ name: "HLE", fields: ["hle"], unit: "percent" },
	{ name: "PDF", fields: ["gdpPdfAllPass"], unit: "percent" },
	{ name: "Crit", fields: ["critpt"], unit: "percent" },
	{ name: "OA", fields: ["omniscienceAccuracy"], unit: "percent" },
	{ name: "ONH", fields: ["omniscienceNonHallucination"], unit: "percent" },
	{ name: "LCR", fields: ["lcr"], unit: "percent" },
	{ name: "Omni", fields: ["omniscience"], unit: "points" },
	{ name: "GPQA", fields: ["gpqa"], unit: "percent" },
	{ name: "TB21", fields: ["terminalBench21"], unit: "percent" },
	{ name: "TBh", fields: ["terminalbenchHard"], unit: "percent" },
	{ name: "IF", fields: ["ifbench"], unit: "percent" },
	{ name: "MMMU", fields: ["mmmuPro"], unit: "percent" },
	{ name: "tau2", fields: ["tau2"], unit: "percent" },
	{ name: "tauB", fields: ["tauBanking"], unit: "percent" },
	{ name: "Analyst", fields: ["analystAgent"], unit: "percent" },
	{ name: "ITB", fields: ["itbenchSre"], unit: "percent" },
	{ name: "Apex", fields: ["apexAgents"], unit: "percent" },
	{ name: "AIME", fields: ["aime25"], unit: "percent" },
	{ name: "LCB", fields: ["livecodebench"], unit: "percent" },
	{ name: "Harvey", fields: ["harveyLab"], unit: "percent" },
	{ name: "MLCR", fields: ["mlcrOverall"], unit: "percent" },
	{ name: "Open", fields: ["opennessIndex"], unit: "points" },
	{ name: "Ent", fields: ["enterpriseOpsGym"], unit: "percent" },
];

/** End index (exclusive) of the JSON object or array starting at `start`, or -1. */
function jsonValueEnd(text: string, start: number): number {
	let depth = 0;
	let quoted = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === '"') quoted = false;
		} else if (c === '"') quoted = true;
		else if (c === "{" || c === "[") depth++;
		else if ((c === "}" || c === "]") && --depth === 0) return i + 1;
	}
	return -1;
}

function jsonValuesAfter(text: string, marker: string): unknown[] {
	const values: unknown[] = [];
	for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + marker.length)) {
		const start = at + marker.length;
		const end = jsonValueEnd(text, start);
		if (end < 0) continue;
		try {
			values.push(JSON.parse(text.slice(start, end)));
		} catch {
			// Fragments split across RSC chunks are not standalone JSON.
		}
	}
	return values;
}

function rscRows(text: string): Map<string, unknown> {
	const rows = new Map<string, unknown>();
	for (const line of text.split("\n")) {
		const match = /^([\da-f]+):(.*)$/iu.exec(line);
		if (!match) continue;
		try {
			rows.set(match[1].toLowerCase(), JSON.parse(match[2]));
		} catch {
			// Module and text records are not JSON values.
		}
	}
	return rows;
}

function resolveReferences(
	value: unknown,
	rows: Map<string, unknown>,
	resolving: ReadonlySet<string> = new Set(),
): unknown {
	if (typeof value === "string") {
		const reference = /^\$([\da-f]+)(?::(.+))?$/iu.exec(value);
		if (!reference) return value;
		const id = reference[1].toLowerCase();
		if (resolving.has(id)) return value;
		let resolved = rows.get(id);
		for (const property of reference[2]?.split(":") ?? []) {
			if (resolved === null || typeof resolved !== "object") return value;
			resolved = (resolved as Record<string, unknown>)[property];
		}
		return resolved === undefined ? value : resolveReferences(resolved, rows, new Set([...resolving, id]));
	}
	if (Array.isArray(value)) return value.map((item) => resolveReferences(item, rows, resolving));
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, resolveReferences(item, rows, resolving)]),
		);
	return value;
}

function isPresent(value: unknown): boolean {
	return value !== null && value !== undefined && !(typeof value === "string" && value.startsWith("$"));
}

function isRecord(value: unknown): value is Benchmark {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectRecords(value: unknown, accept: (record: Benchmark) => boolean, into: Benchmark[]): void {
	if (Array.isArray(value)) for (const item of value) collectRecords(item, accept, into);
	else if (isRecord(value)) {
		if (accept(value)) into.push(value);
		for (const item of Object.values(value)) collectRecords(item, accept, into);
	}
}

function mergeBySlug(records: readonly Benchmark[], into: Map<string, Benchmark>): void {
	for (const record of records) {
		if (typeof record.slug !== "string") continue;
		const merged = into.get(record.slug) ?? {};
		for (const [key, value] of Object.entries(record))
			if (isPresent(value) && !isPresent(merged[key])) merged[key] = value;
		into.set(record.slug, merged);
	}
}

function leaderboardModels(text: string): ListedModel[] {
	const list = jsonValuesAfter(text, '"models":').find(
		(value): value is ListedModel[] =>
			Array.isArray(value) && value.length > 0 && isRecord(value[0]) && "slug" in value[0],
	);
	if (!list) throw new Error("Leaderboard RSC stream did not contain a models array");
	return list;
}

function benchmarkRecords(sources: CatalogSources): Map<string, Benchmark> {
	const bySlug = new Map<string, Benchmark>();
	if (sources.index) {
		const records: Benchmark[] = [];
		for (const row of rscRows(sources.index).values())
			collectRecords(row, (record) => typeof record.slug === "string" && "gdpPdfAllPass" in record, records);
		mergeBySlug(records, bySlug);
	}
	const rows = rscRows(sources.leaderboard);
	const hostModels = jsonValuesAfter(sources.leaderboard, '"model":')
		.map((value) => resolveReferences(value, rows))
		.filter(isRecord);
	mergeBySlug(hostModels, bySlug);
	return bySlug;
}

function display(value: unknown, unit: Unit): string {
	const raw = isRecord(value) ? value.elo : value;
	if (typeof raw !== "number" || !Number.isFinite(raw)) return "∅";
	const scaled = unit === "percent" ? raw * 100 : unit === "elo" ? Math.max(0, Math.min(100, (raw - 500) / 20)) : raw;
	return String(Math.round(Number(scaled.toPrecision(12)) * 10) / 10);
}

function cell(record: Benchmark, column: Column): string {
	const field = column.fields.find((name) => isPresent(record[name]));
	if (field === undefined) return "∅";
	return display(record[field], field === "gdpvalNormalized" ? "percent" : column.unit);
}

function preamble(sources: CatalogSources, modelCount: number, unsourced: readonly string[]): string {
	const unsourcedNote = unsourced.length
		? `- ${unsourced.map((name) => `\`${name}\``).join(", ")} have no values in the public payloads and are \`∅\` for every row.\n`
		: "";
	return `---
title: "Evals"
description: "Primary-source benchmark facts used by Atomic automatic model routing."
---

# Evals

Last Accessed: ${sources.accessed}.

Key:

- \`∅\`=source null/absent, not zero.
- Values are rounded to 1 decimal from the public [model leaderboard](https://artificialanalysis.ai/leaderboards/models) and [Intelligence Index](https://artificialanalysis.ai/evaluations/artificial-analysis-intelligence-index) pages. Each row includes the model's release date.
- \`PDF\`, \`MLCR\`, \`Open\`, \`Ent\`, and \`Analyst\` are published only for models shown on the default Intelligence Index chart; other rows are \`∅\` for those columns.
${unsourcedNote}- A chart label may show the nearest integer of \`idx\`.
- \`idx\`: Intelligence Index points, aggregate performance across knowledge, reasoning, coding, and agentic work.
- \`Brief\`: AA-Briefcase, long-horizon business knowledge work producing spreadsheets, presentations, and memos; normalized Elo \`clamp((Elo-500)/2000)*100\`.
- \`Gn\`: GDPval-AA, economically valuable professional work across occupations; normalized Elo \`clamp((Elo-500)/2000)*100\`.
- \`Omni\`: Omniscience Index, factual knowledge reliability, rewarding correct answers and penalizing incorrect guesses without penalizing abstention; -100 to 100.
- \`Open\`: Openness Index points, model availability and transparency of training data and methodology, not task-solving ability.
- Other score columns are percent.
- \`OA\`: Omniscience accuracy, factual recall across knowledge domains.
- \`ONH\`: Omniscience non-hallucination, avoiding incorrect guesses when unable to answer fully; the ONH rate \`(partial+notattempted)/(incorrect+partial+notattempted)\`, not 1 minus the hallucination rate.
- \`PDF\`: GDP.pdf All-pass, reasoning over long professional documents while satisfying every task-specific criterion.
- \`Auto\`: AutomationBench-AA, completing multi-step SaaS workflows without guardrail violations.
- \`TB4\`: Terminal-Bench 4.0, agentic coding and terminal work across software engineering, systems administration, data processing, model training, and security.
- \`TB21\`: Terminal-Bench 2.1, an earlier terminal-task suite covering coding, systems administration, data processing, model training, and security.
- \`TBh\`: Terminal-Bench Hard, the legacy hard terminal-task subset testing coding, systems administration, and data processing.
- \`Sci\`: SciCode, writing scientific Python code to solve scientist-curated research problems, graded by execution tests.
- \`HLE\`: Humanity's Last Exam, expert-level academic knowledge and reasoning across mathematics, sciences, and humanities.
- \`Crit\`: CritPt, research-level physics reasoning.
- \`LCR\`: AA-LCR, extracting, reasoning about, and synthesizing information across long documents.
- \`GPQA\`: GPQA Diamond, graduate-level scientific reasoning in biology, physics, and chemistry.
- \`IF\`: IFBench, precise instruction following under verifiable output constraints.
- \`MMMU\`: MMMU-Pro, multimodal understanding and visual reasoning across academic disciplines.
- \`tau2\`: τ²-Bench Telecom, conversational tool use and coordination with a simulated user to resolve telecom support issues.
- \`tauB\`: Banking tool-use benchmark, knowledge retrieval and multi-step customer-support workflows.
- \`Analyst\`: AA-AnalystAgent, end-to-end quantitative analysis of real-world spreadsheets and documents.
- \`ITB\`: ITBench SRE, identifying Kubernetes incident root causes from alerts, events, traces, and topology.
- \`Apex\`: APEX-Agents, long-horizon, cross-application work in investment banking, consulting, and corporate law.
- \`AIME\`: AIME 2025, competition-level mathematical problem solving.
- \`LCB\`: LiveCodeBench, generating correct code for recent competitive programming problems.
- \`Harvey\`: Harvey LAB-AA, producing legal deliverables from case documents, graded against task-specific criteria.
- \`MLCR\`: Medical Long Context Reasoning overall, synthesizing long, fragmented medical records for healthcare and insurance case review.
- \`Ent\`: EnterpriseOps-Gym-AA, stateful, multi-step business workflows using tools, graded on the resulting database state.

## Artificial Analysis Intelligence Index v4.3.2

Table: all ${modelCount} models on the Artificial Analysis leaderboard, including models with no published scores.

`;
}

export function renderCatalog(sources: CatalogSources): string {
	const models = leaderboardModels(sources.leaderboard);
	const records = benchmarkRecords(sources);
	const rows = models.map((model) => {
		const record = records.get(model.slug) ?? {};
		return [model.slug, model.name, model.releaseDate ?? "∅", ...COLUMNS.map((column) => cell(record, column))];
	});
	const unsourced = COLUMNS.filter((_, index) => rows.every((row) => row[index + 3] === "∅")).map(
		(column) => column.name,
	);
	const header = ["slug", "Model", "Release date", ...COLUMNS.map((column) => column.name)];
	const table = [
		`| ${header.join(" | ")} |`,
		`| ${header.map((_, index) => (index < 3 ? "---" : "---:")).join(" | ")} |`,
		...rows.map((row) => `| ${row.join(" | ")} |`),
	];
	return `${preamble(sources, models.length, unsourced)}${table.join("\n")}\n`;
}

async function fetchRsc(route: string): Promise<string> {
	const response = await fetch(`${ORIGIN}${route}?_rsc=atomic`, {
		headers: { rsc: "1", "next-url": route, "user-agent": USER_AGENT },
		signal: AbortSignal.timeout(60_000),
	});
	if (!response.ok) throw new Error(`Artificial Analysis ${route} returned HTTP ${response.status}`);
	return response.text();
}

function option(args: readonly string[], name: string): string | undefined {
	const at = args.indexOf(name);
	return at >= 0 ? args[at + 1] : undefined;
}

const AA_SECTION_HEADING = "## Artificial Analysis Intelligence Index";

/**
 * Hand-maintained sections after the generated Artificial Analysis table, such
 * as DeepSWE and FrontierCode, which this script does not source. Regenerating
 * the Artificial Analysis table keeps them verbatim.
 */
export function maintainedSections(existing: string): string {
	const aaHeading = existing.indexOf(`\n${AA_SECTION_HEADING}`);
	if (aaHeading < 0) return "";
	const next = existing.indexOf("\n## ", aaHeading + 1);
	return next < 0 ? "" : existing.slice(next + 1);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const leaderboardFile = option(args, "--leaderboard");
	const indexFile = option(args, "--index");
	const sources: CatalogSources = {
		leaderboard: leaderboardFile ? await readFile(leaderboardFile, "utf8") : await fetchRsc(LEADERBOARD_ROUTE),
		index: indexFile ? await readFile(indexFile, "utf8") : await fetchRsc(INDEX_ROUTE),
		accessed: option(args, "--date") ?? new Date().toISOString().slice(0, 10),
	};
	const existing = await readFile(DESTINATION, "utf8").catch(() => "");
	const maintained = maintainedSections(existing);
	const generated = renderCatalog(sources);
	await writeFile(DESTINATION, `${generated}${maintained ? `\n${maintained}` : ""}`);
	const rows = generated.split("\n").filter((line) => line.startsWith("| ")).length - 2;
	console.log(
		`Wrote ${rows} Artificial Analysis model rows to ${DESTINATION}; kept the maintained sections below it.`,
	);
}

if (import.meta.main) await main();
