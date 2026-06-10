import { describe, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { mergeStaleDocTasksByOwnerDocs, type StaleDocTask } from "../../.atomic/workflow-utils/release-docs.js";
import { currentBranchName, extractJsonArray, requireResearchDocPath } from "../../.atomic/workflows/release-docs.js";

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
                "commit",
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
});
