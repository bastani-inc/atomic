import assert from "node:assert/strict";

export function assertReviewerIntercomCoordination(
    prompt: string,
    reviewerName: string,
): void {
    const matches = [
        /<reviewer_coordination>/,
        /At review start, use Intercom to initialize\/check coordination and discover sibling reviewers participating in the same workflow run/,
        /validation plan and intended check ownership before running checks/,
        /Claim ownership before starting any expensive, lock-prone, or potentially conflicting command/,
        /Coordinate and serialize conflicting shared-checkout or shared-environment commands/,
        /full test suites, Cargo builds or tests, package-manager operations, browser or E2E sessions, migrations, and generated-artifact steps/,
        /Announce each coordinated check when it starts and finishes, release every claimed resource when finished, and share reusable command outcomes and evidence/,
        /independently inspect the patch, perform your own analysis, and produce your own verdict/,
    ] as const;

    for (const pattern of matches) {
        assert.match(prompt, pattern, reviewerName);
    }
}
