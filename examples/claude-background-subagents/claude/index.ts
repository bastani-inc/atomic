/**
 * Two-stage Claude workflow that exercises the in-flight subagent gating.
 *
 * Stage 1 ("dispatch") asks Claude to spawn three independent **background**
 * subagents via the `Agent` tool with `run_in_background: true`. Each
 * subagent waits a few seconds and writes a marker file under
 * `/tmp/atomic-bg-<n>.txt`, then returns. Claude is told NOT to wait for
 * them — its main turn ends right after dispatching.
 *
 * Stage 2 ("verify") reads the three marker files and confirms they all
 * exist with non-empty content. If the harness advanced to stage 2 before
 * the backgrounded subagents finished, the marker files would be missing
 * and the assertion fails.
 *
 * Without the in-flight gating, this example surfaces the bug
 * deterministically: stage 2 starts before the subagents finish and either
 * (a) reads missing files, or (b) intermittently hits
 * `tmux respawn-pane: fork failed: Device not configured` due to FD pressure
 * on the atomic tmux server. With the gating, stage 1's Stop hook holds
 * until all three SubagentStop events fire and the in-flight marker dir
 * empties; only then does stage 2 spawn.
 */

import { defineWorkflow } from "@bastani/atomic/workflows";

const MARKER_DIR = "/tmp";
const MARKER_PREFIX = "atomic-bg-";
const MARKER_PATHS = [1, 2, 3].map((n) => `${MARKER_DIR}/${MARKER_PREFIX}${n}.txt`);

export default defineWorkflow({
  name: "claude-background-subagents",
  source: import.meta.path,
  description:
    "Stage 1 spawns 3 background subagents and ends its turn immediately; stage 2 verifies they all finished before it started.",
  inputs: [],
})
  .for("claude")
  .run(async (ctx) => {
    // Stage 1: dispatch three background subagents and return immediately.
    //
    // The prompt is deliberately prescriptive — it names the tool, gives
    // each subagent a deterministic 20 s sleep that is long enough to make
    // the gating window unambiguous (if stage 2 starts mid-sleep, the
    // marker files won't exist yet), and tells Claude to end its turn the
    // moment all three are dispatched. The 20 s sleep is the test: if the
    // executor advances to stage 2 in less than 20 s after stage 1 ends
    // its turn, the gate is broken.
    const dispatch = await ctx.stage(
      {
        name: "dispatch",
        description: "Spawn three background subagents that each sleep 20s and write a marker file",
      },
      {},
      {},
      async (s) => {
        // Wipe stale markers from prior runs so the verify step's check is
        // unambiguous. A bare Bash call is fine — it's not what we're
        // exercising in this stage.
        await s.session.query(
          [
            "Step 1: clean any stale marker files from a previous run.",
            `  Run: rm -f ${MARKER_PATHS.join(" ")}`,
            "",
            "Step 2: spawn three independent subagents using the Agent tool with run_in_background: true.",
            "  Each subagent must:",
            "    1. Run `sleep 20` via the Bash tool.",
            `    2. Write a single line containing its own agent identifier into one of:`,
            ...MARKER_PATHS.map((p, i) => `       - subagent #${i + 1} → ${p}`),
            "    3. Return.",
            "",
            "Step 3: end your turn IMMEDIATELY after dispatching all three subagents.",
            "  - Do NOT wait for them.",
            "  - Do NOT poll or summarize their progress.",
            "  - Do NOT call any further tools after the three Agent dispatches.",
            "  - Your final assistant message in this turn should be a single short sentence acknowledging the three were dispatched, then stop.",
            "",
            "Use the Agent tool literally — three separate Agent tool calls in this same turn, each with run_in_background: true.",
          ].join("\n"),
        );
        s.save(s.sessionId);
      },
    );

    // Stage 2: assert all three marker files exist with content.
    //
    // The Stop-hook gate in stage 1 should hold until SubagentStop fires for
    // all three subagents, so by the time this stage spawns, all three
    // marker files are on disk. The prompt asks Claude to read them and
    // report any missing/empty file.
    //
    // We don't need stage 1's transcript here — the assertion is on
    // filesystem state, not on what Claude said in stage 1. Suppress the
    // unused-handle warning by referencing it in a no-op type-position.
    void dispatch;
    await ctx.stage(
      {
        name: "verify",
        description: "Confirm all three subagent marker files exist and are non-empty",
      },
      {},
      {},
      async (s) => {
        await s.session.query(
          [
            "The previous stage spawned three background subagents. Each was instructed to write a marker file under /tmp.",
            "",
            "Read each of the following files in turn using your Read tool:",
            ...MARKER_PATHS.map((p) => `  - ${p}`),
            "",
            "For each file, report:",
            "  - whether it exists",
            "  - the line of content it contains (the subagent's agent id)",
            "",
            "If any file is missing or empty, that means the harness advanced to this stage before the previous stage's background subagents finished — call this out explicitly as a FAILURE. Otherwise report SUCCESS with the three agent ids.",
          ].join("\n"),
        );
        s.save(s.sessionId);
      },
    );
  })
  .compile();
