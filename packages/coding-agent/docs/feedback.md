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

Both kinds need a title. Bugs require **What happened?** and **Steps to reproduce**; **Expected behavior** and **Version** are optional. Enhancements require **What do you want to change?** and **Why?**; **How? (optional)** is optional. These fields follow the repository's [bug form](https://github.com/bastani-inc/atomic/blob/main/.github/ISSUE_TEMPLATE/bug.yml) and [enhancement form](https://github.com/bastani-inc/atomic/blob/main/.github/ISSUE_TEMPLATE/contribution.yml). Atomic asks one concise ordinary-chat question when the kind or a required field is unresolved, rather than inventing an answer.

Running `/feedback` without text prints exactly:

```text
Usage: /feedback <what happened or what you want to change>
```

The blank form starts no model turn.
If the bundled feedback skill cannot be loaded, Atomic prints `The bundled feedback skill is unavailable.` and starts no model turn.

## Revise and approve

There is no modal or captured input: questions, answers, edits, approvals, and errors are ordinary transcript turns. Each requested revision runs the preparation step again, privacy-scrubs the complete draft, and displays the exact newly prepared Markdown before asking for approval.

Posting requires clear, immediately relevant approval in a new ordinary user message after the exact repository, kind, title, body, and privacy summary appear in assistant Markdown. Accepted messages include `Yes.`, `Approved.`, `post it`, and `yes, submit this issue`. An unrelated or ambiguous response is not approval. If submission is attempted without approval, the tool refuses it with `Clear approval to post the most recent draft is required in a new ordinary user message.`

Changing the topic, requesting edits, or running unrelated tools invalidates the approval context. Ask Atomic to display the latest draft again before approving it. A failed or undisplayed newer preparation cannot fall back to an older draft. If a model turn fails, the earlier draft remains in the transcript; retry the revision in a normal message and review the new result.

One approval authorizes exactly one posting attempt. A failed attempt is never retried automatically; review the retained draft and give fresh approval before another attempt. Already submitted or concurrently submitting drafts are protected against duplicates in that session, not across separate sessions or uncertain network outcomes.

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

Automatic scrubbing is not a guarantee that a report is safe to publish. Weak labels such as `key` can preserve ordinary prose; complete template placeholders and Markdown links are also preserved. Remove secrets manually if they use those forms. Quoted credentials can span contiguous nonblank lines, but blank lines and Markdown report headings are hard scrub boundaries, including for private-key blocks. Secret material beyond those boundaries requires manual removal. Review both remaining private data and useful text that may have been redacted. See [Reviewing scrubbed feedback](/security#reviewing-scrubbed-feedback) for the full boundary rules.

Recognized home-directory prefixes become `~`. Long diagnostic text and stack traces are bounded rather than attached in full. The report never automatically includes screenshots, repository file contents, raw environment dumps, or debugger transcripts. Use the [Security Policy](https://github.com/bastani-inc/atomic/blob/main/SECURITY.md) instead of a public feedback issue for security-sensitive reports.

## Bug investigation and isolation

A bug draft runs exactly one foreground instance of the existing `debugger` subagent in a fresh context, using its existing model and fallback policy. If foreground observation yields, Atomic waits for that same investigation rather than launching another. Enhancements run no debugger, and revising a bug draft does not start another investigation.

The initial debugger handoff contains only a bounded, privacy-scrubbed diagnostic snapshot, not the parent transcript, file contents, or raw artifacts. The feedback flow itself does not reset, clean, stash, or overwrite your pre-existing changes. Atomic asks the debugger to investigate and report supported evidence and unknowns without implementing a fix. The investigation runs in your working directory, not an isolated worktree; that request is not a technical restriction on its write tools. If it is unavailable, interrupted, or fails, the draft says `Investigation unavailable`; an inconclusive investigation leaves the cause unknown.

Atomic compares working-tree paths before and after the investigation. Newly observed paths are not proof of who created them, and appear as paths only, never automatic attachments. Lists show at most 100 paths and disclose truncation. If a baseline is unavailable or too large, the draft leaves newly created paths unknown. Review your working tree yourself rather than treating an empty or capped list as a complete investigation footprint.

Bug drafts include non-builtin extension activity. If it is `Not reported`, tell Atomic which extensions were active or that none were active. You can report the result of reproducing with `atomic -ne`, which disables optional extension discovery but keeps mandatory bundled Intercom. Atomic does not run that experiment for you; without a supplied result the draft records exactly `Not tested without extensions`.

## GitHub authentication

Submission requires `GITHUB_TOKEN` or `GH_TOKEN` in Atomic's environment with permission to create issues in `bastani-inc/atomic`. `GITHUB_TOKEN` takes precedence. A GitHub CLI login alone does not configure this tool: it reads the environment, not `gh`'s credential store. Do not paste credentials into chat or command arguments. The transport uses the token only in its HTTP authorization header and never includes it in the draft or returned error text. Posted issues receive the `bug` or `enhancement` label matching the reviewed kind.

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
