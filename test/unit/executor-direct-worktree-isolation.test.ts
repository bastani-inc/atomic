import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitChecked } from "../../packages/workflows/src/runs/shared/worktree-git.js";
import { createStore, mockSession, runChain, runParallel, runTask } from "./executor-shared.js";

function createRepository(): { readonly root: string; readonly repo: string; readonly worktree: string } {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-direct-worktree-cwd-")));
    const repo = join(root, "repo");
    mkdirSync(repo);
    runGitChecked(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "primary\n");
    runGitChecked(repo, ["add", "README.md"]);
    runGitChecked(repo, [
        "-c", "user.name=Atomic Test", "-c", "user.email=atomic-test@example.com",
        "commit", "--no-gpg-sign", "-m", "initial",
    ]);
    return { root, repo, worktree: join(root, "isolated") };
}

test("direct reusable worktrees remap the propagated invoking cwd before session start", async () => {
    const { root, repo, worktree } = createRepository();
    try {
        let sessionCwd: string | undefined;
        const details = await runTask(
            { name: "writer", prompt: "write only in the isolated worktree" },
            { cwd: repo, gitWorktreeDir: worktree },
            {
                cwd: repo,
                adapters: {
                    agentSession: {
                        async create(options) {
                            sessionCwd = options.cwd;
                            return mockSession();
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(details.status, "completed");
        assert.equal(realpathSync(sessionCwd ?? ""), realpathSync(worktree));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("direct reusable worktrees reject cwd values outside both repository checkouts", async () => {
    const { root, repo, worktree } = createRepository();
    const outside = join(root, "outside");
    mkdirSync(outside);
    try {
        let creates = 0;
        const details = await runTask(
            { name: "writer", prompt: "write only in the isolated worktree" },
            { cwd: outside, gitWorktreeDir: worktree },
            {
                cwd: repo,
                adapters: {
                    agentSession: {
                        async create() {
                            creates += 1;
                            return mockSession();
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(details.status, "failed");
        assert.match(details.error ?? "", /cwd .* is outside gitWorktreeDir .* use a cwd inside the invoking repository/);
        assert.equal(creates, 0);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("direct reusable worktrees preserve a cwd already inside the selected worktree", async () => {
    const { root, repo, worktree } = createRepository();
    try {
        runGitChecked(repo, ["worktree", "add", "--detach", worktree]);
        let sessionCwd: string | undefined;
        const details = await runTask(
            { name: "writer", prompt: "write only in the isolated worktree" },
            { cwd: worktree, gitWorktreeDir: worktree },
            {
                cwd: repo,
                adapters: {
                    agentSession: {
                        async create(options) {
                            sessionCwd = options.cwd;
                            return mockSession();
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(details.status, "completed");
        assert.equal(realpathSync(sessionCwd ?? ""), realpathSync(worktree));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("direct reusable worktrees reject the invoking checkout as gitWorktreeDir", async () => {
    const { root, repo } = createRepository();
    try {
        let creates = 0;
        const details = await runTask(
            { name: "writer", prompt: "write only in an isolated worktree" },
            { cwd: repo, gitWorktreeDir: repo },
            {
                cwd: repo,
                adapters: {
                    agentSession: {
                        async create() {
                            creates += 1;
                            return mockSession();
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(details.status, "failed");
        assert.match(details.error ?? "", /gitWorktreeDir must not resolve to the invoking checkout/);
        assert.equal(creates, 0);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("direct reusable worktrees reject a cwd symlink that escapes to the invoking checkout", async () => {
    const { root, repo, worktree } = createRepository();
    try {
        runGitChecked(repo, ["worktree", "add", "--detach", worktree]);
        const escapedCwd = join(worktree, "primary-link");
        symlinkSync(repo, escapedCwd, process.platform === "win32" ? "junction" : "dir");
        let creates = 0;
        const details = await runTask(
            { name: "writer", prompt: "write only in an isolated worktree" },
            { cwd: escapedCwd, gitWorktreeDir: worktree },
            {
                cwd: repo,
                adapters: {
                    agentSession: {
                        async create() {
                            creates += 1;
                            return mockSession();
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(details.status, "failed");
        assert.match(details.error ?? "", /cwd .* resolves outside gitWorktreeDir/);
        assert.equal(creates, 0);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("direct reusable worktrees persist relative outputs inside the selected worktree", async () => {
    const { root, repo, worktree } = createRepository();
    try {
        const details = await runTask(
            { name: "writer", prompt: "return output", output: "result.txt" },
            { cwd: repo, gitWorktreeDir: worktree },
            {
                cwd: repo,
                adapters: { prompt: { prompt: async () => "isolated output" } },
                store: createStore(),
            },
        );

        assert.equal(details.status, "completed");
        assert.equal(existsSync(join(repo, "result.txt")), false);
        assert.equal(readFileSync(join(worktree, "result.txt"), "utf8"), "isolated output");
        assert.equal(details.artifacts?.some((artifact) => artifact.path === join(worktree, "result.txt")), true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("parallel reusable-worktree tasks persist relative outputs inside the selected worktree", async () => {
    const { root, repo, worktree } = createRepository();
    try {
        const details = await runParallel(
            [
                { name: "first", prompt: "first", output: "first.txt" },
                { name: "second", prompt: "second", output: "second.txt" },
            ],
            { cwd: repo, gitWorktreeDir: worktree },
            {
                cwd: repo,
                adapters: { prompt: { prompt: async (text) => `output:${text}` } },
                store: createStore(),
            },
        );

        assert.equal(details.status, "completed");
        assert.equal(existsSync(join(repo, "first.txt")), false);
        assert.equal(existsSync(join(repo, "second.txt")), false);
        assert.equal(readFileSync(join(worktree, "first.txt"), "utf8"), "output:first");
        assert.equal(readFileSync(join(worktree, "second.txt"), "utf8"), "output:second");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("chain reusable-worktree steps persist relative outputs inside the selected worktree", async () => {
    const { root, repo, worktree } = createRepository();
    try {
        const details = await runChain(
            [
                { name: "first", prompt: "first", output: "first.txt" },
                { name: "second", prompt: "second", output: "second.txt" },
            ],
            { cwd: repo, gitWorktreeDir: worktree },
            {
                cwd: repo,
                adapters: { prompt: { prompt: async (text) => text.startsWith("second") ? "output:second" : "output:first" } },
                store: createStore(),
            },
        );

        assert.equal(details.status, "completed");
        assert.equal(existsSync(join(repo, "first.txt")), false);
        assert.equal(existsSync(join(repo, "second.txt")), false);
        assert.equal(readFileSync(join(worktree, "first.txt"), "utf8"), "output:first");
        assert.equal(readFileSync(join(worktree, "second.txt"), "utf8"), "output:second");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("direct reusable worktrees reject relative cwd traversal outside the selected worktree", async () => {
    const { root, repo, worktree } = createRepository();
    try {
        let creates = 0;
        const details = await runTask(
            { name: "writer", prompt: "write only in an isolated worktree" },
            { cwd: "../repo", gitWorktreeDir: worktree },
            {
                cwd: repo,
                adapters: {
                    agentSession: {
                        async create() {
                            creates += 1;
                            return mockSession();
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(details.status, "failed");
        assert.match(details.error ?? "", /relative cwd .* escapes gitWorktreeDir/);
        assert.equal(creates, 0);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("reusable worktree cache rejects target replacement before a later stage session", async () => {
    const { root, repo, worktree } = createRepository();
    try {
        let creates = 0;
        const details = await runChain(
            [
                { name: "first", prompt: "first" },
                { name: "second", prompt: "second" },
            ],
            { cwd: repo, gitWorktreeDir: worktree },
            {
                cwd: repo,
                adapters: {
                    agentSession: {
                        async create() {
                            creates += 1;
                            return {
                                ...mockSession(),
                                async prompt() {
                                    if (creates === 1) {
                                        runGitChecked(repo, ["worktree", "remove", "--force", worktree]);
                                        symlinkSync(repo, worktree, process.platform === "win32" ? "junction" : "dir");
                                    }
                                },
                                getLastAssistantText() {
                                    return "done";
                                },
                            };
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(details.status, "failed");
        assert.match(details.error ?? "", /gitWorktreeDir changed after setup|gitWorktreeDir must not resolve to the invoking checkout/);
        assert.equal(creates, 1);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("temporary direct worktrees clean up when run initialization fails before the workflow callback", async () => {
    const { root, repo } = createRepository();
    try {
        await assert.rejects(
            runTask(
                { name: "writer", prompt: "write" },
                { cwd: repo, worktree: true },
                {
                    cwd: repo,
                    store: createStore(),
                    onRunStart() {
                        throw new Error("run-start failed");
                    },
                },
            ),
            /run-start failed/,
        );

        const worktrees = runGitChecked(repo, ["worktree", "list", "--porcelain"]);
        assert.equal(worktrees.match(/^worktree /gm)?.length, 1);
        assert.equal(runGitChecked(repo, ["branch", "--list", "atomic-*"]), "");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});


for (const variant of ["base branch", "path spelling", "symlink spelling"] as const) {
    test(`reusable worktree cache rejects recreated targets after changing ${variant}`, async () => {
        const { root, repo, worktree } = createRepository();
        const alias = join(root, "worktree-alias");
        try {
            if (variant === "symlink spelling") {
                runGitChecked(repo, ["worktree", "add", "--detach", worktree]);
                symlinkSync(worktree, alias, process.platform === "win32" ? "junction" : "dir");
            }
            let creates = 0;
            const relativeWorktree = `../${worktree.split(/[\\/]/).at(-1)}`;
            const firstWorktree = variant === "symlink spelling" ? alias : worktree;
            const secondWorktree = variant === "path spelling" ? relativeWorktree : worktree;
            const details = await runChain(
                [
                    { name: "first", prompt: "first", gitWorktreeDir: firstWorktree, baseBranch: "main" },
                    {
                        name: "second",
                        prompt: "second",
                        gitWorktreeDir: secondWorktree,
                        baseBranch: variant === "base branch" ? "HEAD" : "main",
                    },
                ],
                { cwd: repo },
                {
                    cwd: repo,
                    adapters: {
                        agentSession: {
                            async create() {
                                creates += 1;
                                return {
                                    ...mockSession(),
                                    async prompt() {
                                        if (creates === 1) {
                                            runGitChecked(repo, ["worktree", "remove", "--force", worktree]);
                                            runGitChecked(repo, ["worktree", "add", "--detach", worktree]);
                                        }
                                    },
                                    getLastAssistantText() { return "done"; },
                                };
                            },
                        },
                    },
                    store: createStore(),
                },
            );

            assert.equal(details.status, "failed");
            assert.match(details.error ?? "", /Cached gitWorktreeDir changed before reuse/);
            assert.equal(creates, 1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
}
