import { describe, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
import { createGitEnvironment } from "@bastani/atomic";

const task = (id: string, ownerDocs: string[]): StaleDocTask => ({
    id,
    title: `Task ${id}`,
    owner_docs: ownerDocs,
    reason: `Reason ${id}`,
    source_refs: [`src/${id}.ts`],
    update_instructions: `Update ${id}`,
    acceptance_criteria: [`Criteria ${id}`],
});

// Always sanitize the Git environment for fixture repos: under a hook runner
// (e.g. prek) Git exports GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE, which Git
// honors over cwd — an unsanitized `git init` would then re-initialize the
// real repository and persist core.worktree into its shared .git/config
// (see git-env.ts and the regression test below).
const runGit = (cwd: string, args: string[]): void => {
    execFileSync("git", args, { cwd, stdio: "ignore", env: createGitEnvironment() });
};

const commitAll = (repo: string, message: string): void => {
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
        message,
        "--quiet",
    ]);
};

describe("release-docs workflow guards", () => {
    test("refuses to resolve a current branch from detached HEAD", () => {
        const repo = mkdtempSync(join(tmpdir(), "release-docs-detached-"));
        try {
            runGit(repo, ["init", "--quiet"]);
            writeFileSync(join(repo, "README.md"), "# test\n");
            runGit(repo, ["add", "README.md"]);
            commitAll(repo, "initial");
            runGit(repo, ["checkout", "--detach", "HEAD", "--quiet"]);

            assert.throws(
                () => currentBranchName(repo),
                /release-docs must run from a local branch, but HEAD is detached/,
            );
        } finally {
            rmSync(repo, { recursive: true, force: true });
        }
    });

    test("resolves branch state from the target repo despite ambient Git hook environment", () => {
        const repo = mkdtempSync(join(tmpdir(), "release-docs-target-"));
        const ambientRepo = mkdtempSync(join(tmpdir(), "release-docs-ambient-"));
        const scriptPath = join(tmpdir(), `release-docs-current-branch-${process.pid}-${Date.now()}.ts`);
        try {
            // Target repo sits on a branch.
            runGit(repo, ["init", "--quiet"]);
            runGit(repo, ["checkout", "-b", "feature/docs", "--quiet"]);
            writeFileSync(join(repo, "README.md"), "# target\n");
            runGit(repo, ["add", "README.md"]);
            commitAll(repo, "initial");

            // Decoy repo is detached; a hook runner (e.g. prek) exports
            // repository-local Git env vars pointing at the invoking repo.
            runGit(ambientRepo, ["init", "--quiet"]);
            writeFileSync(join(ambientRepo, "README.md"), "# ambient\n");
            runGit(ambientRepo, ["add", "README.md"]);
            commitAll(ambientRepo, "initial");
            runGit(ambientRepo, ["checkout", "--detach", "HEAD", "--quiet"]);

            const moduleUrl = pathToFileURL(join(process.cwd(), ".atomic/workflows/lib/release-docs.ts")).href;
            writeFileSync(
                scriptPath,
                [
                    `import { currentBranchName } from ${JSON.stringify(moduleUrl)};`,
                    `console.log(currentBranchName(${JSON.stringify(repo)}));`,
                ].join("\n"),
            );

            // The ambient Git env must be present at child-process startup to
            // match hook runners. The repo mandates Bun, so process.execPath is
            // intentionally the Bun runtime for this child TypeScript script.
            // Without release-docs' sanitizer, nested Git commands would read
            // the detached decoy repo instead of `repo`.
            const output = execFileSync(process.execPath, [scriptPath], {
                encoding: "utf8",
                env: {
                    ...process.env,
                    GIT_DIR: join(ambientRepo, ".git"),
                    GIT_WORK_TREE: ambientRepo,
                    GIT_INDEX_FILE: join(ambientRepo, ".git", "index"),
                },
                stdio: ["ignore", "pipe", "pipe"],
            }).trim();

            assert.equal(output, "feature/docs");
        } finally {
            rmSync(scriptPath, { force: true });
            rmSync(repo, { recursive: true, force: true });
            rmSync(ambientRepo, { recursive: true, force: true });
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
