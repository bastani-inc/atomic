Rust migration architecture and compatibility matrix across CLI, sessions, TUI, extensions, workflows, MCP, web, and intercom
Root workspace, Bun scripts, package manifests, and proposed Rust crate/workspace layout
CI, release, binary distribution, version bumping, and hook migration
CLI entrypoint, argument parsing, and mode dispatch parity
Config, environment variables, app paths, `.atomic`, and legacy `.pi` compatibility
SDK session creation boundary and replacement of `createAgentSession`
Agent session runtime state, event flow, compaction, tool orchestration, and bash state
Session JSONL persistence, branching, labels, and session-format compatibility
Model registry, provider resolution, auth storage, and custom provider compatibility
AI provider streaming hooks and replacement strategy for `pi-ai`
Builtin tool ABI and tool registration contracts
Filesystem read, edit, write, mutation queue, and safety semantics
Bash/process execution, command sandboxing, and cross-platform process behavior
Extension public API compatibility from `core/extensions/types.ts` and docs
Dynamic TypeScript/JavaScript extension loading via `jiti` and Rust plugin alternatives
Resource loading, package discovery, manifests, and builtin resource merging
Interactive TUI shell, components, themes, keybindings, and `pi-tui` replacement strategy
Print mode, JSON output mode, and RPC protocol compatibility
Skills, prompt templates, context files, and markdown-based resource loading
Conversation compaction, tree navigation, and session history behavior
HTML export, sharing, changelog, and update/version-check utilities
Builtin package bundling into `@bastani/atomic` and runtime dependency copying
Workflow authoring DSL, TypeBox schemas, and type inference migration
Workflow dynamic module loading, discovery, and user workflow compatibility
Workflow foreground execution engine, stage runner, and executor semantics
Workflow background execution, resume, cancel, status, and job tracking
Workflow graph store, persistence files, status writer, and run metadata
Workflow TUI graph, widget, overlay, and human-in-the-loop UI behavior
Builtin workflows and reusable orchestration semantics
Workflow integrations with intercom, MCP, lifecycle hooks, and notifications
Subagent agent and chain discovery, builtin markdown agents, and skill loading
Subagent foreground execution and orchestration behavior
Subagent background execution, async result watching, status, and resume behavior
Subagent process spawning, forked context, nested events, and session isolation
Subagent git worktree isolation, acceptance gates, and completion guard behavior
MCP configuration, import commands, README/OAuth compatibility, and manifest surface
MCP server manager, stdio/SSE/HTTP transports, OAuth, and lifecycle management
MCP tool registration, direct tools, proxy modes, and tool registrar behavior
MCP UI resources, UI server, sampling handler, consent manager, and security model
Web search providers, code search, provider fallback, and API key handling
Web content extraction for HTML, GitHub, PDF, YouTube, video, and subprocess tools
Web curator server, curator page, storage, summary review, and search session persistence
Intercom broker, client protocol, IPC framing, and local routing behavior
Intercom extension UI, supervisor flows, reply tracking, and cross-session coordination
Cross-platform native dependency audit for clipboard, WASM, ffmpeg, yt-dlp, gh, browser cookies, and paths
Test coverage inventory across root tests, package tests, integration tests, and Rust parity tests
Security and trust model for TS extensions, workflows, MCP subprocesses, web fetching, IPC, and tool permissions
External `pi-agent-core`, `pi-ai`, and `pi-tui` dependency replacement or binding strategy
Raw TypeScript companion package compatibility and migration options
Documentation/spec reconciliation between historical rewrite specs and current repository behavior