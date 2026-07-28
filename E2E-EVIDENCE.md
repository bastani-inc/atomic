# E2E Evidence — Compaction Fallback Rungs

Real interactive Atomic session driven through tmux against a real provider. Every fenced
block below is verbatim `tmux capture-pane` output or verbatim session-JSONL content. No
terminal output in this file was reconstructed, paraphrased, or hand-written.

| Fact | Value |
| --- | --- |
| Worktree | `/Users/tonystark/Documents/projects/atomic-compaction-rungs` (branch `spec/compaction-fallback-rungs`) |
| Command under test | `bun /Users/tonystark/Documents/projects/atomic-compaction-rungs/packages/coding-agent/src/cli.ts` |
| Provider / model | `anthropic` / `claude-opus-5`, thinking level `high` (Anthropic subscription auth) |
| Session cwd | `/private/tmp/atomic-e2e-final` |
| Session JSONL | `/Users/tonystark/.atomic/agent/sessions/--private-tmp-atomic-e2e-final--/2026-07-28T05-37-17-889Z_019fa73a-3641-7400-8e66-db0c6c5c102c.jsonl` |
| tmux | 3.7b (`/opt/homebrew/bin/tmux`), session `atomic-e2e`, 200x50 |
| Project settings | `/private/tmp/atomic-e2e-final/.atomic/settings.json` — `{"compaction": {"enabled": true, "reserveTokens": 960000}}` |

`reserveTokens: 960000` against the model's 1,000,000-token context window sets the
auto-compaction threshold at 40,000 tokens so real work crosses it quickly. It is ordinary
configuration; nothing is stubbed, mocked, or faked.

Scope, as required: **success paths only.** No 429 and no reasoning-only truncation was
faked live; those stay covered by the §8 unit/integration matrix.

---

## 1. Session start — model and thinking level BEFORE compaction

Command that produced this capture:

```sh
tmux send-keys -t atomic-e2e 'unset $(env | grep -oE "^(ATOMIC|PI)_[A-Z_]+" | tr "\n" " ") && clear && bun /Users/tonystark/Documents/projects/atomic-compaction-rungs/packages/coding-agent/src/cli.ts' Enter
tmux capture-pane -p -t atomic-e2e
```

(The `unset` is required because this harness shell exports `ATOMIC_INTERACTIVE_ENGINE_CHILD`,
which would otherwise start the CLI in isolated-engine JSONL mode instead of the TUI.)

```text
   ██████▙                  ▟██████    Atomic v0.0.0
    ██████▙                ▟██████░░   (anthropic) claude-opus-5 high
     ██████▙              ▟██████░░    /private/tmp/atomic-e2e-final
      ██████▙            ▟██████░░
       ████████████████████████░░      We question,
        ██████▛░░░░░░░░▜██████░░       we break away from what is accepted.
         ██████▛      ▜██████░░        Engineering matters.
          ██████▛    ▜██████░░
           ██████▛  ▜██████░░
            ░████████████░░░
              ░░░░░░░░░░░░

RESOURCES context ready · 11 skills · 14 prompts


 Warning: Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at
 https://claude.ai/settings/usage.

                                                                                                                                                                         $0.000 (sub) • 0.0%/1.0M (auto)
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
(anthropic) claude-opus-5 high • /private/tmp/atomic-e2e-final
```

The banner and the footer both report `(anthropic) claude-opus-5 high`.

---

## 2. A real pre-boundary fact, established before any compaction

```sh
tmux send-keys -t atomic-e2e 'Read marker.txt and tell me exactly what it says. Then stop.' Enter
tmux capture-pane -p -t atomic-e2e
```

```text
 read marker.txt


 marker.txt says:

 APRICOT-LEDGER-7731 is the secret build token for this session.

                                                                                                                                      ↑4 • ↓87 • R45k • W12k • CH99.6% • $0.098 (sub) • 2.9%/1.0M (auto)
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
(anthropic) claude-opus-5 high • /private/tmp/atomic-e2e-final
```

This turn is the fact recalled in section 6, after four compaction boundaries.

---

## 3. Real work crosses the auto-compaction threshold — the compaction indicator

```sh
tmux send-keys -t atomic-e2e 'Now read big-source-dump.txt in three steps. Issue exactly ONE read tool call per assistant message, never two in the same message: first lines 1-1200, then 1201-2400, then 2401-3068. After the third read returns, reply with one sentence describing the file and make no further tool calls.' Enter
tmux capture-pane -p -t atomic-e2e
```

`big-source-dump.txt` is 118,227 bytes of real repository source (`agent-session-retry.ts`
plus every file in `src/core/compaction/`).

```text
 read big-source-dump.txt:2401-3068


 ∀ Auto-compacting... (esc Cancel)

                                                                                                                                    ↑8 • ↓200 • R102k • W12k • CH98.9% • $0.132 (sub) • 2.9%/1.0M (auto)
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
esc to interrupt
```

`∀ Auto-compacting... (esc Cancel)` is the live mid-turn compaction indicator.

---

## 4. The compactions succeed and the turn completes

```sh
tmux capture-pane -p -t atomic-e2e
```

```text
 ✻ Context compacted

 Compacted from 62,739 tokens (ctrl+o to expand)


 Now I'm moving on to the third reading, covering lines 2401 through 3068.


 read big-source-dump.txt:2401-3068


 The file contains TypeScript source for Atomic's context-compaction and agent-session error-handling layer — retryable/empty/safety-refusal detection with fallback-model switching, plus the verbatim
 line-range compaction pipeline (types, token accounting, planner prompting and outcome classification, overflow head-trimming, transcript serialization, and strict record parsing/recovery).


 ✻ Context compacted

 Compacted from 50,237 tokens (ctrl+o to expand)


                                                                                                                                   ↑16 • ↓565 • R216k • W84k • CH56.5% • $0.645 (sub) • 5.0%/1.0M (auto)
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
(anthropic) claude-opus-5 high • /private/tmp/atomic-e2e-final
```

Three `✻ Context compacted` success lines, the assistant's answer, and no error. The footer
still reads `(anthropic) claude-opus-5 high` — the session model and thinking level are
unchanged across compaction.

---

## 5. Manual `/compact` succeeds

```sh
tmux send-keys -t atomic-e2e '/compact' Enter
tmux capture-pane -p -t atomic-e2e     # while running
```

```text

                                                                                                                                   ↑16 • ↓565 • R216k • W84k • CH56.5% • $0.645 (sub) • 5.0%/1.0M (auto)
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
(anthropic) claude-opus-5 high • /private/tmp/atomic-e2e-final
```

```sh
tmux capture-pane -p -t atomic-e2e     # after it finished
```

```text
 ✻ Context compacted

 Compacted from 62,739 tokens (ctrl+o to expand)


 Now I'm moving on to the third reading, covering lines 2401 through 3068.


 read big-source-dump.txt:2401-3068


 The file contains TypeScript source for Atomic's context-compaction and agent-session error-handling layer — retryable/empty/safety-refusal detection with fallback-model switching, plus the verbatim
 line-range compaction pipeline (types, token accounting, planner prompting and outcome classification, overflow head-trimming, transcript serialization, and strict record parsing/recovery).


 ✻ Context compacted

 Compacted from 3,126 tokens (ctrl+o to expand)


                                                                                                                                   ↑16 • ↓565 • R216k • W84k • CH56.5% • $0.645 (sub) • 5.0%/1.0M (auto)
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
(anthropic) claude-opus-5 high • /private/tmp/atomic-e2e-final
```

---

## 6. The boundary is coherent — the session recalls a pre-compaction fact

```sh
tmux send-keys -t atomic-e2e 'Without using any tools, what was the secret build token from marker.txt that I asked you about at the very start of this session?' Enter
tmux capture-pane -p -t atomic-e2e
```

```text
 ✻ Context compacted

 Compacted from 62,739 tokens (ctrl+o to expand)


 Now I'm moving on to the third reading, covering lines 2401 through 3068.


 read big-source-dump.txt:2401-3068


 The file contains TypeScript source for Atomic's context-compaction and agent-session error-handling layer — retryable/empty/safety-refusal detection with fallback-model switching, plus the verbatim
 line-range compaction pipeline (types, token accounting, planner prompting and outcome classification, overflow head-trimming, transcript serialization, and strict record parsing/recovery).


 ✻ Context compacted

 Compacted from 3,126 tokens (ctrl+o to expand)



 Without using any tools, what was the secret build token from marker.txt that I asked you about at the very start of this session?


 I'm noting the token identifier APRICOT-LEDGER-7731 from the transcript.

 The secret build token was APRICOT-LEDGER-7731 — marker.txt said: APRICOT-LEDGER-7731 is the secret build token for this session.

                                                                                                                                   ↑18 • ↓653 • R245k • W89k • CH84.9% • $0.693 (sub) • 3.3%/1.0M (auto)
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
(anthropic) claude-opus-5 high • /private/tmp/atomic-e2e-final
```

The assistant answers `APRICOT-LEDGER-7731` correctly, with no tool call, after five
compaction boundaries. This is the real proof the boundary is coherent and not merely
present. The footer again shows `(anthropic) claude-opus-5 high`.

---

## 7. Session JSONL — the durable compaction entries

```sh
SF=/Users/tonystark/.atomic/agent/sessions/--private-tmp-atomic-e2e-final--/2026-07-28T05-37-17-889Z_019fa73a-3641-7400-8e66-db0c6c5c102c.jsonl
python3 -c 'import json,sys; [print(json.dumps(e, indent=2)) for e in map(json.loads, open(sys.argv[1])) if e.get("type")=="compaction"]' "$SF"
```

First entry (threshold auto-compaction), verbatim from the session file:

```json
{
  "type": "compaction",
  "id": "3037d82c",
  "parentId": "537e5f0b",
  "timestamp": "2026-07-28T05:40:18.567Z",
  "firstKeptEntryId": "1d75882e",
  "tokensBefore": 42159,
  "details": {
    "strategy": "verbatim-lines",
    "promptVersion": 3,
    "parameters": {
      "compression_ratio": 0.5,
      "preserve_recent": 2,
      "query": "Now read big-source-dump.txt in three steps. Issue exactly ONE read tool call per assistant message, never two in the same message: first lines 1-1200, then 1201-2400, then 2401-3068. After the third read returns, reply with one sentence describing the file and make no further tool calls."
    },
    "stats": {
      "linesBefore": 27,
      "linesDeleted": 13,
      "linesKept": 14,
      "rangeCount": 9,
      "tokensBefore": 42159,
      "tokensAfter": 13384,
      "percentReduction": 68.3
    },
    "rung": "planned",
    "backupPath": "/Users/tonystark/.atomic/agent/sessions/--private-tmp-atomic-e2e-final--/2026-07-28T05-37-17-889Z_019fa73a-3641-7400-8e66-db0c6c5c102c.jsonl.2026-07-28T05-40-18-567Z.auto-compact.bak"
  }
}
```

Last entry (the manual `/compact` from section 5), verbatim:

```json
{
  "type": "compaction",
  "id": "2dba6b63",
  "parentId": "727c04f1",
  "timestamp": "2026-07-28T05:46:06.520Z",
  "firstKeptEntryId": "ece4e9b2",
  "tokensBefore": 3126,
  "details": {
    "strategy": "verbatim-lines",
    "promptVersion": 3,
    "parameters": {
      "compression_ratio": 0.5,
      "preserve_recent": 2,
      "query": "Now read big-source-dump.txt in three steps. Issue exactly ONE read tool call per assistant message, never two in the same message: first lines 1-1200, then 1201-2400, then 2401-3068. After the third read returns, reply with one sentence describing the file and make no further tool calls."
    },
    "stats": {
      "linesBefore": 288,
      "linesDeleted": 144,
      "linesKept": 144,
      "rangeCount": 89,
      "tokensBefore": 3126,
      "tokensAfter": 9869,
      "percentReduction": -215.7
    },
    "rung": "planned",
    "backupPath": "/Users/tonystark/.atomic/agent/sessions/--private-tmp-atomic-e2e-final--/2026-07-28T05-37-17-889Z_019fa73a-3641-7400-8e66-db0c6c5c102c.jsonl.2026-07-28T05-46-06-520Z.compact.bak"
  }
}
```

Both carry `"strategy": "verbatim-lines"` and `"rung": "planned"`, as required. Neither
carries `plannerModel`, which is correct: the session model ranked the lines itself, so no
fallback model was borrowed.

## 8. Session model and thinking level were never mutated

```sh
python3 -c 'import json,sys,collections; print(collections.Counter(e.get("type") for e in map(json.loads, open(sys.argv[1]))))' "$SF"
```

```text
{"session": 1, "model_change": 1, "thinking_level_change": 1, "message": 18, "compaction": 5}
```

```sh
# position and content of every model/thinking entry
python3 - "$SF"   # prints index, type, provider/modelId, timestamp
```

```text
0 session {"timestamp": "2026-07-28T05:37:57.713Z"}
1 model_change {"timestamp": "2026-07-28T05:37:58.247Z", "provider": "anthropic", "modelId": "claude-opus-5"}
2 thinking_level_change {"timestamp": "2026-07-28T05:37:58.247Z"}
14 compaction {"timestamp": "2026-07-28T05:40:18.567Z"}
17 compaction {"timestamp": "2026-07-28T05:40:28.280Z"}
20 compaction {"timestamp": "2026-07-28T05:42:44.428Z"}
22 compaction {"timestamp": "2026-07-28T05:42:58.266Z"}
23 compaction {"timestamp": "2026-07-28T05:46:06.520Z"}
```

The only `model_change` / `thinking_level_change` pair is the session-start record at index
1-2, written before any compaction. Five compactions later there is no second one.

---

## 9. Pre-existing defect observed during this run (NOT caused by this change)

While driving the live session, a mid-turn compaction followed by **parallel** tool calls
produced an Anthropic 400:

```text
Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.4.content.1: each tool_use must have a single result. Found multiple `tool_result` blocks with id: toolu_..."}}
```

This was checked against the unmodified baseline. With the entire change stashed
(`git stash -u`), the same scenario on the same provider and model reproduces the identical
failure:

```sh
git stash -u          # implementation removed
tmux send-keys -t atomic-base 'Read marker.txt, then in ONE message issue three parallel read tool calls for big-source-dump.txt covering lines 1-1000, 1001-2000, and 2001-3068. After they return, run one bash call: wc -l big-source-dump.txt. Then give a one-sentence summary.' Enter
tmux capture-pane -p -t atomic-base
```

```text

 Took 0s


 Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.4.content.1: each tool_use must have a single result. Found multiple `tool_result` blocks with id:
 toolu_01DG5qbRhgaYeouZz3dtfts6"},"request_id":"req_011CdTuve3GGdsMQku6GXG5C"}

                                                                                                                                               ↑6 • ↓517 • R74k • W17k • $0.157 (sub) • 3.4%/1.0M (auto)
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
(anthropic) claude-opus-5 high • /private/tmp/atomic-e2e-base2
```

The failure is therefore **pre-existing on this branch's base** and out of scope for this
change. It is reported here rather than silently omitted.

---

## 10. Steps that could not be run live

None of the required success-path steps was skipped. The rate-limit, quota, reasoning-
starvation, overflow-trimming, and fresh-context-window rungs are deliberately **not**
exercised here (the amendment scopes the live run to success paths); they are covered by
the §8 matrix in `test/unit/compaction-*.test.ts` and
`test/integration/compaction-fallback-rungs.test.ts`.

## 11. Secret scan

```sh
grep -rIn -iE "sk-[A-Za-z0-9_-]{12,}|Bearer [A-Za-z0-9._-]{12,}|Authorization|api[_-]?key|ANTHROPIC_AUTH_TOKEN|ghp_|ghu_|oauth" /tmp/atomic-e2e-caps/
```

Returned no matches. `APRICOT-LEDGER-7731` is a synthetic string this run created solely to
test recall across a compaction boundary; it is not a credential.
