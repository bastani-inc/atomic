---
title: "Use custom compaction models"
sidebarTitle: "Custom compaction models"
description: "Use built-in Morph or configure your own remote HTTP compactor model with custom parameters and automatic fallback to memory compaction."
---

**Custom compaction models** are Atomic's second form of compaction. Instead of clearing the context window outright, Atomic sends the active context once to a dedicated remote compactor endpoint—either built-in `morph/morph-compactor` or a custom compactor you define in `models.json` or an extension—and places its response inside a `<compacted-context>` block.

Your full conversation still stays verbatim in session history, and the boundary includes the same history recovery instructions as [memory compaction](/compaction/memory-compaction) so the agent can pull back anything the compactor omitted.

<Warning>
A remote compactor receives your in-context conversation and uses its own provider credentials. Enable a remote compactor only if your policy permits sending session content to that provider.
</Warning>

## Quick start: use built-in Morph

<Steps>
  <Step title="Authenticate Morph">
    Run `/login morph` inside Atomic, or export `MORPH_API_KEY` in your shell.
  </Step>
  <Step title="Select the compaction model">
    Open `/settings`, select **Compaction model**, and pick `morph/morph-compactor`. The change applies immediately with no `/reload` or restart.
  </Step>
</Steps>

## How custom compactors work

When `compactionModel` names a registered compactor model, Atomic frames the current context window (previous compacted text first, followed by role-labelled user messages, assistant text, tool calls with arguments, tool results, shell commands with exit codes, and extension messages) and sends one HTTP `POST` request to that model's endpoint:

- **No forced request defaults.** Atomic sends `{ messages, query, model }` plus any optional keys you put in `compactionParams`. When `compactionParams` is omitted, Atomic adds no provider-specific fields so the remote API applies its own defaults.
- **No built-in output size limit.** Whatever the endpoint returns is kept as-is, however long it is. To ask the endpoint for shorter output, set its own parameter in `compactionParams` (for Morph, `compression_ratio`). To reject long output locally, set `maxTokens` on the compactor model: output exceeding that token estimate falls back to memory compaction. `maxTokens` has no default.
- **Oversized output does not loop.** If a compactor returns output that remains above the automatic threshold, nothing is rejected and Atomic does not re-compact before every tool call of the same turn. The next user turn compacts again before its first request. If the provider reports a context overflow, Atomic compacts and retries once; if the retry still overflows, the provider's error is shown.
- **Content filtering and redaction.** Images become omission markers, thinking blocks are omitted, role headers are wrapped in `<keepContext>` tags, and messages excluded from model context (such as `!!` shell commands and display-only extension messages) are not sent. If an endpoint echoes your API key or a sensitive auth header, Atomic replaces it with `[redacted]` before storing or displaying the output.

## Select a compaction model {#select-a-compaction-model}

Open `/settings` and choose **Compaction model** to switch between **Automatic** ([memory compaction](/compaction/memory-compaction)) and any registered compactor model immediately, without `/reload` or restarting.

Both built-in `morph/morph-compactor` and custom remote compactors defined in `~/.atomic/agent/models.json` or an extension appear in this searchable picker automatically (authenticated models first; unauthenticated ones show `requires /login <provider>`). The selector updates project settings when a project override already exists, and global settings otherwise.

You can also set `compactionModel` directly in `~/.atomic/agent/settings.json` or a trusted project's `.atomic/settings.json`:

```json
{
  "compactionModel": "morph/morph-compactor"
}
```

- `"auto"` (lowercase) or `""` selects [memory compaction](/compaction/memory-compaction).
- A registered compactor ID must match `provider/model` **case-sensitively** (leading and trailing whitespace is trimmed).
- Compactor models never appear in `/model` and never run as chat models. Changing `compactionModel` does not affect [branch summaries](/compaction/branch-summaries).

Compaction never calls chat models or classifiers. On startup, once extensions finish loading, and when you trust a project, Atomic resets any saved chat or classifier `compactionModel` to `"auto"`. Compactor IDs and unknown IDs remain untouched; an unknown ID falls back to memory compaction with a notice.

For programmatic per-run overrides, live SDK/RPC switching, and registering compactors from extensions, see [Compaction reference](/compaction/reference), [Compaction and tree navigation](/sdk#compaction-and-tree-navigation), and [Custom providers](/custom-provider/api-reference).

## Configure Morph or add a custom compactor {#configure-morph-or-add-a-custom-compactor}

Keep `settings.json` free of endpoint knobs and configure API-specific parameters directly on the compactor model in `~/.atomic/agent/models.json` (see [Remote compaction models](/models#remote-compaction-models)).

### Override built-in Morph parameters

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

### Add a custom remote compactor

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

Key configuration fields:

- **`type: "compactor"`** registers the model as a compactor so it appears in `/settings` under **Compaction model** instead of `/model`.
- **`api`** is required on the provider or model for custom compactors (built-in Morph defines `"api": "morph-compact"`). Overriding an existing compactor under `modelOverrides` inherits its provider's `api` and `baseUrl`.
- **`compactionParams`** merges arbitrary API-specific keys into the JSON request body alongside `{ messages, query, model }`. Omit it to let the remote API apply its own server defaults.
- **`endpointPath`** appends to `baseUrl` and defaults to `"/compact"`. Set `"endpointPath": ""` to `POST` directly to `baseUrl`.
- **`timeoutMs`** overrides the default 120-second request timeout.
- **`maxTokens`** sets an optional estimated-token cap on the compactor's response (no default; longer output falls back to memory compaction).
- **`headers`** supports `$ENV`, `${ENV}`, and `!command` for custom auth headers (such as `"X-API-Key": "$MY_KEY"`). Sensitive auth headers are redacted automatically from errors and compacted output.

For the exact HTTP payload, header, token estimator, and response contract, see [Compactor request contract](/compaction/reference#compactor-request-contract).

## Automatic fallback to memory compaction

Every compactor failure falls back automatically to **Automatic** ([memory compaction](/compaction/memory-compaction)) so a broken, unauthenticated, or slow remote endpoint never blocks a session. Atomic does not retry the remote request. If the endpoint reports that your quota is exhausted, the SDK also marks that failure as not retryable; wait for the quota to reset or replenish it before trying remote compaction again. No settings change is needed for fallback:

```text
Compaction starts
  ├─ Cancelled by user or extension                                    -> Cancelled (context unchanged)
  ├─ Extension supplies replacement text                               -> Context compacted (extension)
  ├─ Compaction model is "" / "auto"                                   -> Memory compaction (Context cleared)
  ├─ Compaction model is unknown / chat / classifier                   -> Automatic fallback (Context cleared)
  └─ Compaction model is a registered compactor
       ├─ success (within maxTokens, if you set one)                   -> Context compacted (compactor)
       └─ missing auth / HTTP or network error / timeout / Esc /
          malformed or empty output / longer than a maxTokens you set  -> Automatic fallback (Context cleared)
```

Atomic prints a one-line notice (`Compaction model not used (<reason>); context cleared instead`) without exposing your API key or sensitive headers. Pressing `Escape` while a compactor request is in flight also falls back to memory compaction with reason `request aborted`. Taking over with `/compact`, closing the session, or an extension cancelling compaction stops compaction completely.

### Troubleshooting network and DNS errors

If Atomic cannot reach the compactor's server, the fallback notice names the underlying connection failure while falling back to memory compaction so your session keeps moving.

<Accordion title="Host name cannot be resolved (ENOTFOUND)">
```text
Compaction model not used (morph/morph-compactor failed: fetch failed: getaddrinfo ENOTFOUND api.morphllm.com); context cleared instead
```

Check your network connection, proxy or VPN settings, and the compactor's `baseUrl`.
</Accordion>

<Accordion title="Blocked by a DNS filter (0.0.0.0 or ::)">
A DNS filter such as NextDNS, Pi-hole, or AdGuard can block the compactor by resolving its domain to `0.0.0.0` or `::`. When the host resolves only to those addresses, Atomic names the domain to allow:

```text
Compaction model not used (morph/morph-compactor failed: fetch failed: ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR: tlsv1 alert internal error (api.morphllm.com resolves to 0.0.0.0, the address DNS filters such as NextDNS, Pi-hole or AdGuard return for blocked domains; allow api.morphllm.com in the resolver)); context cleared instead
```

Add that domain to your DNS filter's allowlist. Until then, compaction continues working through memory compaction.
</Accordion>
