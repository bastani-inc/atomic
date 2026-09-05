# @bastani/feedback — Conversational feedback drafting for Atomic

This bundled extension provides a safe, ordinary-conversation workflow for drafting feedback:

- `/feedback <what happened or what you want to change>` starts the bundled feedback skill.
- The `feedback` skill classifies bug reports and enhancement requests, asks concise clarifying questions, and keeps revisions in the normal transcript.
- The `feedback_prepare_issue` tool validates the current issue form, formats the draft, and scrubs private data without posting anything.

The `feedback_submit_issue` tool posts only the latest reviewed draft after clear approval, re-scrubbing it and preventing duplicate submissions.
