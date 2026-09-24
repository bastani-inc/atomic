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

test("the factual evals document keeps the top Intelligence Index rows that fit Jev", async () => {
	const evals = await readText("packages/coding-agent/docs/models/evals.md");
	assert.match(evals, /Artificial Analysis Intelligence Index v4\.3\.2/);
	assert.doesNotMatch(evals, /frontier[ -]?code|cognition\.com|^\| F\d{2} /im);
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
		.slice(evals.indexOf("| --- |"))
		.split("\n")
		.filter((line) => line.startsWith("| ") && !line.startsWith("| ---"));
	assert.equal(aaRows.length, 27);
	const aaHeaderCells = evals.match(/^\| slug \|.*$/m)![0].split("|").length;
	for (const row of aaRows) assert.equal(row.split("|").length, aaHeaderCells, row);
	assert.doesNotMatch(evals, /no suffix=`?max|slug model names are exact source labels/i);
	const scoreColumns = evals
		.match(/^\| slug \|.*$/m)![0]
		.split("|")
		.slice(3, -1)
		.map((cell) => cell.trim());
	for (const column of scoreColumns) {
		const description = evals.split("\n").find((line) => line.startsWith(`- \`${column}\`:`));
		assert.ok(description && /, \S.+/.test(description), `${column} must describe what it measures`);
	}
	assert.match(evals, /Openness Index.*not task-solving ability/);
	assert.match(evals, /`∅`=source null\/absent, not zero/);
	assert.doesNotMatch(evals, /recommend|prefer|should choose|best for/i);
});
