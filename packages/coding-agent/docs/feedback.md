---
title: "Feedback"
description: "Draft and submit privacy-scrubbed Atomic bug reports and enhancements"
---

# Feedback

Atomic bundles a conversational feedback skill that prepares GitHub issues for `bastani-inc/atomic` without leaving the normal transcript.

## Start a draft

```text
/feedback <what happened or what you want to change>
```

Text after `/feedback` starts one ordinary, model-led turn driven by the bundled `feedback` skill. The skill classifies the request as a bug or enhancement, collects the fields required by the repository's current issue form, validates them, and displays the prepared Markdown for review.

Running `/feedback` without text prints exactly:

```text
Usage: /feedback <what happened or what you want to change>
```

The blank form starts no model turn.

## Revise and approve

There is no modal or captured input: questions, answers, edits, approvals, and errors are ordinary transcript turns. Each requested revision runs the preparation step again, privacy-scrubs the complete draft, and displays the exact newly prepared Markdown before asking for approval.

Posting requires clear, immediately relevant approval in a **new ordinary user message** after the prepared draft is displayed. Accepted messages include `post it`, `yes, submit this issue`, and `ship it`. Approval is intentionally narrow: an unrelated or ambiguous response is not approval and produces `Clear approval to post the most recent draft is required in a new ordinary user message.`

One approval authorizes exactly one posting attempt. A failed attempt is never retried automatically; review the retained draft and give fresh approval before another attempt. Already submitted or concurrently submitting drafts are protected against duplicates.

## Privacy replacements

Every prepared revision is scrubbed, and the reviewed title and body are scrubbed again immediately before posting. If the second pass changes either, submission stops with `The reviewed content still contains private data. Prepare and review the scrubbed draft again.`

The scrubber replaces these categories:

- `private-key`
- `url-credentials`
- `anthropic-token`
- `github-token`
- `openai-token`
- `aws-access-key`
- `provider-token`
- `credential-assignment`
- `home-directory`

The privacy summary reports only each replacement category and count, never the replaced value. `credential-assignment` knowingly overmatches ordinary identifiers ending in `key`; this conservative behavior is deliberate.

## Bug investigation and isolation

A bug draft runs exactly one foreground `subagent` call using the existing `debugger` agent. It does not override the debugger's model or use parallel tasks. Enhancements run no debugger.

The debugger receives only a bounded, privacy-scrubbed diagnostic snapshot. It receives no file contents or raw artifacts, investigates without implementing a fix, and returns supported evidence and unknowns. Any paths created during the investigation can appear in the draft as paths only. If the debugger is unavailable, interrupted, fails, or remains inconclusive, Atomic preserves an honest, editable draft rather than inventing a cause.

You can report the result of reproducing with `atomic -ne` (no extensions) for the isolation field. Atomic does not run that experiment for you; if you have not supplied a result, the draft records exactly `Not tested without extensions`.

## GitHub authentication

Submission reads `GITHUB_TOKEN`, then `GH_TOKEN`, from Atomic's environment. A missing token produces an authentication failure. The token is never included in the draft, transcript output, or an error message. Posted issues target `bastani-inc/atomic` and receive the `bug` or `enhancement` label matching the draft kind.

## Posting failures

| Code | Message |
|------|---------|
| `authentication` | GitHub authentication failed. The reviewed draft was not posted. |
| `permission` | GitHub denied permission to create the issue. The reviewed draft was not posted. |
| `rate-limit` | GitHub rate-limited the submission. The reviewed draft was not posted. |
| `validation` | GitHub rejected the issue as invalid. The reviewed draft was not posted. |
| `network` | The issue submission has no confirmed result. Check bastani-inc/atomic before approving another attempt. |
| `abort` | The issue submission was aborted before a confirmed result. Check bastani-inc/atomic before approving another attempt. |
| `malformed-response` | GitHub returned an invalid issue response with no confirmed result. Check bastani-inc/atomic before approving another attempt. |
| `stale-draft` | The submitted content does not match the most recent prepared draft. Review the latest draft first. |
| `missing-approval` | Clear approval to post the most recent draft is required in a new ordinary user message. |
| `private-data` | The reviewed content still contains private data. Prepare and review the scrubbed draft again. |
| `duplicate` | This reviewed draft has already been submitted or is currently being submitted. |

A failure never discards the draft or invents an issue URL. Network, aborted, and malformed-response outcomes are unconfirmed, so their messages direct you to check `bastani-inc/atomic` before approving another attempt. A duplicate response for an already posted draft may also include its existing issue URL.

## Change direction

There is no cancel command because a draft is only conversation state. Send an ordinary message about something else to continue the session. The abandoned draft is not posted: submission still requires immediately relevant approval after a freshly displayed draft.

See [Skills](/skills) for how bundled skills participate in model-led turns and [Security](/security) for Atomic's broader trust model.
