import assert from "node:assert/strict";
import { test } from "vitest";
import { catalogEvidence, parseEvalsCatalog } from "../../packages/coding-agent/src/core/model-routing-evals.js";
import { readText } from "../helpers/runtime.js";

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

test("the model selection docs prefer recently released comparable models", async () => {
	const docs = await readText("packages/coding-agent/docs/models/model-selection.md");
	const rule =
		/Prefer recency\..*most recently released model over an older one.*Do not let an older model win only because it has no published results.*Recency does not override the role's cost tier/su;
	assert.match(docs, rule);
	assert.match(await readText("packages/coding-agent/docs/models/evals.md"), /^\| slug \| Model \| Release date \|/mu);
});

test("the factual evals document includes every Artificial Analysis leaderboard model", async () => {
	const evals = await readText("packages/coding-agent/docs/models/evals.md");
	assert.match(evals, /Artificial Analysis Intelligence Index v4\.3\.2/u);
	assert.doesNotMatch(evals, /^\| F\d{2} /imu);
	assert.match(evals, /Terminal-Bench 4\.0/u);
	assert.match(evals, /normalized Elo.*clamp/u);
	assert.match(evals, /ONH rate.*\(partial\+notattempted\)\/\(incorrect\+partial\+notattempted\)/u);
	assert.doesNotMatch(evals, /top 26|Fifty does not fit|32k tokens for state/u);
	assert.doesNotMatch(evals, /^## Grok 4\.7$/mu);
	assert.match(
		evals,
		/^Last Accessed: 2026-10-26 \(GPT-6\.1 Terra additions; earlier rows retain their snapshot dates below\)\.$/mu,
	);
	assert.match(evals, /^\| slug \| Model \| Release date \| idx \| Brief \| Gn \| Auto \| TB4 \|/mu);
	assert.match(
		evals,
		/^\| grok-4-7 \| Grok 4\.7 \(xhigh\) \| 2026-09-21 \| 46\.4 \| 57\.9 \| 59\.8 \| 65\.6 \| 25\.8 \|/mu,
	);
	assert.match(
		evals,
		/^\| grok-4-7-high \| Grok 4\.7 \(high\) \| 2026-09-21 \| 46\.3 \| 56\.8 \| 59\.7 \| 63\.5 \| 24\.7 \|/mu,
	);
	assert.match(
		evals,
		/^\| claude-opus-5-5 \| Claude Opus 5\.5 \(Adaptive Reasoning, Max Effort, Default Fallback\) \| 2026-09-22 \| 57\.6 \| 66\.1 \| 67\.3 \| 69\.5 \| 59\.6 \|/mu,
	);
	assert.match(
		evals,
		/^\| claude-sonnet-5-5 \| Claude Sonnet 5\.5 \(Adaptive Reasoning, Max Effort, Default Fallback\) \| 2026-09-28 \| 56 \| 65\.5 \| 67\.2 \| 71\.3 \| 63\.6 \|/mu,
	);
	assert.match(
		evals,
		/^\| gpt-6-luna \| GPT-6 Luna \(max\) \| 2026-09-22 \| 37\.3 \| 40 \| 43\.4 \| 53\.2 \| 12\.6 \|/mu,
	);
	const lines = evals.split("\n");
	const aaStart = lines.findIndex((line) => line.startsWith("| slug |")) + 2;
	const aaEnd = lines.findIndex((line, index) => index >= aaStart && !line.startsWith("| "));
	const aaRows = lines.slice(aaStart, aaEnd < 0 ? undefined : aaEnd);
	const caption =
		/^Table: the (\d+) models on the Artificial Analysis leaderboard as of 2026-09-25, including models with no published scores, plus (\d+) Claude Sonnet 5\.5 rows accessed 2026-09-28, (\d+) GPT-6\.1 Sol rows accessed 2026-09-29, (\d+) Claude Haiku 5\.5 rows accessed 2026-10-07, and (\d+) GPT-6\.1 Terra rows accessed 2026-10-26\.$/mu.exec(
			evals,
		);
	assert.ok(caption, "the caption dates the leaderboard and later model additions separately");
	assert.equal(
		aaRows.length,
		Number(caption[1]) + Number(caption[2]) + Number(caption[3]) + Number(caption[4]) + Number(caption[5]),
	);
	assert.ok(aaRows.length > 500, "the catalog covers the whole leaderboard, not a top-N excerpt");
	const aaHeaderCells = evals.match(/^\| slug \|.*$/mu)![0].split("|").length;
	for (const row of aaRows) assert.equal(row.split("|").length, aaHeaderCells, row);
	assert.doesNotMatch(evals, /no suffix=`?max|slug model names are exact source labels/i);
	const scoreColumns = evals
		.match(/^\| slug \|.*$/mu)![0]
		.split("|")
		.slice(4, -1)
		.map((cell) => cell.trim());
	for (const column of scoreColumns) {
		const description = evals.split("\n").find((line) => line.startsWith(`- \`${column}\`:`));
		assert.ok(description && /, \S.+/.test(description), `${column} must describe what it measures`);
	}
	assert.match(evals, /Openness Index.*not task-solving ability/u);
	assert.match(evals, /`∅`=source null\/absent, not zero/u);
	assert.doesNotMatch(evals, /recommend|prefer|should choose|best for/i);
});

function sectionTable(evals: string, heading: string): { header: string[]; rows: string[][] } {
	const lines = evals.split("\n");
	const start = lines.indexOf(heading);
	assert.ok(start >= 0, `missing section ${heading}`);
	const headerIndex = lines.findIndex((line, index) => index > start && line.startsWith("| slug |"));
	const cells = (line: string) =>
		line
			.split("|")
			.slice(1, -1)
			.map((cell) => cell.trim());
	const rows: string[][] = [];
	for (let index = headerIndex + 2; lines[index]?.startsWith("| "); index++) rows.push(cells(lines[index]!));
	return { header: cells(lines[headerIndex]!), rows };
}

test("DeepSWE, FrontierCode and published results are sourced tables the router can match by slug", async () => {
	const evals = await readText("packages/coding-agent/docs/models/evals.md");

	const deepswe = sectionTable(evals, "## DeepSWE v1.1");
	assert.deepEqual(deepswe.header, ["slug", "Model", "Effort", "Pass@1", "CI", "Cost", "Out tok", "Steps"]);
	assert.equal(deepswe.rows.length, 25);
	assert.deepEqual(deepswe.rows[0]?.slice(0, 4), ["gpt-6-astra", "gpt-6-astra", "xhigh", "74"]);
	assert.match(evals, /\[DeepSWE leaderboard\]\(https:\/\/deepswe\.datacurve\.ai\/\)/u);

	const frontierCode = sectionTable(evals, "## FrontierCode 1.1");
	assert.equal(frontierCode.rows.length, 43);
	assert.deepEqual(frontierCode.rows.find((row) => row[0] === "claude-sonnet-5-5")?.slice(2), [
		"xhigh",
		"52.1",
		"57.2",
		"64.4",
		"69.9",
		"0.0",
		"$1.59",
	]);
	assert.deepEqual(frontierCode.rows.find((row) => row[0] === "gpt-6-astra")?.slice(2, 6), [
		"max",
		"53.3",
		"58.8",
		"64.5",
	]);
	assert.match(evals, /\[FrontierCode leaderboard\]\(https:\/\/cognition\.com\/frontiercode\)/u);

	const published = sectionTable(evals, "## Published benchmark results");
	const sources = new Set([
		"OpenAI",
		"Anthropic",
		"Google",
		"ARC Prize",
		"TB-Science leaderboard",
		"Zapier",
		"Artificial Analysis",
	]);
	for (const row of published.rows) {
		assert.ok(sources.has(row[5]!), `unknown source in ${row.join(" | ")}`);
		const description = evals.split("\n").find((line) => line.includes(`\`${row[2]}\``) && line.startsWith("- "));
		assert.ok(description, `${row[2]} must be described in the section key`);
	}
	assert.doesNotMatch(
		evals,
		/Internal (Design|Data Science|Database Migration)|MedChemBench|GeneBench|LifeSciBench|MRCR/u,
	);
	assert.ok(
		published.rows.some((row) => row[0] === "gemini-3-8-flash" && row[2] === "TBSci" && row[3] === "12.4"),
		"missing cells are filled from primary sources",
	);
	assert.ok(
		published.rows.some(
			(row) => row[0] === "claude-sonnet-5-5" && row[2] === "TBSci" && row[3] === "59.9" && row[5] === "Anthropic",
		),
		"Claude Sonnet 5.5 results come from Anthropic's launch materials",
	);
});

const TERRA_AA_PUBLISHED_COLUMNS = [
	"idx",
	"Brief",
	"Gn",
	"Auto",
	"TB4",
	"Sci",
	"HLE",
	"PDF",
	"Crit",
	"OA",
	"ONH",
	"LCR",
	"Omni",
	"MMMU",
];
const TERRA_AA_ROWS: ReadonlyArray<readonly [slug: string, model: string, values: readonly string[]]> = [
	[
		"gpt-6-1-terra",
		"GPT-6.1 Terra (max)",
		["48.1", "45.1", "48.8", "60.2", "55.6", "55.1", "46.2", "28.6", "28.0", "49.1", "62.0", "82.7", "29.8", "84.7"],
	],
	[
		"gpt-6-1-terra-xhigh",
		"GPT-6.1 Terra (xhigh)",
		["45.4", "41.6", "45.8", "59.9", "46.5", "53.4", "43.7", "26.6", "26.6", "49.6", "58.5", "81.7", "28.7", "83.8"],
	],
	[
		"gpt-6-1-terra-high",
		"GPT-6.1 Terra (high)",
		["43.9", "38.2", "42.7", "58.5", "41.9", "51.6", "43.3", "28.0", "25.7", "50.0", "56.9", "82.3", "28.4", "83.8"],
	],
	[
		"gpt-6-1-terra-medium",
		"GPT-6.1 Terra (medium)",
		["41.3", "34.5", "41.3", "57.8", "32.3", "51.6", "40.2", "28.4", "21.4", "49.4", "56.0", "80.7", "27.1", "82.8"],
	],
	[
		"gpt-6-1-terra-low",
		"GPT-6.1 Terra (low)",
		["36.2", "26.5", "35.2", "56.2", "15.2", "52.4", "35.8", "25.6", "15.1", "47.8", "54.0", "81.0", "23.7", "82.5"],
	],
	[
		"gpt-6-1-terra-non-reasoning",
		"GPT-6.1 Terra (non-reasoning)",
		["33.5", "36.4", "39.3", "51.0", "26.8", "47.8", "21.1", "23.2", "4.9", "44.0", "28.2", "67.7", "3.8", "76.0"],
	],
];

test("GPT-6.1 Terra AA rows keep six configurations, their published values and unknown cells", async () => {
	const evals = await readText("packages/coding-agent/docs/models/evals.md");
	const aa = sectionTable(evals, "## Artificial Analysis Intelligence Index v4.3.2");
	const terraRows = aa.rows.filter((row) => /^gpt-6-1-terra(?:-|$)/u.test(row[0]!));
	assert.deepEqual(
		terraRows.map((row) => row[0]),
		TERRA_AA_ROWS.map(([slug]) => slug),
		"each Terra configuration appears exactly once",
	);
	const scoreColumns = aa.header.slice(3);
	for (const [slug, model, values] of TERRA_AA_ROWS) {
		const row = terraRows.find((candidate) => candidate[0] === slug)!;
		assert.deepEqual(row.slice(1, 3), [model, "2026-10-26"], slug);
		const expected = scoreColumns.map((column) => {
			const index = TERRA_AA_PUBLISHED_COLUMNS.indexOf(column);
			return index < 0 ? "∅" : values[index]!;
		});
		assert.deepEqual(row.slice(3), expected, `${slug} keeps published values and leaves the rest unknown`);
		assert.ok(evals.includes(`(https://artificialanalysis.ai/models/${slug})`), `${slug} cites its model page`);
	}

	const evidence = catalogEvidence(parseEvalsCatalog(evals), ["openai/gpt-6.1-terra"]);
	for (const [slug] of TERRA_AA_ROWS) {
		const line = evals.split("\n").find((candidate) => candidate.startsWith(`| ${slug} | GPT-6.1 Terra (`))!;
		assert.ok(evidence.includes(line), `routing evidence carries ${slug} verbatim, unknown cells as ∅`);
	}
});

test("GPT-6.1 Terra published results keep score, qualifier and source", async () => {
	const evals = await readText("packages/coding-agent/docs/models/evals.md");
	const terra = sectionTable(evals, "## Published benchmark results").rows.filter((row) =>
		row[0]!.startsWith("gpt-6-1-terra"),
	);
	assert.deepEqual(terra, [
		[
			"gpt-6-1-terra",
			"GPT-6.1 Terra",
			"TB4",
			"50.3",
			"max effort; v4.0; OpenAI-reported, harness not stated",
			"OpenAI",
		],
		[
			"gpt-6-1-terra",
			"GPT-6.1 Terra",
			"XBench",
			"97.1",
			"ACE-normalized mean capability score; max tested solution length; effort not stated",
			"OpenAI",
		],
		[
			"gpt-6-1-terra",
			"GPT-6.1 Terra",
			"SECPro",
			"83.3",
			"pass@1; max tested solution length; effort not stated",
			"OpenAI",
		],
		[
			"gpt-6-1-terra",
			"GPT-6.1 Terra",
			"TBSci",
			"57.6",
			"max effort; AA general settings above",
			"Artificial Analysis",
		],
		[
			"gpt-6-1-terra-xhigh",
			"GPT-6.1 Terra",
			"TBSci",
			"41.9",
			"xhigh effort; AA general settings above",
			"Artificial Analysis",
		],
		[
			"gpt-6-1-terra-high",
			"GPT-6.1 Terra",
			"TBSci",
			"33.3",
			"high effort; AA general settings above",
			"Artificial Analysis",
		],
		[
			"gpt-6-1-terra-medium",
			"GPT-6.1 Terra",
			"TBSci",
			"24.8",
			"medium effort; AA general settings above",
			"Artificial Analysis",
		],
		[
			"gpt-6-1-terra-low",
			"GPT-6.1 Terra",
			"TBSci",
			"7.6",
			"low effort; AA general settings above",
			"Artificial Analysis",
		],
		[
			"gpt-6-1-terra-non-reasoning",
			"GPT-6.1 Terra",
			"TBSci",
			"24.3",
			"non-reasoning; AA general settings above",
			"Artificial Analysis",
		],
	]);
	const sources = evals.split("\n").find((line) => line.startsWith("- GPT-6.1 Terra, accessed 2026-10-26:"));
	assert.ok(sources, "Terra published results name their sources and access date");
	assert.match(
		sources,
		/OpenAI = \[launch announcement\]\(https:\/\/openai\.com\/index\/introducing-gpt-6-1-terra\/\)/u,
	);
	assert.match(sources, /\[system card addendum\]\(https:\/\/deploymentsafety\.openai\.com\/gpt-6-1-terra\)/u);
	assert.match(sources, /vendor-reported/u);
	assert.match(evals, /\[evaluation page\]\(https:\/\/artificialanalysis\.ai\/evaluations\/terminal-bench-science\)/u);
});
