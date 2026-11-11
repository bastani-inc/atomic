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
		/^Last Accessed: 2026-11-11 \(Gemini 4 Carbon additions and the Gemini 4 Argon recheck listed below; earlier rows retain their snapshot dates below\)\.$/mu,
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
		/^\| claude-sonnet-5-5 \| Claude Sonnet 5\.5 \(Adaptive Reasoning, Max Effort, Default Fallback\) \| 2026-09-28 \| 56 \| 65\.5 \| 67\.2 \| 71\.8 \| 63\.6 \|/mu,
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
		/^Table: the (\d+) models on the Artificial Analysis leaderboard as of 2026-09-25, including models with no published scores, plus (\d+) Claude Sonnet 5\.5 rows accessed 2026-09-28, (\d+) GPT-6\.1 Sol rows accessed 2026-09-29, (\d+) Claude Haiku 5\.5 rows accessed 2026-10-07, (\d+) GPT-6\.1 Terra rows accessed 2026-10-26, (\d+) Gemini 4 Argon row accessed 2026-11-02, (\d+) Claude Fable 5\.2 rows accessed 2026-11-09, (\d+) Gemini 4 Carbon rows accessed 2026-11-11, and (\d+) rows for 14 other new model families accessed 2026-11-09\.$/mu.exec(
			evals,
		);
	assert.ok(caption, "the caption dates the leaderboard and later model additions separately");
	assert.equal(
		aaRows.length,
		Number(caption[1]) +
			Number(caption[2]) +
			Number(caption[3]) +
			Number(caption[4]) +
			Number(caption[5]) +
			Number(caption[6]) +
			Number(caption[7]) +
			Number(caption[8]) +
			Number(caption[9]),
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
	assert.equal(frontierCode.rows.length, 44);
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

const FABLE_5_2_AA_PUBLISHED_COLUMNS = ["Brief", "Gn", "Auto", "TB4", "Sci", "HLE", "PDF", "Crit", "LCR"] as const;
const FABLE_5_2_AA_ROWS: ReadonlyArray<readonly [slug: string, model: string, values: readonly string[]]> = [
	[
		"claude-fable-5-2",
		"Claude Fable 5.2 (Max, Default Fallback)",
		["64.3", "66.5", "76.4", "59.6", "67.7", "74.3", "24.2", "35.4", "83.3"],
	],
	[
		"claude-fable-5-2-xhigh",
		"Claude Fable 5.2 (Xhigh, Default Fallback)",
		["61.9", "62.5", "74.2", "61.6", "65.6", "68.9", "21.4", "35.7", "82.7"],
	],
	[
		"claude-fable-5-2-high",
		"Claude Fable 5.2 (High, Default Fallback)",
		["58.9", "60.9", "71.4", "59.6", "59.5", "66.2", "21.8", "32.9", "83.3"],
	],
	[
		"claude-fable-5-2-medium",
		"Claude Fable 5.2 (Medium, Default Fallback)",
		["56.1", "54.6", "68.8", "55.1", "59.7", "61.9", "23.8", "30.9", "80"],
	],
	[
		"claude-fable-5-2-low",
		"Claude Fable 5.2 (Low, Default Fallback)",
		["53.1", "52.3", "68", "54.5", "57.8", "59.7", "26.8", "29.4", "80"],
	],
];

test("Claude Fable 5.2 AA rows keep five configurations, their published values and unknown cells", async () => {
	const evals = await readText("packages/coding-agent/docs/models/evals.md");
	const aa = sectionTable(evals, "## Artificial Analysis Intelligence Index v4.3.2");
	const fableRows = aa.rows.filter((row) => /^claude-fable-5-2(?:-|$)/u.test(row[0]!));
	assert.deepEqual(
		fableRows.map((row) => row[0]),
		FABLE_5_2_AA_ROWS.map(([slug]) => slug),
		"each Fable 5.2 configuration appears exactly once",
	);
	const scoreColumns = aa.header.slice(3);
	for (const [slug, model, values] of FABLE_5_2_AA_ROWS) {
		const row = fableRows.find((candidate) => candidate[0] === slug)!;
		assert.deepEqual(row.slice(1, 3), [model, "2026-11-09"], slug);
		const expected = scoreColumns.map((column) => {
			const index = FABLE_5_2_AA_PUBLISHED_COLUMNS.indexOf(
				column as (typeof FABLE_5_2_AA_PUBLISHED_COLUMNS)[number],
			);
			return index < 0 ? "∅" : values[index]!;
		});
		assert.deepEqual(
			row.slice(3),
			expected,
			`${slug} keeps published values and leaves revised-version columns unknown`,
		);
		assert.ok(evals.includes(`(https://artificialanalysis.ai/models/${slug})`), `${slug} cites its model page`);
	}
});

test("Claude Fable 5.2 published results keep score, qualifier and source", async () => {
	const evals = await readText("packages/coding-agent/docs/models/evals.md");
	const published = sectionTable(evals, "## Published benchmark results");
	const fable = published.rows
		.filter((row) => row[0]!.startsWith("claude-fable-5-2"))
		.map((row) => [row[0], row[2], row[3], row[5]]);
	assert.deepEqual(fable, [
		["claude-fable-5-2", "DSWE", "74.3", "Anthropic"],
		["claude-fable-5-2", "FSWE", "69.9", "Anthropic"],
		["claude-fable-5-2", "TB4", "67.6", "Anthropic"],
		["claude-fable-5-2", "TBSci", "74.6", "Anthropic"],
		["claude-fable-5-2", "HLE", "73.2", "Anthropic"],
		["claude-fable-5-2", "HLEt", "74.2", "Anthropic"],
		["claude-fable-5-2", "GDPElo", "1831", "Anthropic"],
		["claude-fable-5-2", "BriefElo", "1785", "Anthropic"],
		["claude-fable-5-2", "OSW21", "89.3", "Anthropic"],
		["claude-fable-5-2", "ABench", "51.4", "Anthropic"],
		["claude-fable-5-2", "Chart", "73.4", "Anthropic"],
		["claude-fable-5-2", "ARC3", "65.66", "Anthropic"],
		["claude-fable-5-2", "ARC3", "94.90", "Anthropic"],
		["claude-fable-5-2-high", "ARC3", "79.26", "Anthropic"],
		["claude-fable-5-2-high", "ARC3", "97.72", "Anthropic"],
		["claude-fable-5-2", "TBSci", "73.3", "Artificial Analysis"],
		["claude-fable-5-2-xhigh", "TBSci", "67.6", "Artificial Analysis"],
		["claude-fable-5-2-high", "TBSci", "70.0", "Artificial Analysis"],
		["claude-fable-5-2-medium", "TBSci", "60.5", "Artificial Analysis"],
		["claude-fable-5-2-low", "TBSci", "53.8", "Artificial Analysis"],
	]);
	const sources = evals.split("\n").find((line) => line.startsWith("- Claude Fable 5.2, accessed 2026-11-09:"));
	assert.ok(sources, "Fable 5.2 published results name their sources and access date");
	assert.match(sources, /\[launch announcement\]\(https:\/\/www\.anthropic\.com\/claude-fable-and-mythos-5-2\)/u);
	assert.match(
		sources,
		/\[system card\]\(https:\/\/www\.anthropic\.com\/document\/claude-fable-5-2-mythos-5-2-system-card\)/u,
	);
	assert.match(sources, /vendor-reported/u);
});

const GEMINI_4_CARBON_AA_ROWS: ReadonlyArray<
	readonly [slug: string, model: string, values: Readonly<Record<string, string>>]
> = [
	[
		"gemini-4-carbon",
		"Gemini 4 Carbon (high)",
		{ Brief: "55.5", Gn: "61.6", Auto: "77.8", TB4: "65.2", PDF: "28.4", LCR: "79.3" },
	],
	[
		"gemini-4-carbon-medium",
		"Gemini 4 Carbon (medium)",
		{ Brief: "55.1", Auto: "77.6", TB4: "60.6", PDF: "29.6", MMMU: "89.2" },
	],
	["gemini-4-carbon-low", "Gemini 4 Carbon (low)", { Brief: "53.4", Auto: "63.5", TB4: "62.6", PDF: "28.6" }],
];

test("Gemini 4 Carbon AA rows keep three configurations, their published values and unknown cells", async () => {
	const evals = await readText("packages/coding-agent/docs/models/evals.md");
	const aa = sectionTable(evals, "## Artificial Analysis Intelligence Index v4.3.2");
	const carbonRows = aa.rows.filter((row) => /^gemini-4-carbon(?:-|$)/u.test(row[0]!));
	assert.deepEqual(
		carbonRows.map((row) => row[0]),
		GEMINI_4_CARBON_AA_ROWS.map(([slug]) => slug),
		"each Gemini 4 Carbon configuration appears exactly once",
	);
	const scoreColumns = aa.header.slice(3);
	for (const [slug, model, values] of GEMINI_4_CARBON_AA_ROWS) {
		const row = carbonRows.find((candidate) => candidate[0] === slug)!;
		assert.deepEqual(row.slice(1, 3), [model, "2026-10-28"], slug);
		assert.deepEqual(
			row.slice(3),
			scoreColumns.map((column) => values[column] ?? "∅"),
			`${slug} keeps published values and leaves unpublished and revised-version columns unknown`,
		);
		assert.ok(evals.includes(`(https://artificialanalysis.ai/models/${slug})`), `${slug} cites its model page`);
	}
});

test("Gemini 4 Argon keeps its single AA row and records the 2026-11-11 recheck", async () => {
	const evals = await readText("packages/coding-agent/docs/models/evals.md");
	const aa = sectionTable(evals, "## Artificial Analysis Intelligence Index v4.3.2");
	const argonRows = aa.rows.filter((row) => /^gemini-4-argon(?:-|$)/u.test(row[0]!));
	assert.deepEqual(
		argonRows.map((row) => row[0]),
		["gemini-4-argon"],
	);
	const published: Readonly<Record<string, string>> = {
		Brief: "49.2",
		Gn: "56.5",
		Auto: "77.5",
		TB4: "57.1",
		Sci: "61.8",
		HLE: "57.1",
		PDF: "21.8",
		Crit: "27.1",
		LCR: "79.7",
		Analyst: "48.8",
	};
	assert.deepEqual(
		argonRows[0]!.slice(3),
		aa.header.slice(3).map((column) => published[column] ?? "∅"),
	);
	assert.match(evals, /^- Gemini 4 Argon: .*Rechecked 2026-11-11 against the model page and leaderboard/mu);
});

test("Gemini 4 Carbon published results keep score, qualifier and source", async () => {
	const evals = await readText("packages/coding-agent/docs/models/evals.md");
	const published = sectionTable(evals, "## Published benchmark results");
	const carbon = published.rows
		.filter((row) => row[0]!.startsWith("gemini-4-carbon"))
		.map((row) => [row[0], row[2], row[3], row[5]]);
	assert.deepEqual(carbon, [
		["gemini-4-carbon", "FSWE", "61.2", "Google"],
		["gemini-4-carbon", "TB4", "65.2", "Google"],
		["gemini-4-carbon", "TBSci", "64.8", "Google"],
		["gemini-4-carbon", "VALS", "70.4", "Google"],
		["gemini-4-carbon", "ALE", "77.4", "Google"],
		["gemini-4-carbon", "OSW21", "81.5", "Google"],
		["gemini-4-carbon", "Chart", "72.5", "Google"],
		["gemini-4-carbon", "GW1M", "96.2", "Google"],
		["gemini-4-carbon", "RBench", "80.0", "Google"],
		["gemini-4-carbon", "CWE", "71.0", "Google"],
		["gemini-4-carbon", "XGym", "54.8", "Google"],
		["gemini-4-carbon", "SECPro", "88.2", "Google"],
		["gemini-4-carbon", "TBSci", "64.8", "Artificial Analysis"],
		["gemini-4-carbon-medium", "TBSci", "62.4", "Artificial Analysis"],
		["gemini-4-carbon-low", "TBSci", "61.9", "Artificial Analysis"],
		["gemini-4-carbon", "ABench", "53.9", "Zapier"],
		["gemini-4-carbon-medium", "ABench", "53.0", "Zapier"],
		["gemini-4-carbon-low", "ABench", "31.5", "Zapier"],
		["gemini-4-carbon", "ARC1", "97.5", "ARC Prize"],
		["gemini-4-carbon", "ARC2", "92.1", "ARC Prize"],
		["gemini-4-carbon", "ARC3", "96.9", "ARC Prize"],
		["gemini-4-carbon-medium", "ARC1", "98.5", "ARC Prize"],
		["gemini-4-carbon-medium", "ARC2", "94.2", "ARC Prize"],
		["gemini-4-carbon-medium", "ARC3", "63.9", "ARC Prize"],
		["gemini-4-carbon-medium", "ARC3", "99.1", "ARC Prize"],
		["gemini-4-carbon-low", "ARC1", "85.5", "ARC Prize"],
		["gemini-4-carbon-low", "ARC2", "49.6", "ARC Prize"],
		["gemini-4-carbon-low", "ARC3", "65.1", "ARC Prize"],
		["gemini-4-carbon-low", "ARC3", "97.7", "ARC Prize"],
	]);
	const sources = evals.split("\n").find((line) => line.startsWith("- Gemini 4 Carbon, accessed 2026-11-11:"));
	assert.ok(sources, "Gemini 4 Carbon published results name their sources and access date");
	assert.match(sources, /\[model card\]\(https:\/\/deepmind\.google\/models\/model-cards\/gemini-4-carbon\/\)/u);
	assert.match(sources, /\[methodology\]\(https:\/\/deepmind\.google\/models\/evals-methodology\/gemini-4-carbon\)/u);
	assert.match(sources, /\[AutomationBench\]\(https:\/\/zapier\.com\/benchmarks\)/u);
	assert.match(
		sources,
		/\[Gemini 4 Carbon report page\]\(https:\/\/zapier\.com\/benchmarks\/gemini-carbon-4-report\)/u,
	);
	assert.match(
		sources,
		/\[Gemini 4 Carbon results page\]\(https:\/\/arcprize\.org\/results\/google-gemini-4-carbon\)/u,
	);
	assert.match(sources, /vendor-reported/u);
});

test("Gemini 4 Argon published results add the newer Google-reported versions and ARC Prize results", async () => {
	const evals = await readText("packages/coding-agent/docs/models/evals.md");
	const published = sectionTable(evals, "## Published benchmark results");
	const added = published.rows
		.filter(
			(row) =>
				row[0]!.startsWith("gemini-4-argon") &&
				(row[5] === "ARC Prize" || /Gemini 4 Carbon model card/u.test(row[4]!)),
		)
		.map((row) => [row[0], row[2], row[3], row[5]]);
	assert.deepEqual(added, [
		["gemini-4-argon", "VALS", "69.2", "Google"],
		["gemini-4-argon", "ALE", "69.0", "Google"],
		["gemini-4-argon", "OSW21", "74.7", "Google"],
		["gemini-4-argon", "XGym", "42.0", "Google"],
		["gemini-4-argon", "SECPro", "83.4", "Google"],
		["gemini-4-argon", "ARC1", "98.5", "ARC Prize"],
		["gemini-4-argon", "ARC2", "91.3", "ARC Prize"],
		["gemini-4-argon", "ARC3", "97.3", "ARC Prize"],
		["gemini-4-argon-medium", "ARC1", "98.5", "ARC Prize"],
		["gemini-4-argon-medium", "ARC2", "87.1", "ARC Prize"],
		["gemini-4-argon-medium", "ARC3", "46.3", "ARC Prize"],
		["gemini-4-argon-medium", "ARC3", "97.3", "ARC Prize"],
		["gemini-4-argon-low", "ARC1", "76.5", "ARC Prize"],
		["gemini-4-argon-low", "ARC2", "42.1", "ARC Prize"],
		["gemini-4-argon-low", "ARC3", "49.8", "ARC Prize"],
		["gemini-4-argon-low", "ARC3", "97.5", "ARC Prize"],
	]);
	const sources = evals.split("\n").find((line) => line.startsWith("- Gemini 4 Argon, accessed 2026-11-02:"));
	assert.ok(sources);
	assert.match(sources, /Rechecked 2026-11-11/u);
	assert.match(sources, /\[Gemini 4 Argon results page\]\(https:\/\/arcprize\.org\/results\/google-gemini-4-argon\)/u);
});

const OTHER_NEW_FAMILY_AA_ROWS: readonly string[] = [
	"| kimi-k3-1-pro | Kimi K3.1 Pro | 2026-10-23 | ∅ | 58.7 | 67.9 | 73.3 | 67.2 | 60.8 | 52.5 | 31.4 | 24.6 | ∅ | ∅ | 86.3 | ∅ | ∅ | ∅ | ∅ | ∅ | 83.9 | ∅ | ∅ | 38.8 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | 33.3 | ∅ |",
	"| muse-wonder | Muse Wonder (max) | 2026-10-12 | ∅ | 57.9 | 63.5 | 68.1 | 52 | 60.3 | 50.1 | 30.6 | 28.3 | ∅ | ∅ | 80.7 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |",
	"| muse-wonder-high | Muse Wonder (high) | 2026-10-12 | ∅ | 55.5 | ∅ | 67.2 | 38.4 | ∅ | ∅ | 29.2 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | 83.8 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |",
	"| muse-ember | Muse Ember (max) | 2026-11-09 | ∅ | 51.1 | ∅ | 68.1 | 40.9 | ∅ | ∅ | 22.8 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |",
	"| muse-ember-xhigh | Muse Ember (xhigh) | 2026-11-09 | ∅ | 51.3 | ∅ | 66.7 | 35.4 | ∅ | ∅ | 22.4 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |",
	"| muse-spark-open | Muse Spark Open (xhigh) | 2026-10-15 | ∅ | 38.9 | 45.1 | 49.7 | 8.1 | 58.4 | 43.9 | 18.6 | 14.9 | ∅ | ∅ | 78.3 | ∅ | 89 | 76.4 | ∅ | ∅ | 80.9 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | 27.8 | ∅ |",
	"| minimax-m3-1-flash | MiniMax-M3.1-Flash | 2026-10-19 | ∅ | 48.8 | 48.3 | 72.5 | 25.8 | 53.4 | 48 | 20.8 | 22.3 | ∅ | ∅ | 79.7 | ∅ | ∅ | ∅ | ∅ | ∅ | 79.1 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | 27.8 | ∅ |",
	"| mimo-v2-6-flash | MiMo-V2.6-Flash | 2026-09-21 | ∅ | 49.3 | 55.7 | 64.1 | 22.7 | 51.3 | 35.1 | 9 | 12 | ∅ | ∅ | 74.3 | ∅ | ∅ | ∅ | ∅ | ∅ | 73.1 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | 52.8 | ∅ |",
	"| ling-3-1-flash-1019 | Ling 3.1 Flash 1019 | 2026-10-22 | ∅ | 51.1 | 57.6 | 67.5 | 32.8 | 56.8 | 43.5 | 12.6 | 26 | ∅ | ∅ | 82.3 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | 38.9 | ∅ |",
	"| ling-3-1-flash | Ling 3.1 Flash | 2026-10-01 | ∅ | 44.8 | 56.3 | 61.7 | 33.3 | 54.1 | 39.4 | 10 | 18 | ∅ | ∅ | 83 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | 38.9 | ∅ |",
	"| inkling-2-small | Inkling 2 Small | 2026-11-05 | ∅ | 51.3 | 56.5 | 45.6 | 13.1 | 52.3 | 44.1 | 25.2 | ∅ | ∅ | ∅ | 83.3 | ∅ | ∅ | 81.3 | ∅ | ∅ | 81.6 | ∅ | 40.4 | 51.3 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | 46.8 |",
	"| mistral-large-4 | Mistral Large 4 (high) | 2026-10-29 | ∅ | 42.4 | ∅ | 57.8 | 24.7 | ∅ | ∅ | 17.6 | 10 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | 38.9 | ∅ |",
	"| mistral-large-4-medium | Mistral Large 4 (medium) | 2026-10-29 | ∅ | 34.4 | ∅ | 52.8 | 23.2 | ∅ | ∅ | 16.8 | 11.1 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | 38.9 | ∅ |",
	"| tencent-hy4 | Tencent Hy4 | 2026-11-03 | ∅ | 47.3 | ∅ | 65.6 | 37.4 | ∅ | ∅ | 21.6 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |",
	"| reflection-beam | Beam 1.0 | 2026-10-16 | ∅ | 23.8 | 33.9 | 48.5 | 3 | 48.5 | 34.7 | 11.6 | 13.1 | ∅ | ∅ | 78 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | 38.9 | ∅ |",
	"| nemotron-3-5-super-vl | Nemotron 3.5 Super VL | 2026-10-15 | ∅ | 24.9 | 33.1 | 14.8 | 0 | 47.8 | 30.7 | 8 | 10.6 | ∅ | ∅ | 69 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | 83.3 | ∅ |",
	"| solar-mini4 | Solar Mini 4 | 2026-09-22 | ∅ | 18.4 | 29.6 | 22.3 | 1 | 47.6 | 25.8 | 5 | 1.4 | ∅ | ∅ | 83.3 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |",
	"| deepseek-v4-1-flash-1017 | DeepSeek V4.1 Flash 1017 (max) | 2026-10-17 | ∅ | 53.5 | 62.3 | 66.6 | 33.8 | 55.9 | 43.3 | 17.2 | 24 | ∅ | ∅ | 82.7 | ∅ | ∅ | ∅ | ∅ | ∅ | 80.6 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | 44.4 | ∅ |",
	"| deepseek-v4-1-flash-1017-high | DeepSeek V4.1 Flash 1017 (high) | 2026-10-17 | ∅ | 45.8 | ∅ | 68.5 | 28.8 | ∅ | ∅ | 14.2 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | 79.7 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | 44.4 | ∅ |",
	"| deepseek-v4-1-flash-1017-non-reasoning | DeepSeek V4.1 Flash 1017 (non-reasoning) | 2026-10-17 | ∅ | 46.3 | ∅ | 48.8 | 9.1 | 38.5 | 11.5 | 4.4 | 0.3 | ∅ | ∅ | 57.3 | ∅ | ∅ | ∅ | ∅ | ∅ | 69.2 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | 44.4 | ∅ |",
];

test("other new-family AA rows keep published values and leave revised-version columns unknown", async () => {
	const evals = await readText("packages/coding-agent/docs/models/evals.md");
	const aa = sectionTable(evals, "## Artificial Analysis Intelligence Index v4.3.2");
	const revisedVersionColumns = ["idx", "OA", "ONH", "Omni", "Harvey", "MLCR"];
	const revisedIndexes = revisedVersionColumns.map((column) => aa.header.indexOf(column));
	for (const line of OTHER_NEW_FAMILY_AA_ROWS) {
		assert.ok(evals.split("\n").includes(line), `${line.split("|")[1]!.trim()} row is present verbatim`);
		const cells = line
			.split("|")
			.slice(1, -1)
			.map((cell) => cell.trim());
		assert.equal(cells.length, aa.header.length, `${cells[0]} has one cell per column`);
		for (const index of revisedIndexes) assert.equal(cells[index], "∅", `${cells[0]} ${aa.header[index]}`);
		assert.equal(cells[2]?.match(/^\d{4}-\d{2}-\d{2}$/u)?.length, 1, `${cells[0]} carries its release date`);
	}
	assert.equal(OTHER_NEW_FAMILY_AA_ROWS.length, 20);
	assert.match(
		evals,
		/^- Other new model families, 20 rows accessed 2026-11-09 from the \[leaderboard\]\(https:\/\/artificialanalysis\.ai\/leaderboards\/models\) and one model page per row at `https:\/\/artificialanalysis\.ai\/models\/<slug>`/mu,
	);
});

test("refreshed AA cells carry the 2026-11-09 model-page values and name the refresh", async () => {
	const evals = await readText("packages/coding-agent/docs/models/evals.md");
	const aa = sectionTable(evals, "## Artificial Analysis Intelligence Index v4.3.2");
	const cell = (slug: string, column: string) => aa.rows.find((row) => row[0] === slug)![aa.header.indexOf(column)];
	const refreshed: ReadonlyArray<readonly [slug: string, column: string, value: string]> = [
		["claude-sonnet-5-5", "Auto", "71.8"],
		["claude-sonnet-5-5-xhigh", "Auto", "65.5"],
		["claude-sonnet-5-5-high", "Auto", "59.4"],
		["claude-sonnet-5-5-medium", "Auto", "54.9"],
		["claude-sonnet-5-5-low", "Auto", "49.4"],
		["gpt-6-luna", "PDF", "22.8"],
		["gpt-6-luna", "MMMU", "79.7"],
		["gpt-6-luna-xhigh", "MMMU", "79.7"],
		["gpt-6-luna-high", "MMMU", "77.5"],
		["gpt-6-luna-medium", "MMMU", "77.9"],
		["gpt-6-luna-low", "MMMU", "76"],
		["gpt-6-luna-non-reasoning", "MMMU", "62.1"],
		["qwen3-8-27b", "PDF", "16.4"],
		["solar-pro4", "Auto", "13.6"],
		["solar-pro4", "TB4", "0"],
		["solar-pro4", "Sci", "48"],
		["solar-pro4", "HLE", "29.8"],
		["solar-pro4", "Crit", "6.3"],
		["solar-pro4", "LCR", "70.7"],
		["claude-sonnet-5-5", "Analyst", "57.5"],
		["claude-sonnet-5-5-high", "PDF", "25.2"],
		["claude-sonnet-5-5-medium", "PDF", "20.2"],
		["claude-sonnet-5-5-low", "PDF", "16"],
		["gpt-6-luna", "Analyst", "43.8"],
		["gpt-6-luna-xhigh", "PDF", "18.6"],
		["gpt-6-luna-high", "PDF", "18.2"],
		["gpt-6-luna-medium", "PDF", "13.8"],
		["gpt-6-luna-low", "PDF", "9"],
		["gpt-6-luna-non-reasoning", "PDF", "5.8"],
		["solar-pro4", "PDF", "7"],
	];
	for (const [slug, column, value] of refreshed) assert.equal(cell(slug, column), value, `${slug} ${column}`);
	assert.match(evals, /^- Refreshed values, accessed 2026-11-09 from the \[leaderboard\]/mu);
});
