import { describe, test } from "bun:test";
import type {
    AgentSessionAdapter,
    InternalStageContext,
    StageSessionCreateOptions,
} from "./stage-runner-helpers.js";
import {
    assert,
    createStageContext,
    join,
    makeMockSession,
    makeOpts,
    mkdtemp,
    rm,
    tmpdir,
    writeFile,
} from "./stage-runner-helpers.js";

describe("createStageContext — inherited session directories", () => {
    test("uses defaultSessionDir when a stage has no explicit sessionDir", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pi-workflows-host-session-dir-"));
        try {
            let createOptions: StageSessionCreateOptions | undefined;
            const agentSession: AgentSessionAdapter = {
                async create(options) {
                    createOptions = options;
                    return makeMockSession().session;
                },
            };
            const ctx = createStageContext(
                makeOpts({
                    adapters: { agentSession },
                    defaultSessionDir: dir,
                    stageOptions: { cwd: dir },
                }),
            ) as InternalStageContext;

            await ctx.__ensureSession();

            assert.equal(createOptions?.sessionManager?.getSessionDir(), dir);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("keeps an explicit per-stage sessionDir ahead of defaultSessionDir", async () => {
        const hostDir = await mkdtemp(join(tmpdir(), "pi-workflows-host-session-dir-"));
        const stageDir = await mkdtemp(join(tmpdir(), "pi-workflows-stage-session-dir-"));
        try {
            let createOptions: StageSessionCreateOptions | undefined;
            const agentSession: AgentSessionAdapter = {
                async create(options) {
                    createOptions = options;
                    return makeMockSession().session;
                },
            };
            const ctx = createStageContext(
                makeOpts({
                    adapters: { agentSession },
                    defaultSessionDir: hostDir,
                    stageOptions: { cwd: hostDir, sessionDir: stageDir },
                }),
            ) as InternalStageContext;

            await ctx.__ensureSession();

            assert.equal(createOptions?.sessionManager?.getSessionDir(), stageDir);
        } finally {
            await rm(hostDir, { recursive: true, force: true });
            await rm(stageDir, { recursive: true, force: true });
        }
    });

    test("does not force a sessionManager when defaultSessionDir is absent", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pi-workflows-default-session-dir-"));
        try {
            let createOptions: StageSessionCreateOptions | undefined;
            const agentSession: AgentSessionAdapter = {
                async create(options) {
                    createOptions = options;
                    return makeMockSession().session;
                },
            };
            const ctx = createStageContext(
                makeOpts({
                    adapters: { agentSession },
                    stageOptions: { cwd: dir },
                }),
            ) as InternalStageContext;

            await ctx.__ensureSession();

            assert.equal(createOptions?.sessionManager, undefined);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("uses defaultSessionDir for forked stages without explicit sessionDir", async () => {
        const hostDir = await mkdtemp(join(tmpdir(), "pi-workflows-host-session-dir-"));
        const sourceDir = await mkdtemp(join(tmpdir(), "pi-workflows-source-session-dir-"));
        try {
            const sourceSessionFile = join(sourceDir, "source.jsonl");
            await writeFile(
                sourceSessionFile,
                `${JSON.stringify({
                    type: "session",
                    version: 3,
                    id: "source-session",
                    timestamp: new Date().toISOString(),
                    cwd: sourceDir,
                })}\n`,
                "utf8",
            );
            let createOptions: StageSessionCreateOptions | undefined;
            const agentSession: AgentSessionAdapter = {
                async create(options) {
                    createOptions = options;
                    return makeMockSession().session;
                },
            };
            const ctx = createStageContext(
                makeOpts({
                    adapters: { agentSession },
                    defaultSessionDir: hostDir,
                    stageOptions: {
                        cwd: sourceDir,
                        context: "fork",
                        forkFromSessionFile: sourceSessionFile,
                    },
                }),
            ) as InternalStageContext;

            await ctx.__ensureSession();

            assert.equal(createOptions?.sessionManager?.getSessionDir(), hostDir);
        } finally {
            await rm(hostDir, { recursive: true, force: true });
            await rm(sourceDir, { recursive: true, force: true });
        }
    });
});

