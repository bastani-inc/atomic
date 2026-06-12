import { describe, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
    currentBranchName,
    extractJsonArray,
    findMissingOrEmptyUpdateArtifacts,
    mergeStaleDocTasksByOwnerDocs,
    nextDocsValidationPhase,
    releaseDocsUpdateTaskKey,
    requireNonBaseBranch,
    requireResearchDocPath,
    verifyReleaseDocsPr,
    type StaleDocTask,
    type UpdateArtifactStatus,
} from "../../.atomic/workflows/lib/release-docs.js";

const task = (id: string, ownerDocs: string[]): StaleDocTask => ({
    id,
    title: `Task ${id}`,
    owner_docs: ownerDocs,
    reason: `Reason ${id}`,
    source_refs: [`src/${id}.ts`],
    update_instructions: `Update ${id}`,
    acceptance_criteria: [`Criteria ${id}`],
});

const runGit = (cwd: string, args: string[]): void => {
    execFileSync("git", args, { cwd, stdio: "ignore" });
};

describe("release-docs workflow guards", () => {
    test("refuses to resolve a current branch from detached HEAD", () => {
        const repo = mkdtempSync(join(tmpdir(), "release-docs-detached-"));
        try {
            runGit(repo, ["init", "--quiet"]);
            writeFileSync(join(repo, "README.md"), "# test\n");
            runGit(repo, ["add", "README.md"]);
            runGit(repo, [
                "-c",
                "user.name=Atomic Test",
                "-c",
                "user.email=atomic-test@example.com",
                "-c",
                "core.hooksPath=/dev/null",
                "commit",
                "--no-gpg-sign",
                "--message",
                "initial",
                "--quiet",
            ]);
            runGit(repo, ["checkout", "--detach", "HEAD", "--quiet"]);

            assert.throws(
                () => currentBranchName(repo),
                /release-docs must run from a local branch, but HEAD is detached/,
            );
        } finally {
            rmSync(repo, { recursive: true, force: true });
        }
    });

    test("allows release-docs from a non-base branch", () => {
        assert.equal(requireNonBaseBranch("feature/docs", "main"), "feature/docs");
    });

    test("refuses to run release-docs on the base branch", () => {
        assert.throws(
            () => requireNonBaseBranch("main", "main"),
            /refuses to run directly on the PR base branch 'main'/,
        );
    });

    test("trims and validates branch names for the base branch guard", () => {
        assert.equal(requireNonBaseBranch(" feature/docs ", " main "), "feature/docs");
        assert.throws(() => requireNonBaseBranch("   ", "main"), /non-empty current branch/);
        assert.throws(() => requireNonBaseBranch("feature/docs", "   "), /non-empty PR base branch/);
    });

    test("requires deep research to return a concrete research artifact path", () => {
        assert.equal(requireResearchDocPath("research/report.md"), "research/report.md");
        assert.throws(
            () => requireResearchDocPath(undefined),
            /did not return research_doc_path/,
        );
        assert.throws(
            () => requireResearchDocPath("   "),
            /did not return research_doc_path/,
        );
    });

    test("reports malformed stale-doc detector JSON with a descriptive error", () => {
        assert.throws(
            () => extractJsonArray("not valid json"),
            /stale-doc detector returned invalid JSON/,
        );
    });
});

describe("release-docs update artifact validation", () => {
    test("detects missing update artifacts", () => {
        const artifacts: UpdateArtifactStatus[] = [
            { path: "a.md", exists: true, empty: false },
            { path: "b.md", exists: false, empty: true },
        ];

        assert.deepEqual(findMissingOrEmptyUpdateArtifacts(artifacts), [
            { path: "b.md", exists: false, empty: true },
        ]);
    });

    test("detects empty update artifacts", () => {
        const artifacts: UpdateArtifactStatus[] = [
            { path: "a.md", exists: true, empty: true },
            { path: "b.md", exists: true, empty: false },
        ];

        assert.deepEqual(findMissingOrEmptyUpdateArtifacts(artifacts), [
            { path: "a.md", exists: true, empty: true },
        ]);
    });

    test("accepts present non-empty update artifacts", () => {
        assert.deepEqual(
            findMissingOrEmptyUpdateArtifacts([{ path: "a.md", exists: true, empty: false }]),
            [],
        );
    });
});

describe("release-docs PR verification", () => {
    test("verifies a matching open PR returned by gh", () => {
        const result = verifyReleaseDocsPr("feature/docs", "main", "/repo", () => ({
            command: "gh pr list --head feature/docs --base main",
            ok: true,
            output: JSON.stringify({
                url: "https://github.com/acme/repo/pull/1",
                headRefName: "feature/docs",
                baseRefName: "main",
                state: "OPEN",
            }),
        }));

        assert.equal(result.ok, true);
        assert.equal(result.url, "https://github.com/acme/repo/pull/1");
    });

    test("rejects a gh PR result with the wrong base branch", () => {
        const result = verifyReleaseDocsPr("feature/docs", "main", "/repo", () => ({
            command: "gh pr list --head feature/docs --base main",
            ok: true,
            output: JSON.stringify({
                url: "https://github.com/acme/repo/pull/1",
                headRefName: "feature/docs",
                baseRefName: "develop",
                state: "OPEN",
            }),
        }));

        assert.equal(result.ok, false);
        assert.match(result.summary, /did not return an open PR matching/);
    });

    test("reports gh command failure during PR verification", () => {
        const result = verifyReleaseDocsPr("feature/docs", "main", "/repo", () => ({
            command: "gh pr list --head feature/docs --base main",
            ok: false,
            output: "not found",
        }));

        assert.equal(result.ok, false);
        assert.match(result.summary, /Unable to verify release docs PR with gh/);
    });
});

describe("release-docs validation flow", () => {
    test("skips model repair when initial deterministic validation passes", () => {
        assert.equal(nextDocsValidationPhase(true), "skip_repair");
    });

    test("repairs and revalidates when initial deterministic validation fails", () => {
        assert.equal(nextDocsValidationPhase(false), "repair_then_revalidate");
    });
});

describe("release-docs stale-doc task merging", () => {
    test("merges tasks that share owner docs before fan-out", () => {
        const merged = mergeStaleDocTasksByOwnerDocs([
            task("cli-flags", ["packages/coding-agent/docs/cli.mdx"]),
            task("workflows", ["packages/coding-agent/docs/workflows.mdx"]),
            task("cli-examples", ["./packages/coding-agent/docs/cli.mdx"]),
        ]);

        assert.equal(merged.length, 2);
        assert.deepEqual(merged[0]?.owner_docs, ["packages/coding-agent/docs/cli.mdx"]);
        assert.match(merged[0]?.update_instructions ?? "", /cli-flags/);
        assert.match(merged[0]?.update_instructions ?? "", /cli-examples/);
        assert.deepEqual(merged[1]?.owner_docs, ["packages/coding-agent/docs/workflows.mdx"]);
    });

    test("merges transitive owner-doc overlaps into one component", () => {
        const merged = mergeStaleDocTasksByOwnerDocs([
            task("a", ["packages/coding-agent/docs/a.mdx"]),
            task("b", ["packages/coding-agent/docs/a.mdx", "packages/coding-agent/docs/b.mdx"]),
            task("c", ["packages/coding-agent/docs/b.mdx"]),
            task("d", ["packages/coding-agent/docs/d.mdx"]),
        ]);

        assert.equal(merged.length, 2);
        assert.deepEqual(merged[0]?.owner_docs, [
            "packages/coding-agent/docs/a.mdx",
            "packages/coding-agent/docs/b.mdx",
        ]);
        assert.match(merged[0]?.id ?? "", /^merged-/);
        assert.deepEqual(merged[1]?.owner_docs, ["packages/coding-agent/docs/d.mdx"]);
    });

    test("deduplicates owner docs on standalone tasks", () => {
        const [deduped] = mergeStaleDocTasksByOwnerDocs([
            task("a", ["packages/coding-agent/docs/a.mdx", "./packages/coding-agent/docs/a.mdx"]),
        ]);

        assert.deepEqual(deduped?.owner_docs, ["packages/coding-agent/docs/a.mdx"]);
    });

    test("builds unique update task keys even when model ids repeat", () => {
        const tasks = [
            task("same-id", ["packages/coding-agent/docs/a.mdx"]),
            task("same-id", ["packages/coding-agent/docs/b.mdx"]),
        ];

        assert.deepEqual(tasks.map(releaseDocsUpdateTaskKey), ["001-same-id", "002-same-id"]);
    });
});
