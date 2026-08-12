import assert from "node:assert/strict";

export function assertReviewerIntercomCoordination(prompt: string, reviewerName: string): void {
	const matches = [
		/<reviewer_coordination>/,
		/At review start, use Intercom to discover sibling reviewers/,
		/share validation plans and check ownership/,
		/Claim, serialize, announce, and release expensive or conflicting shared-checkout\/environment work/,
		/suites, builds, package operations, browser\/E2E sessions, migrations, and generated-artifact steps/,
		/share reusable command evidence/,
		/inspect independently and return your own verdict/,
		/form a preliminary assessment before reading or relying on sibling findings or verdicts/,
		/exactly one bounded evidence-exchange round over Intercom/,
		/share your preliminary verdict, concise findings, and evidence/,
		/challenge blocking findings, surface defects a sibling missed, and correct objective\/acceptance-criteria misreadings/,
		/Verdicts change only through concrete evidence, never through deference/,
		/overall_explanation.*whether deliberation changed your preliminary verdict/,
		/which concrete evidence caused the change/,
	] as const;

	for (const pattern of matches) {
		assert.match(prompt, pattern, reviewerName);
	}
}
