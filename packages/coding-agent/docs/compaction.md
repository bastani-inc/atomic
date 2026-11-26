---
title: "Context and compaction"
sidebarTitle: "Compaction"
description: "Clear or compact long conversations, recover earlier details from session history, and summarize abandoned branches."
---

LLMs have finite context windows. When a session nears its limit, Atomic compacts the context window in one of two ways:

- **Context cleared (default).** No model is called. Atomic clears the context window, and the agent recovers what it needs from session history using its own tools.
- **Context compacted.** When `compactionModel` names a compactor model, Atomic sends the conversation to that compactor once and replaces the context with its output.

In both modes, the full conversation stays in session history and the boundary message tells the agent where to find it. Branch summarization is a separate, lossy summary offered when you navigate away from a branch with `/tree`. For parameters, saved boundary fields, extension hooks, SDK concurrency rules, and settings, see [Compaction reference](/compaction/reference).

## Overview

| Form | When | Model call | What the model sees after the boundary |
| --- | --- | --- | --- |
| Context cleared | `compactionModel` is `auto` or empty, or the compactor failed | None | The system prompt and one `Context cleared` message |
| Context compacted | `compactionModel` names a compactor model, or an extension supplied replacement text | One compactor request | The system prompt and one `Context compacted` message holding the compacted text |
| Branch summarization | Optional, when `/tree` leaves a branch | One summary request | A branch summary at the new branch position |

## When compaction runs

Atomic triggers compaction in five situations:

- **Automatic threshold.** Estimated context usage exceeds the model's context window minus `compaction.reserveTokens`. Atomic checks after tool results arrive, before follow-up requests, and before every new request. A completed answer that finishes over the threshold stays as the session's last answer so `prompt()`, RPC `get_last_assistant_text`, and `/copy` can read it; Atomic clears the context right before the next request. When a provider reports all-zero usage, Atomic estimates visible message size instead of skipping the check.
- **Resumed near the window.** On a Claude model with a fixed thinking budget, the first prompt after resume clears earlier conversation when newly added resume context (changed `AGENTS.md` or prompt files, blueprint context, or recovery notices) would crowd out the thinking budget. The resume additions stay in context after the boundary. When automatic compaction is off, or clearing does not run, Atomic shrinks the thinking budget to fit instead.
- **Overflow.** On a provider context-overflow error, Atomic compacts and retries the interrupted turn once per turn.
- **Truncated response.** When a response stops with `length` before the requested output cap, Atomic runs one compact-and-retry (or at most one direct continuation if nothing can be compacted). When a response hits the requested output cap, Atomic runs up to 3 direct continuations; on an output-budget error, Atomic runs at most 1 direct continuation.
- **Manual.** Run `/compact [instructions]`, call `ctx.compact()` or `session.compact()`, or send RPC `{ "type": "compact" }`.

### Safety, backups, and cancellation

A compaction boundary never lands mid-stream or between a tool call and its result. Manual compaction stops the active run before starting. While a tool call waits for its result, no boundary is written: automatic compaction clears context before the next request with the result, and `/compact` reports that a tool call is waiting.

When nothing new has entered context since the last boundary, compaction does nothing and `/compact` reports `Nothing to compact`. Automatic compaction also skips when the system prompt and boundary message together would reach or exceed the automatic trigger (`systemPrompt + boundary >= trigger`), letting [`fallbackModels`](/settings#fallbackmodels) handle any provider overflow.

**Pre-compaction backups (JSONL stores only).** Before writing a boundary in a JSONL session store, Atomic saves a best-effort backup alongside the session file at `<sessionFile>.<timestamp>.<label>.bak`. These backup files are not deleted automatically. If a backup cannot be written (for example on a full disk), Atomic still writes the boundary without `backupPath`. SQLite, PostgreSQL, and in-memory stores do not write separate backup files (see [Storage](/storage)).

**Cancellation and queuing.** Pressing `Escape` cancels compaction before the boundary commits and leaves the session unchanged. If a compactor request is already running, `Escape` stops that request and clears the context instead. Queued user messages wait in arrival order and resume automatically once compaction ends.

Automatic continuations remain part of the original prompt until the chain finishes, so status monitors such as [Herdr](/herdr) stay active across continuations. In the TUI, `/compact` takes over automatic compaction, refuses a second manual compaction or branch summary, lets non-prompt commands (`/settings`, `/tasks`) run immediately, and lets session-switching commands (`/new`) cancel compaction immediately.

For SDK compaction calls, concurrency, `abortCompaction()`, message queuing callbacks, and turn hooks during compaction, see [Compaction and tree navigation](/sdk#compaction-and-tree-navigation) and [SDK concurrency and message queuing](/compaction/reference#sdk-concurrency-and-message-queuing).

### Compaction instructions

`/compact` accepts optional focus instructions, such as `/compact keep the migration plan and the names of the failing tests`. Atomic appends those instructions to the boundary message after the recovery steps and sends them as the compactor query.

SDK and extension code pass instructions as `query` in `session.compact({ query })` or `ctx.compact({ query })`. RPC clients pass `{ "type": "compact", "instructions": "..." }`.

## Context cleared

With the default `compactionModel`, compaction makes no model call. After the boundary, the model sees the system prompt and one `Context cleared` message telling the agent:

- How many tokens the earlier conversation held, the exact `history://sessions/<session id>` URL for this session, which saved entries hold the earlier conversation, the boundary's entry position, and the total entry count.
- What to recover, in order. First, every `<keepContext>` span verbatim and whole by searching for `keepContext`. Next, the user's objectives and latest requests, constraints, decisions and their reasons, key identifiers (branches, worktrees, pull requests, run IDs, file paths, commands), open work, and needed tool results, preferring the most recent records.
- How to recover it. Search the exact session URL first (a plain `history://sessions` search skips the current session), then read narrow ranges of about 200 saved entries with `read history://sessions/<id>:N-M`. Ranges select saved entries rather than rendered lines. Follow continuation URLs when reads or searches stop early, and check any `Full output saved to: <location>` or `Full output: <location>` path (`tool-output://` or `artifact://`) when full tool output is needed.
- Your `/compact` instructions, if provided, followed by a prompt to continue the task.

The agent recovers details with `read` and `search` in its next turn. An abbreviated boundary message looks like this:

```text
Context cleared. Your earlier conversation (182,340 tokens) is no longer in your context window. It is stored verbatim in this session's history at history://sessions/019f6a2e-...: entries 1-4210 hold the earlier conversation, this boundary is entry 4211, and the history has 4211 entries now. Before you continue, recover what the task needs from there.

Recover what you need, in this order:
1. Every <keepContext> span, verbatim and whole: search history://sessions/019f6a2e-... for "keepContext". ...
2. The user's objectives and latest requests; constraints and prohibitions ...

How to recover:
- Search first ...

Then continue the task.
```

See [Recalling earlier work](/sessions#recalling-earlier-work) for how `history://` URLs read and search.

### Agents without read or search

Agents whose tool allowlist omits `read` or `search`, such as restricted subagents, receive one read-only tool named `session_history` after their first context clear (or on resume whenever `read` or `search` is absent).

- **Search the session:** pass `{"pattern": "<regex>"}` to run a **case-sensitive regular expression** search with 0 surrounding context lines.
- **Search within a range:** combine `pattern` and `lines`, such as `{"pattern": "TODO", "lines": "100-300"}`, to search only within those saved entries.
- **Read entries:** pass `{"lines": "N-M"}` to read a saved-entry range (despite the parameter name, numbers refer to saved entries). Reads silently clamp to at most **400 entries** per call, and output truncates at **50,000 characters**.
- **Continue truncated calls:** pass `{"lines": "<continuation URL>"}` to continue a read, or `{"pattern": "<same regex>", "lines": "<continuation URL>"}` to continue a search.

`session_history` cannot access any other session, file, or project, and leaves the agent's other tools unchanged.

## Context compacted

When `compactionModel` names a registered compactor model (built-in `morph/morph-compactor`, or a custom remote compactor configured in `models.json` or an extension), compaction sends the active context to that compactor once. Atomic frames previous compacted text first, followed by role-labelled user messages, assistant text, tool calls with arguments, tool results (marked when errors), shell commands with exit codes, and extension messages.

Images are replaced with an omission marker, thinking blocks are omitted, long lines wrap at 2,000 characters, and role headers are wrapped in `<keepContext>` tags automatically. Messages excluded from model context, such as `!!` shell commands and extension messages with `excludeFromContext`, are not sent.

The request uses your `/compact` instructions as its query, or your latest user request if none were given. Atomic sends `{ messages, query, model }` plus any optional `compactionParams` configured on that compactor model, letting the remote API apply its own server defaults when `compactionParams` is omitted. You can customize endpoint parameters (`compactionParams`), request path (`endpointPath`), timeout (`timeoutMs`, default 120 seconds), headers (`headers`), and an output limit (`maxTokens`, no default) per compactor model in `models.json` or an extension.

The compactor's output replaces the context inside a `<compacted-context>` block, followed by the same recovery instructions used by context clearing so the agent can retrieve omitted details from history.

A compactor's output has no built-in size limit: whatever the endpoint returns is used, however long it is. Only limits you configure apply. To ask the endpoint for shorter output, set its own size option in `compactionParams` (for Morph, `compression_ratio`). To reject long output, set `maxTokens` on the compactor model: output longer than that many estimated tokens (4 ASCII characters or 1 non-ASCII character per token) clears the context instead. `maxTokens` has no default. If the compacted context is still above the automatic trigger, nothing is rejected: before the next request, automatic compaction runs again on it as it would on any context past the trigger, and a provider's context-overflow error is recovered the same way. Compacted text returned by an extension's `session_before_compact` hook keeps its limits: text longer than 32,000 estimated tokens (or half of the automatic trigger on a small context window), or a result that would not fit below the trigger, clears the context instead. If an endpoint echoes your API key or sensitive auth header, Atomic replaces it with `[redacted]` before storing or displaying the output.

### When the compactor fails

Every compactor failure falls back automatically to **Automatic** (clearing the context instead) so a broken, unauthenticated, or slow remote compactor never blocks compaction:

```text
Compaction starts
  ├─ session_before_compact returns { cancel: true } or session closes -> Cancelled (context unchanged)
  ├─ session_before_compact returns valid { compactedText }            -> Context compacted (extension)
  │    └─ oversized or overflows trigger                               -> Automatic fallback (Context cleared)
  ├─ compactionModel is "" / "auto"                                    -> Automatic (Context cleared)
  ├─ compactionModel is unknown / chat / classifier                    -> Automatic fallback (Context cleared)
  └─ compactionModel is a registered compactor
       ├─ success (within maxTokens, if you set one)                   -> Context compacted (compactor)
       └─ missing auth / HTTP or network error / timeout / Esc /
          malformed or empty output / longer than a maxTokens you set  -> Automatic fallback (Context cleared)
```

Atomic prints a one-line notice (`Compaction model not used (<reason>); context cleared instead`) without exposing your API key or sensitive headers. Pressing `Escape` or calling `abortCompaction()` during a compactor request also clears the context with reason `request aborted`. A takeover by `/compact`, closing the session, or an extension returning `{ cancel: true }` cancels compaction completely.

#### When the compactor cannot reach its server

If Atomic cannot connect to the compactor's server, the notice gives the reason the connection failed. For example, when the server's host name cannot be found:

```text
Compaction model not used (morph/morph-compactor failed: fetch failed: getaddrinfo ENOTFOUND api.morphllm.com); context cleared instead
```

Check your network connection, proxy or VPN, and the compactor's address.

A DNS filter such as NextDNS, Pi-hole, or AdGuard can also block the compactor. These filters answer `0.0.0.0` or `::` for a domain they block, so the connection never reaches the real server. When the server's host name resolves only to those addresses, the notice says so and names the domain to allow:

```text
Compaction model not used (morph/morph-compactor failed: fetch failed: ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR: tlsv1 alert internal error (api.morphllm.com resolves to 0.0.0.0, the address DNS filters such as NextDNS, Pi-hole or AdGuard return for blocked domains; allow api.morphllm.com in the resolver)); context cleared instead
```

To fix it, add that domain to your DNS filter's allowlist. Until then, compaction keeps working by clearing the context.

## Compaction model

Open `/settings` and select **Compaction model** to choose **Automatic** or any registered compactor model. Changes made in `/settings` (or via `session.setCompactionModel()` / RPC `set_compaction_model`) take effect immediately in your active session without running `/reload` or restarting Atomic. Both built-in `morph/morph-compactor` and any custom remote compactor models you define in `~/.atomic/agent/models.json` or an extension appear in this searchable list automatically, matching the **Decision model** and `/model` pickers (authenticated models appear first; unauthenticated ones show `requires /login <provider>`). The selector updates project settings when a project override already exists, and global settings otherwise. You can also edit `compactionModel` in `~/.atomic/agent/settings.json` or a trusted project's `.atomic/settings.json`:

```json
{
  "compactionModel": "morph/morph-compactor"
}
```

`"auto"` (lowercase) or an empty string clears the context by default. A registered compactor ID must match `provider/model` **case-sensitively** (leading and trailing whitespace is trimmed). For Morph, authenticate with `/login morph` or set `MORPH_API_KEY`. Compactor models are excluded from `/model` and never run as chat models.

### Customize Morph or add a remote compactor

Keep default compaction clean in `settings.json` and configure endpoint-specific parameters directly on the compactor model in `~/.atomic/agent/models.json`.

**Override built-in Morph parameters:**

```json
{
  "providers": {
    "morph": {
      "modelOverrides": {
        "morph-compactor": {
          "compactionParams": {
            "compression_ratio": 0.35,
            "preserve_recent": 2
          },
          "timeoutMs": 180000
        }
      }
    }
  }
}
```

**Add a custom remote compactor model:**

```json
{
  "providers": {
    "my-compactor": {
      "baseUrl": "https://compact.example.com/v1",
      "apiKey": "$MY_COMPACTOR_API_KEY",
      "headers": {
        "X-Team": "platform"
      },
      "models": [
        {
          "id": "compact-v2",
          "name": "Internal Compactor v2",
          "type": "compactor",
          "api": "custom-compact",
          "endpointPath": "/compress",
          "compactionParams": {
            "target_ratio": 0.4,
            "preserve_recent": 2
          },
          "timeoutMs": 180000
        }
      ]
    }
  }
}
```

- Set `"type": "compactor"` so Atomic treats the entry as a compaction model (and exposes it automatically in `/settings` under **Compaction model** instead of `/model`).
- Set `"api"` on the provider or model (for example `"custom-compact"`). Custom compactors do not inherit a default `"api"` string; each provider defines its own (built-in Morph defines `"api": "morph-compact"`). Overriding an existing compactor model under `modelOverrides` inherits its provider's `api` and `baseUrl` automatically.
- Omit `compactionParams` to send only `{ messages, query, model }` and use the remote API's own defaults. Add `compactionParams` to pass any API-specific parameters (such as `compression_ratio`, `preserve_recent`, `include_markers`, `include_line_ranges`, or custom fields) directly in the JSON request body.
- `endpointPath` appends to `baseUrl` and defaults to `"/compact"`. Set `"endpointPath": ""` to POST directly to `baseUrl`.
- Set `headers` on the provider or model for custom auth headers (such as `"X-API-Key": "$MY_KEY"`). Values support `$ENV`, `${ENV}`, and `!command`, and sensitive auth headers are redacted automatically from errors and output.

A compactor receives your in-context conversation and uses its own provider credentials, so enable one only if that provider may receive your session text. Changing `compactionModel` does not affect branch summaries. SDK and extension callers can override the setting for a single run with `session.compact({ compactionModel })` or `ctx.compact({ compactionModel })`, or register custom compactors programmatically with [`atomic.registerProvider()`](/custom-provider/api-reference).

Compaction does not call chat models or classifiers. On startup, once extensions finish loading, and when you trust a project, Atomic resets any saved chat or classifier `compactionModel` to `auto`. Compactor IDs and unknown IDs remain untouched; an unknown ID or a per-run chat or classifier override falls back to context clearing with a notice.

## `keepContext` tags

Wrap text the agent must not lose in `<keepContext>` and `</keepContext>`:

```text
<keepContext>
You are researching only. Do not implement code changes.
</keepContext>
```

The tags do not pin text in the context window automatically. Instead, recovery instructions tell the agent to search session history for every tagged span and recover each one verbatim before anything else. A compactor model may also honor the tags.

- Put each opening and closing tag on its own line.
- Tag constraints, prohibitions, acceptance criteria, and key identifiers. Keep spans short and place large material in files so recovery stays fast.

## The boundary in the chat

Both the main chat and subagent views in `/tasks` show one line per boundary:

```text
⚛ Context cleared · 182.0k tokens
⚛ Context compacted · morph/morph-compactor · 182.0k → 21.4k tokens
```

A boundary supplied by an extension names `extension` as its source. When a configured compactor was not used, the `Compaction model not used (<reason>); context cleared instead` notice appears beneath the line. Press `Ctrl+O` (`app.tools.expand`) or click the boundary to expand the full recovery instructions and any compacted text.

A failed or cancelled `/compact` stops its spinner, displays the error, writes no boundary, and leaves the session ready for another `/compact` or normal turn.

## Failed turns and token accounting

When counting context tokens and checking compaction thresholds, Atomic measures only what will actually be sent to the model. When Atomic recovers from a provider retry, model fallback, context overflow, or truncated response, the failed attempt stays in raw history while a `context_edit` entry omits it from model context (see [Session file format](/session-format#contexteditentry)).

Omitted entries do not count toward compaction or token estimates, and usage from an omitted or edited assistant message is not used for threshold checks. You can still inspect the original provider error in the agent panel, `/tasks`, raw transcripts, exports, and history search.

<div id="branch-summarization" />

## Branch summaries

When [`/tree`](/sessions#branching-with-tree) switches away from a branch, Atomic can optionally summarize the abandoned branch and attach that summary at the new position. This preserves work from the path you left without replaying the entire branch.

When prompted, choose one of three options:

1. No summary
2. Summarize with the default prompt
3. Summarize with custom focus instructions

Set `"branchSummary": { "skipPrompt": true }` to skip the prompt and default to no summary. Branch summaries are separate from `/compact`. Branch navigation generates summary prose, whereas compaction clears context or replaces it with a compactor's output.

### How branch summarization works

Atomic collects entries from the abandoned branch up to the common ancestor, prioritizing newer messages to fit inside a token budget of `contextWindow - branchSummary.reserveTokens` (defaulting `contextWindow` to `128000` when unknown, and `reserveTokens` to `16384`). `branchSummary.reserveTokens` sets the space reserved for the summary prompt and reply, not the history budget itself.

The provider sizes summary output from the model's output limit and available context, inheriting the session's `thinkingLevel` unless it is `"off"`. Atomic rejects incomplete summaries rather than saving partial prose.

```text
Tree before navigation:

         ┌─ B ─ C ─ D (old leaf, being abandoned)
    A ───┤
         └─ E ─ F (target)

Common ancestor: A
Entries to summarize: B, C, D

After navigation with summary:

         ┌─ B ─ C ─ D ─ [summary of B,C,D]
    A ───┤
         └─ E ─ F (new leaf)
```

Built-in branch summaries keep a cumulative list of read and modified files, carrying forward file lists from earlier built-in branch summaries (extension-supplied summaries are not parsed for file lists).

### How summary requests run

Branch summary requests run no tools and do not write into the main chat's prompt cache. They keep normal authentication, cancellation, and retry behavior.

For saved entry fields, message serialization, extension hooks, SDK concurrency rules, and settings, see [Compaction reference](/compaction/reference) (including [Branch summary format](/compaction/reference#branch-summary-format) and [Extension hooks for branch summarization](/compaction/reference#extension-hooks-for-branch-summarization)).
