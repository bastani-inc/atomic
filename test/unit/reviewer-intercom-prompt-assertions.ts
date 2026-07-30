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
	] as const;

	for (const pattern of matches) {
		assert.match(prompt, pattern, reviewerName);
	}
}
