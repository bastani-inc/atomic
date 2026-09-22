import assert from "node:assert/strict";
import { test } from "vitest";
import { readJson, readText } from "../helpers/runtime.js";

interface AaSourceLabel {
	readonly row: string;
	readonly modelSlug: string;
	readonly rowLabel: string;
	readonly chartLabel: string;
	readonly fullConfigLabel: string;
	readonly sourceUrl: string;
	readonly accessed: string;
}

interface SourceFidelityFixture {
	readonly counts: {
		readonly aaRows: number;
		readonly aaAggregateRows: number;
		readonly aaDisplayedConstituentRecords: number;
		readonly aaDisplayedTotalRecords: number;
		readonly frontierMainRows: number;
		readonly frontierExtendedRows: number;
	};
	readonly aaRows: readonly string[];
	readonly aaSourceLabels: readonly AaSourceLabel[];
	readonly frontierRows: readonly string[];
	readonly sentinels: Record<string, string>;
	readonly metadata: Record<
		string,
		{
			readonly url: string;
			readonly accessed: string;
			readonly version: string;
			readonly units: string;
			readonly valueShape: string;
		}
	>;
	readonly shapeChecks: Record<
		string,
		{ readonly ordered: boolean; readonly values: number; readonly null: string; readonly zero?: string }
	>;
}

const fixturePath = "test/fixtures/router-benchmark/source-fidelity.json";
async function sourceFixture(): Promise<SourceFidelityFixture> {
	return readJson<SourceFidelityFixture>(fixturePath);
}
function tableCells(row: string): string[] {
	return row
		.split("|")
		.slice(1, -1)
		.map((cell) => cell.trim());
}
function sectionRows(document: string, prefix: string): string[] {
	return document.split("\n").filter((line) => new RegExp(`^\\| ${prefix}\\d{2} `).test(line));
}
function compactRow(row: string, prefix: string): string {
	const cells = tableCells(row);
	if (prefix === "A") {
		const [id, model, ...values] = cells;
		return `${id} ${model}|${values.join("/")}`;
	}
	if (prefix === "D") {
		const [id, model, effort, ...values] = cells;
		return `${id} ${model}[${effort}] ${values.join(" ")}`;
	}
	const [id, model, effort, harness, ...values] = cells;
	return `${id} ${model}[${effort};${harness}] ${values.join("/")}`;
}
function sourceValues(row: string, prefix: string): string[] {
	if (prefix === "A") return row.split("|")[1]!.split("/");
	const metrics = row.match(/\] (.+)$/u)?.[1];
	assert.ok(metrics, row);
	return prefix === "F" ? metrics.split("/") : metrics.split(" ");
}

function assertSourceRows(document: string, rows: readonly string[], prefix: string, expectedValues: number): void {
	const actual = sectionRows(document, prefix).map((row) => compactRow(row, prefix));
	assert.deepEqual(actual, rows, `${prefix} rows must preserve source order, identity, and displayed values`);
	assert.equal(actual.length, rows.length);
	const values = actual.map((row) => sourceValues(row, prefix));
	for (const rowValues of values) {
		assert.equal(rowValues.length, expectedValues, rowValues.join("/"));
		assert.ok(
			rowValues.every((value) => value === "∅" || value === "—" || /^-?\d+(?:\.\d+)?(?:±\d+)?$/.test(value)),
			rowValues.join("/"),
		);
	}
	if (prefix !== "D") {
		assert.ok(
			values.some((row) => row.includes(prefix === "A" ? "∅" : "—")),
			`${prefix} null sentinel`,
		);
		assert.ok(
			values.some((row) => row.some((value) => /^0(?:\.0+)?$/.test(value))),
			`${prefix} zero sentinel`,
		);
	}
}

test("the general model-selection guide stays compact and points to factual evals", async () => {
	const guide = await readText("packages/coding-agent/docs/models/model-selection.md");
	assert.ok(Buffer.byteLength(JSON.stringify(guide), "utf8") <= 8_000);
	assert.match(guide, /\[Evals\]\(\/models\/evals\)/);
	assert.match(guide, /Role-based thinking effort/);
	assert.match(guide, /Choose only eligible provider\/model and effort pairs/);
	assert.doesNotMatch(guide, /^\| Model \[measured effort\]/m);
	assert.doesNotMatch(guide, /\b\d+% ±\d+\b/);
	assert.doesNotMatch(guide, /implementation and debugging work should look/i);
	assert.doesNotMatch(guide, /planning and research work should look/i);
	assert.doesNotMatch(guide, /narrow domain tasks should use/i);
});

test("the factual evals document keeps the top Intelligence Index rows that fit Jev", async () => {
	const evals = await readText("packages/coding-agent/docs/models/evals.md");
	const fixture = await sourceFixture();
	assert.match(evals, /Artificial Analysis Intelligence Index v4\.3\.2/);
	assert.match(evals, /Cognition FrontierCode 1\.1/);
	assert.match(evals, /Terminal-Bench 4\.0/);
	assert.match(evals, /normalized Elo.*clamp/);
	assert.match(evals, /6,000-question ONH.*\(partial\+notattempted\)\/\(incorrect\+partial\+notattempted\)/);
	assert.match(evals, /top 26 catalog models/);
	assert.match(evals, /32k tokens for state plus the longest question/);
	assert.doesNotMatch(evals, /^## Grok 4\.7$/m);
	assert.match(evals, /\| slug \| Model \| idx \| Brief \| Gn \| Auto \| TB4 \|/);
	assert.match(evals, /\| grok-4-7 \| Grok 4\.7 \(xhigh\) \| 46\.4 \| 57\.9 \| 59\.8 \| 65\.6 \| 25\.8 \|/);
	assert.match(evals, /\| grok-4-7-high \| Grok 4\.7 \(high\) \| 46\.3 \| 57\.2 \| 59\.7 \| 63\.5 \| 24\.7 \|/);
	assert.match(
		evals,
		/\| claude-opus-5-5 \| Claude Opus 5\.5 \(Adaptive Reasoning, Max Effort, Default Fallback\) \| 57\.6 \| 66\.1 \| 67\.3 \| 69\.5 \| 59\.6 \|/,
	);
	assert.match(evals, /\| gpt-6-luna \| GPT-6 Luna \(max\) \| 37\.3 \| ∅ \| 43\.4 \| ∅ \| 12\.6 \| 54\.6 \| 38\.5 \|/);
	const aaRows = evals
		.slice(evals.indexOf("| --- |"), evals.indexOf("## Cognition"))
		.split("\n")
		.filter((line) => line.startsWith("| ") && !line.startsWith("| ---"));
	assert.equal(aaRows.length, 27);
	const aaHeaderCells = evals.match(/^\| slug \|.*$/m)![0].split("|").length;
	for (const row of aaRows) assert.equal(row.split("|").length, aaHeaderCells, row);
	assert.doesNotMatch(evals, /no suffix=`?max|slug model names are exact source labels/i);
	assertSourceRows(evals, fixture.frontierRows, "F", fixture.shapeChecks.frontierMainRows.values);
	assert.match(evals, /\| GPT-6 Astra \| max \| codex \|/);
	assert.match(evals, /\| DeepSeek V4 Pro 0813 \| high \| chisel \|/);
	assert.match(evals, /\| MiniMax M3 \| none \| msa \|/);
	assert.match(evals, /\| Mistral 3\.5 Medium \| none \| chisel \|/);
	assert.match(evals, /Inkling `0\.99` is unexplained/);
	assert.match(evals, /`∅`=source null\/absent, not zero/);
	assert.doesNotMatch(evals, /recommend|prefer|should choose|best for/i);
});
