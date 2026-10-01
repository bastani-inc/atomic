# Sessions

Atomic saves conversations as sessions so you can continue work, branch from earlier turns, and revisit previous paths.

## On this page

This page covers working with sessions: storage, commands, resuming, naming, and branching. Branch summarization behavior is documented with the rest of context management in [Compaction](/compaction#branch-summarization).

## Session Storage

Sessions auto-save to `~/.atomic/agent/sessions/`, organized by working directory. Each session is a JSONL file with a tree structure.

The session picker also scans linked project directories inside this default store, so project aliases or relocated session folders remain discoverable through `/resume` and `atomic -r`.

```bash
atomic -c                  # Continue most recent session
atomic -r                  # Browse and select from past sessions
atomic --no-session        # Ephemeral mode; do not save
atomic --name "my task"    # Set session display name at startup
atomic --session <path|id> # Use a file, exact ID, or unique 8-hex UUID prefix
atomic --fork <path|id>    # Fork a file, exact ID, or unique 8-hex UUID prefix
```

Use `/session` in interactive mode to see the current session file, session ID, message count, tokens, and cost. You can use it while a run is active; its totals update after each completed message, not each streaming text chunk. Detailed cost and cache-waste breakdowns are shown after the run finishes.

For UUID-backed sessions, `--session` and `--fork` accept either the full UUID or exactly eight hexadecimal prefix characters. A prefix must be unique within the current project (or, if no local session matches, across the global session store); collisions list the matching UUIDs and require the full value. Exact custom session IDs keep their existing priority. `--session-id` remains an exact project-local ID used to open or create a session, not a prefix selector.

### Custom session directories

Use `--session-dir <dir>`, `ATOMIC_CODING_AGENT_SESSION_DIR`, or the matching settings override to save the active chat outside `~/.atomic/agent/sessions/`.

Workflows launched from a non-default session directory also save their stage transcripts there. A headless command such as `atomic --mode json --session-dir <dir> -p '/workflow <name> ...'` therefore captures the main and stage transcripts together. An explicit per-stage `sessionDir` overrides the inherited directory.

When the host uses the default session store, stages keep the previous behavior: they write to the global store unless a stage explicitly sets `sessionDir`.

For the JSONL file format and SessionManager API, see [Session Format](/session-format).

## Session Commands

| Command | Description |
|---------|-------------|
| `/resume` | Browse and select previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set the current session display name |
| `/session` | Show session info |
| `/tree` | Navigate the current session tree |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact` | Compact transcript lines verbatim while preserving exactly the configured number of newest context-visible messages; see [Compaction](/compaction) |
| `/export [file]` | Export session to HTML |
| `/share` | Upload as private GitHub gist with shareable HTML link |

## Resuming and Deleting Sessions

`/resume` opens an interactive session picker for the current project. `atomic -r` opens the same picker at startup.

Resuming restores saved verbatim compaction without another planning request. Older sessions with retired logical-deletion compaction can bring previously hidden content back into context.

In the picker you can:

- search by typing
- toggle path display with CTRL+P
- toggle sort mode with CTRL+S
- filter to named sessions with CTRL+N
- rename with CTRL+R
- delete with CTRL+D, then confirm

When available, Atomic uses the `trash` CLI for deletion instead of permanently removing files.

### Session summaries

Each row shows a short generated description of what the session was about in its own column, beside the session name or first message, so you can recognize a conversation without opening it. Atomic writes one after the agent goes idle, using the model the session is already configured with, and stores it in the session file as a `session_summary` entry.

A summary describes the conversation up to a specific message. Once a newer message arrives it is considered stale and the summary column shows "No summary available." instead — the same placeholder you get when a summary has not been generated yet, could not be generated, or is still in flight. The session name and first message are never displaced by a summary, and the column only appears once at least one listed session has a summary. Summaries are also searchable along with the rest of the session text.

Generation is best-effort and never blocks a turn. Atomic skips very short sessions, workflow stage sessions, and `--print` and JSON modes. It cancels generation when you send the next message or quit; failures are silent. Set `sessionSummary.enabled` to `false` to disable it.

You can search, navigate, or cancel while the picker loads sessions. Closing it cancels the scan.

### Internal (workflow) sessions

Sessions created by workflow stage execution are marked as **internal** and are excluded from the standard `/resume`, `atomic -r`, and `--continue` history by default. This keeps the resume picker focused on your interactive coding sessions. Workflow stage sessions remain fully discoverable and resumable through the workflow-specific path: use `/workflow resume <runId>` (or the workflow tool's resume/status actions) to inspect and continue a workflow run and its stages. A workflow stage session can still be opened directly by passing its file path to `--session`.

Legacy workflow sessions created before this behavior lack the internal marker and will continue to appear in the standard history until they age out or are deleted.

## Naming Sessions

Use `/name <name>` to set a human-readable session name:

```text
/name Refactor auth module
```

Set the name at startup with `--name` or `-n`:

```bash
atomic --name "Refactor auth module"
atomic --name "CI audit" -p "Review this build failure"
```

Named sessions are easier to find in `/resume` and `atomic -r`.

## Branching with `/tree`

Sessions are stored as trees. Every entry has an `id` and `parentId`, and the current position is the active leaf. `/tree` lets you jump to any previous point and continue from there without creating a new file.

<p align="center"><img src="images/tree-view.png" alt="Tree View" width="600" /></p>

Example shape:

```text
├─ user: "Hello, can you help..."
│  └─ assistant: "Of course! I can..."
│     ├─ user: "Let's try approach A..."
│     │  └─ assistant: "For approach A..."
│     │     └─ user: "That worked..."  ← active
│     └─ user: "Actually, approach B..."
│        └─ assistant: "For approach B..."
```

### Tree Controls

| Key | Action |
|-----|--------|
| ↑/↓ | Navigate visible entries |
| ←/→ | Page up/down |
| CTRL+←/CTRL+→ or ALT+←/ALT+→ | Fold/unfold or jump between branch segments |
| SHIFT+L | Set or clear a label on the selected entry |
| SHIFT+T | Toggle label timestamps |
| Enter | Select entry |
| Escape/CTRL+C | Cancel |
| CTRL+O | Cycle filter mode |

Filter modes are: default, no-tools, user-only, labeled-only, and all. Configure the default with `treeFilterMode` in [Settings](/settings).

### Selection Behavior

Selecting a user or custom message:

1. Moves the leaf to the selected message's parent.
2. Places the selected message text in the editor.
3. Lets you edit and resubmit, creating a new branch.

Selecting an assistant, tool, compaction, or other non-user entry:

1. Moves the leaf to that entry.
2. Leaves the editor empty.
3. Lets you continue from that point.

Selecting the root user message resets the leaf to an empty conversation and places the original prompt in the editor.

## `/tree`, `/fork`, and `/clone`

| Feature | `/tree` | `/fork` | `/clone` |
|---------|---------|---------|----------|
| Output | Same session file | New session file | New session file |
| View | Full tree | User-message selector | Current active branch |
| Typical use | Explore alternatives in place | Start a new session from an earlier prompt | Duplicate current work before continuing |
| Summary | Optional branch summary | None | None |

Use `/tree` when you want to keep alternatives together. Use `/fork` or `/clone` when you want a separate session file.

## Branch Summaries

Branch summaries are compact records of what happened on a session branch. When `/tree` switches away from one branch to another, Atomic can optionally summarize the abandoned branch. The prompt lets you choose no summary, the default summary prompt, or custom focus instructions; when `branchSummary.skipPrompt` is enabled, Atomic skips the prompt and defaults to no summary.

Moved to [Compaction & Branch Summarization](/compaction#branch-summaries).

## Session Format

Session files are JSONL and contain message entries, model changes, thinking-level changes, context-window changes, labels, active verbatim `compaction` boundaries, branch summaries, and extension entries. Retired `context_compaction` and non-verbatim `compaction` records remain parseable but inert.

For parsers, extensions, SDK usage, and the full SessionManager API, see [Session Format](/session-format).
