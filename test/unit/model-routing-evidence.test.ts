import assert from "node:assert/strict";
import { test } from "vitest";
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
	assert.match(evals, /^Last Accessed: 2026-09-25\.$/mu);
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
		/^\| gpt-6-luna \| GPT-6 Luna \(max\) \| 2026-09-22 \| 37\.3 \| 40 \| 43\.4 \| 53\.2 \| 12\.6 \|/mu,
	);
	const lines = evals.split("\n");
	const aaStart = lines.findIndex((line) => line.startsWith("| slug |")) + 2;
	const aaEnd = lines.findIndex((line, index) => index >= aaStart && !line.startsWith("| "));
	const aaRows = lines.slice(aaStart, aaEnd < 0 ? undefined : aaEnd);
	assert.equal(aaRows.length, Number(/all (\d+) models on the Artificial Analysis leaderboard/u.exec(evals)?.[1]));
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
	assert.equal(frontierCode.rows.length, 40);
	assert.deepEqual(frontierCode.rows.find((row) => row[0] === "gpt-6-astra")?.slice(2, 6), [
		"max",
		"53.3",
		"58.8",
		"64.5",
	]);
	assert.match(evals, /\[FrontierCode leaderboard\]\(https:\/\/cognition\.com\/frontiercode\)/u);

	const published = sectionTable(evals, "## Published benchmark results");
	const sources = new Set(["OpenAI", "Anthropic", "Google", "ARC Prize", "TB-Science leaderboard", "Zapier"]);
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
});
