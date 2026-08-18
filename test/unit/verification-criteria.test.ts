import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	type Criterion,
	type CriterionScore,
	decide_verification,
	EmptyCriterion,
	type Finding,
	NoCriteria,
	normalize_criteria,
	parse_rubric,
	select_criteria,
	VERIFICATION_SCALE,
} from "../../packages/workflows/builtin/verification-criteria.js";

function score(overrides: Partial<CriterionScore> = {}): CriterionScore {
	return {
		criterionId: "c",
		score: 14,
		evidence: ["observed"],
		findings: [],
		...overrides,
	};
}

function finding(severity: Finding["severity"], text = `${severity} finding`): Finding {
	return { finding: text, severity };
}

describe("verification-criteria", () => {
	describe("parse_rubric", () => {
		test("parses section layout, ignores # title, and keeps the first ground-truth note", () => {
			const parsed = parse_rubric(`# Title ignored

## Ground Truth Note

Trust the logs.

## Ground Truth Note

This second note must not win.

## Other

### Not A Criterion

outside the Criteria section

## Criteria

### Correct {#c}

Is it correct?

### Completeness

Does it cover every requirement?
`);
			assert.equal(parsed.groundTruthNote, "Trust the logs.");
			assert.deepEqual(
				parsed.criteria.map((item) => ({ id: item.id, name: item.name, description: item.description })),
				[
					{ id: "c", name: "Correct", description: "Is it correct?" },
					{
						id: "completeness",
						name: "Completeness",
						description: "Does it cover every requirement?",
					},
				],
			);
		});

		test("accepts a ## Criterion heading (reference 'criteri' match) and CRLF line endings", () => {
			const parsed = parse_rubric("## Criterion\r\n### Correct {#c}\r\nIs it correct?\r\n");
			assert.equal(parsed.criteria.length, 1);
			assert.equal(parsed.criteria[0]?.id, "c");
			assert.equal(parsed.criteria[0]?.description, "Is it correct?");
			assert.equal(parsed.groundTruthNote, "");
		});

		const slugCases: ReadonlyArray<{
			readonly name: string;
			readonly heading: string;
			readonly id: string;
			readonly display: string;
		}> = [
			{
				name: "explicit {#id} is not slugged",
				heading: "### Empirical Verification {#My-ID}",
				id: "My-ID",
				display: "Empirical Verification",
			},
			{
				name: "name is slugged when no anchor is present",
				heading: "### Final Answer Correctness",
				id: "final_answer_correctness",
				display: "Final Answer Correctness",
			},
			{
				name: "40-char truncation strips a trailing underscore",
				heading: "### This Is A Very Long Criterion Name That Exceeds Forty",
				id: "this_is_a_very_long_criterion_name_that",
				display: "This Is A Very Long Criterion Name That Exceeds Forty",
			},
			{
				name: "punctuation-only heading falls back to criterion",
				heading: "### ???",
				id: "criterion",
				display: "???",
			},
		];

		for (const example of slugCases) {
			test(example.name, () => {
				const parsed = parse_rubric(`## Criteria\n${example.heading}\nbody\n`);
				assert.equal(parsed.criteria[0]?.id, example.id);
				assert.equal(parsed.criteria[0]?.name, example.display);
			});
		}

		test("dedups duplicate ids with _2 and _3 in encounter order", () => {
			const parsed = parse_rubric(`## Criteria
### Same
one

### Same
two

### Same {#same}
three
`);
			assert.deepEqual(
				parsed.criteria.map((item) => item.id),
				["same", "same_2", "same_3"],
			);
		});

		test("strips HTML comments before parse so commented headings never become criteria", () => {
			const parsed = parse_rubric(`## Criteria
<!--
### Fake {#fake}
this is an author note
-->
### Real {#real}
<!-- inline -->visible
`);
			assert.equal(parsed.criteria.length, 1);
			assert.equal(parsed.criteria[0]?.id, "real");
			assert.equal(parsed.criteria[0]?.description, "visible");
		});

		test("rejects an empty criterion body instead of skipping it", () => {
			assert.throws(
				() =>
					parse_rubric(`## Criteria
### Empty {#e}

### Good {#g}
body
`),
				(error: unknown) => {
					assert.ok(error instanceof EmptyCriterion);
					assert.equal(error.name, "EmptyCriterion");
					assert.deepEqual(error.ids, ["e"]);
					return true;
				},
			);
		});

		const noCriteriaCases = [
			["empty document", ""],
			["title only", "# Title\n"],
			["ground-truth only", "## Ground Truth Note\nDo not trust narration.\n"],
			["headings outside Criteria", "### Orphan\nbody\n"],
		] as const;

		for (const [name, markdown] of noCriteriaCases) {
			test(`rejects ${name} with NoCriteria`, () => {
				assert.throws(() => parse_rubric(markdown), NoCriteria);
			});
		}
	});

	describe("normalize_criteria", () => {
		test("normalizes a name→description record", () => {
			assert.deepEqual(
				normalize_criteria({
					"Root cause": "Did the agent fix the real cause?",
					Verification: "Did the agent confirm the fix?",
				}),
				[
					{
						id: "root_cause",
						name: "Root cause",
						description: "Did the agent fix the real cause?",
					},
					{
						id: "verification",
						name: "Verification",
						description: "Did the agent confirm the fix?",
					},
				],
			);
		});

		test("normalizes a string[] using each string as name and description", () => {
			assert.deepEqual(normalize_criteria(["Did the agent solve the task?"]), [
				{
					id: "did_the_agent_solve_the_task",
					name: "Did the agent solve the task?",
					description: "Did the agent solve the task?",
				},
			]);
		});

		test("normalizes CriterionInput[] and slugs missing ids", () => {
			assert.deepEqual(
				normalize_criteria([
					{ id: "task_fit", name: "Task fit", description: "Does it solve the asked task?" },
					{ name: "Evidence", description: "Is every claim evidenced?" },
				]),
				[
					{ id: "task_fit", name: "Task fit", description: "Does it solve the asked task?" },
					{ id: "evidence", name: "Evidence", description: "Is every claim evidenced?" },
				],
			);
		});

		test("derives a name from id or description slug and dedups colliding ids", () => {
			assert.deepEqual(
				normalize_criteria([{ id: "fit", description: "Fits the task." }, { description: "Fits the task." }]),
				[
					{ id: "fit", name: "fit", description: "Fits the task." },
					{ id: "fits_the_task", name: "fits_the_task", description: "Fits the task." },
				],
			);
		});

		test("applies 40-char slug truncation to record keys", () => {
			const longName = "This Is A Very Long Criterion Name That Exceeds Forty";
			const [item] = normalize_criteria({ [longName]: "body" });
			assert.equal(item?.id, "this_is_a_very_long_criterion_name_that");
		});

		test("throws EmptyCriterion when a description is missing", () => {
			assert.throws(
				() => normalize_criteria([{ name: "Gap" }]),
				(error: unknown) => {
					assert.ok(error instanceof EmptyCriterion);
					assert.deepEqual(error.ids, ["Gap"]);
					return true;
				},
			);
			assert.throws(() => normalize_criteria({ Gap: "" }), EmptyCriterion);
			assert.throws(() => normalize_criteria([""]), EmptyCriterion);
		});

		test("throws NoCriteria when the collection is empty", () => {
			assert.throws(() => normalize_criteria({}), NoCriteria);
			assert.throws(() => normalize_criteria([]), NoCriteria);
		});

		test("throws TypeError for a non-string array entry", () => {
			assert.throws(() => normalize_criteria([1 as unknown as string]), TypeError);
		});
	});

	describe("select_criteria", () => {
		const pool: readonly Criterion[] = [
			{ id: "a", name: "A", description: "first" },
			{ id: "b", name: "B", description: "second" },
			{ id: "c", name: "C", description: "third" },
		];

		test("returns every criterion in file order when ids are omitted", () => {
			assert.deepEqual(select_criteria(pool), pool);
		});

		test("subsets and reorders by the given ids", () => {
			assert.deepEqual(
				select_criteria(pool, ["c", "a"]).map((item) => item.id),
				["c", "a"],
			);
		});

		test("throws on an unknown id instead of dropping it", () => {
			assert.throws(() => select_criteria(pool, ["a", "missing", "also"]), /criteria not found: missing, also/);
		});
	});

	describe("VERIFICATION_SCALE", () => {
		test("is the shared anchored 1–20 integer scale", () => {
			assert.equal(VERIFICATION_SCALE.min, 1);
			assert.equal(VERIFICATION_SCALE.max, 20);
			assert.equal(VERIFICATION_SCALE.anchors, "1 = certainly fails … 10 = borderline … 20 = verified correct");
			const schema = VERIFICATION_SCALE.schema as {
				readonly type: string;
				readonly minimum: number;
				readonly maximum: number;
			};
			assert.equal(schema.type, "integer");
			assert.equal(schema.minimum, 1);
			assert.equal(schema.maximum, 20);
		});
	});

	describe("decide_verification", () => {
		const policy = { acceptMean: 14, quorumFraction: 0.8 };

		test("accepts at the mean threshold boundary and repairs just below it", () => {
			const atThreshold = decide_verification(
				{ scores: [score({ score: 14 }), score({ score: 14 })], invalidCount: 0, expectedCount: 2 },
				policy,
			);
			assert.deepEqual(atThreshold, { kind: "accept", mean: 14 });

			const below = decide_verification(
				{ scores: [score({ score: 14 }), score({ score: 13 })], invalidCount: 0, expectedCount: 2 },
				policy,
			);
			assert.equal(below.kind, "repair");
			if (below.kind === "repair") {
				assert.equal(below.mean, 13.5);
				assert.deepEqual(below.findings, []);
			}
		});

		test("a veto finding forces Repair even when every score is 20", () => {
			const veto = finding("veto", "security hole");
			const decision = decide_verification(
				{
					scores: [score({ score: 20, findings: [veto] }), score({ score: 20, findings: [finding("note")] })],
					invalidCount: 0,
					expectedCount: 2,
				},
				policy,
			);
			assert.equal(decision.kind, "repair");
			if (decision.kind === "repair") {
				assert.equal(decision.mean, 20);
				assert.deepEqual(decision.findings, [veto, finding("note")]);
			}
		});

		test("blocking and note findings do not veto a passing mean", () => {
			const decision = decide_verification(
				{
					scores: [score({ score: 16, findings: [finding("blocking"), finding("note")] })],
					invalidCount: 0,
					expectedCount: 1,
				},
				policy,
			);
			assert.deepEqual(decision, { kind: "accept", mean: 16 });
		});

		const quorumCases: ReadonlyArray<{
			readonly name: string;
			readonly expected: number;
			readonly fraction: number;
			readonly valid: number;
			readonly kind: "accept" | "indeterminate";
		}> = [
			{ name: "holds at ceil(10 × 0.8) = 8", expected: 10, fraction: 0.8, valid: 8, kind: "accept" },
			{ name: "fails at 7 of ceil(10 × 0.8) = 8", expected: 10, fraction: 0.8, valid: 7, kind: "indeterminate" },
			{ name: "holds at ceil(5 × 0.5) = 3", expected: 5, fraction: 0.5, valid: 3, kind: "accept" },
			{ name: "fails at 2 of ceil(5 × 0.5) = 3", expected: 5, fraction: 0.5, valid: 2, kind: "indeterminate" },
		];

		for (const example of quorumCases) {
			test(`quorum ${example.name}`, () => {
				const scores = Array.from({ length: example.valid }, () => score({ score: 20 }));
				const decision = decide_verification(
					{ scores, invalidCount: example.expected - example.valid, expectedCount: example.expected },
					{ acceptMean: 14, quorumFraction: example.fraction },
				);
				assert.equal(decision.kind, example.kind);
				if (decision.kind === "indeterminate") {
					assert.equal(decision.missing, example.expected - example.valid);
				}
			});
		}

		test("invalidCount is metadata and never shifts the mean or the decision", () => {
			const scores = [score({ score: 18 }), score({ score: 16 })];
			const withNone = decide_verification({ scores, invalidCount: 0, expectedCount: 2 }, policy);
			const withMany = decide_verification({ scores, invalidCount: 99, expectedCount: 2 }, policy);
			assert.deepEqual(withNone, { kind: "accept", mean: 17 });
			assert.deepEqual(withMany, withNone);
		});
	});
});
