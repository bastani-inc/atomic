---
title: "Pi foreground subagent supervisor detach, nested lifecycle deadlocks, and Bun IPC ordering"
date: 2026-07-19
fetched_at: 2026-07-19
researcher: atomic research specialist
status: synthesized
breaking_changes_allowed: false
topic: foreground subagent detach-on-supervisor-ask, nested event-loop deadlocks, child-parent RPC park/resume, Bun IPC ordering
source_url: https://github.com/nicobailon/pi-subagents/issues/335
fetch_method: browse
source_urls:
  - https://github.com/nicobailon/pi-subagents/issues/335
  - https://github.com/nicobailon/pi-subagents/issues/384
  - https://github.com/nicobailon/pi-subagents/issues/456
  - https://github.com/nicobailon/pi-subagents
  - https://github.com/earendil-works/pi/issues/2110
  - https://github.com/earendil-works/pi/issues/2195
  - https://github.com/earendil-works/pi/issues/2645
  - https://github.com/earendil-works/pi/issues/5886
  - https://github.com/earendil-works/pi
  - https://bun.sh/docs/guides/process/ipc
  - https://github.com/oven-sh/bun/issues/7812
  - https://github.com/oven-sh/bun/issues/23686
  - https://github.com/oven-sh/bun/issues/32567
repo_shas:
  earendil_works_pi: 3da591ab74ab9ab407e72ed882600b2c851fae21
  nicobailon_pi_subagents: d6e8005e3958adea634bf27c615abac7407aedc4
  nicobailon_pi_intercom: e234a4446e2b3f9c13a1ec3151ae2169315c810f
cache_note: "Primary issue text fetched from GitHub; repositories cloned locally. Code claims use full-SHA permalinks. Bun issue evidence is explicitly treated as runtime/version-specific analogy, not proof of the application defect."
---

# Summary

Directly applicable upstream evidence is unusually strong: pi-subagents issue #335 documents the exact wait-for cycle (foreground parent awaits child exit; child blocks on supervisor reply; parent's incoming message is idle-gated), and current pi-subagents v0.35.1 implements a routed detach request/ack, returns the foreground tool call, remembers the still-live child, then requires reply-first followed by `subagent_wait({id})`. Issues #384 and #456 document why detach alone is insufficient: final results must remain tracked/recoverable and a live detached child must not be resumed or duplicated.

Pi core separately warns that session-control methods are command-only because they can deadlock in event handlers. Its settled lifecycle distinguishes low-level `agent_end` from true `agent_settled`, including retry, compaction, and queued continuation. RPC clients subscribe before prompting and wait for `agent_settled`; this is a useful ordering model, but Pi's RPC is not itself a park/resume supervisor protocol.

Bun evidence is secondary. Official docs support IPC between Bun processes. Historical issue #7812 reported send-before-child-listener message loss and is closed; current open #23686 reports `unref()` may let a Bun parent exit despite IPC; open #32567 reports Bun/Node message-observation ordering differences. These justify explicit ready/ack barriers, live handles, correlation IDs, and not relying on incidental callback order, but do not establish Bun as the root cause of the foreground supervisor deadlock.

# Direct evidence links

- Exact deadlock: https://github.com/nicobailon/pi-subagents/issues/335
- Result tracking after detach: https://github.com/nicobailon/pi-subagents/issues/384 and https://github.com/nicobailon/pi-subagents/issues/456
- Current documented orchestration: https://github.com/nicobailon/pi-subagents/blob/d6e8005e3958adea634bf27c615abac7407aedc4/README.md#L597-L601
- Detach request routing/ack: https://github.com/nicobailon/pi-subagents/blob/d6e8005e3958adea634bf27c615abac7407aedc4/src/runs/foreground/execution.ts#L456-L470
- Parent emits routed detach request for reply-bearing supervisor request: https://github.com/nicobailon/pi-subagents/blob/d6e8005e3958adea634bf27c615abac7407aedc4/src/intercom/native-supervisor-channel.ts#L615-L657
- Remembered-child wait semantics: https://github.com/nicobailon/pi-subagents/blob/d6e8005e3958adea634bf27c615abac7407aedc4/src/runs/background/subagent-wait.ts#L286-L321
- Pi event-handler deadlock warning / wait-for-settlement: https://github.com/earendil-works/pi/blob/3da591ab74ab9ab407e72ed882600b2c851fae21/packages/coding-agent/docs/extensions.md#L1072-L1099
- Pi RPC subscribe-before-prompt and settled wait: https://github.com/earendil-works/pi/blob/3da591ab74ab9ab407e72ed882600b2c851fae21/packages/coding-agent/src/modes/rpc/rpc-client.ts#L443-L493
- Pi prompt while active must explicitly queue as steer/follow-up: https://github.com/earendil-works/pi/blob/3da591ab74ab9ab407e72ed882600b2c851fae21/packages/coding-agent/src/core/agent-session.ts#L1093-L1160
- Avoid recursively invoking a foreground subagent tool from a tool hook; use event request/response: https://github.com/nicobailon/pi-subagents/blob/d6e8005e3958adea634bf27c615abac7407aedc4/README.md#L983-L1019

# Bun analogies

- Official IPC guide: https://bun.sh/docs/guides/process/ipc
- Closed historical listener-readiness race: https://github.com/oven-sh/bun/issues/7812
- Open Bun 1.3.0 `unref()`/IPC liveness report: https://github.com/oven-sh/bun/issues/23686
- Open Bun 1.3.14 message ordering difference report: https://github.com/oven-sh/bun/issues/32567
