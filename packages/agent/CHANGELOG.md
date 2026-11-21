# Changelog

This package is Atomic's fork of `@earendil-works/pi-agent-core`. Its history up to the fork point, pi `v1.5.2`, lives in [earendil-works/pi](https://github.com/earendil-works/pi/blob/v1.5.2/packages/agent/CHANGELOG.md).

## [Unreleased]

### Added

- `Agent.onQueuedMessagesTaken` is called with the steering or follow-up messages a run takes from its queue, as it takes them, before their `message_start`.

## [0.10.2] - 2026-11-20

### Added

- Assistant messages record `requestedThinkingBudget`, the thinking budget in tokens the request's thinking level resolved to with the agent's `thinkingBudgets` ([#6092](https://github.com/bastani-inc/atomic/pull/6092)).
- `unknownToolMessage` on `Agent` and `AgentLoopConfig` sets the error a call to a tool the agent does not have returns, instead of `Tool <name> not found` ([#6093](https://github.com/bastani-inc/atomic/pull/6093)).

## [0.10.2-alpha.1] - 2026-11-20

### Added

- Assistant messages record `requestedThinkingBudget`, the thinking budget in tokens the request's thinking level resolved to with the agent's `thinkingBudgets` ([#6092](https://github.com/bastani-inc/atomic/pull/6092)).
- `unknownToolMessage` on `Agent` and `AgentLoopConfig` sets the error a call to a tool the agent does not have returns, instead of `Tool <name> not found` ([#6093](https://github.com/bastani-inc/atomic/pull/6093)).

## [0.9.89] - 2026-11-18

### Added

- `Agent.promptQueuedMessages()` starts a turn from the queued steering or follow-up messages whatever the transcript ends with, as `continue()` does after an assistant reply, and resolves `false` when nothing is queued

## [0.9.89-alpha.1] - 2026-11-18

### Added

- `Agent.promptQueuedMessages()` starts a turn from the queued steering or follow-up messages whatever the transcript ends with, as `continue()` does after an assistant reply, and resolves `false` when nothing is queued

## [0.9.88] - 2026-11-16

### Changed

- Forked `@earendil-works/pi-agent-core` 1.5.2 as `@bastani/atomic-agent-core`, published with every Atomic release at Atomic's version. Atomic's extension loader still resolves `@earendil-works/pi-agent-core` and `@mariozechner/pi-agent-core` imports to this package ([#5174](https://github.com/bastani-inc/atomic/issues/5174))
- Agent loops attribute requests to Atomic by default: `DEFAULT_AGENT_IDENTITY` uses `ATOMIC_ATTRIBUTION` instead of pi's attribution ([#5174](https://github.com/bastani-inc/atomic/issues/5174))

## [0.9.88-alpha.1] - 2026-11-16

### Changed

- Forked `@earendil-works/pi-agent-core` 1.5.2 as `@bastani/atomic-agent-core`, published with every Atomic release at Atomic's version. Atomic's extension loader still resolves `@earendil-works/pi-agent-core` and `@mariozechner/pi-agent-core` imports to this package ([#5174](https://github.com/bastani-inc/atomic/issues/5174))
- Agent loops attribute requests to Atomic by default: `DEFAULT_AGENT_IDENTITY` uses `ATOMIC_ATTRIBUTION` instead of pi's attribution ([#5174](https://github.com/bastani-inc/atomic/issues/5174))
