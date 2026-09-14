# Changelog

## [Unreleased]

## [0.9.19] - 2026-09-13

Cumulative release of the `0.9.19-alpha.2` through `0.9.19-alpha.4` prereleases. Per-change details remain in the unchanged prerelease sections below.

### Added

- Added an environment-local `TaskSupervisor` with owner-sealed admission, stable task identities, replay-safe reports, observation waits, cancellation, independent cleanup acknowledgement and byte-bounded snapshot subscriptions ([#2884](https://github.com/bastani-inc/atomic/pull/2884)).
- Added supervised Unix pipe/PTY and Windows pipe/ConPTY commands with retained output, execution deadlines and confirmed process-group or Job Object cleanup. Windows containment happens before execution resumes and has no unsupervised fallback ([#2884](https://github.com/bastani-inc/atomic/pull/2884)).
- Added replay-safe byte-credit stdin, resize, output paging, retained model/reasoning reports, and `taskSettlement` receipt lookup for recovering completion delivery. Snapshots retain `wasBackground` after settlement.
- Added optional direct-executable `CommandIntent.shell: { program, args }` and `inheritEnv` controls, both included in operation replay identity.

### Changed

- Raised the minimum supported Bun runtime to 1.4.2.

### Fixed

- Embedded Postgres starts on Windows administrative accounts using a restricted token while retaining the exact process handle for shutdown and retry ownership. Regular Windows and Unix privilege behavior is unchanged.
- Preserved Windows Postgres logs, closed stdin, Unicode environment overrides, `PATH` and relative executable lookup, batch launcher quoting, explicit command interpreters and safe verbatim working directories. Invalid NUL-containing inputs fail before launch; restricted children inherit only selected streams, and partial failures and repeated launches release handles correctly.
- Enforced a shared supervised-output file cap across streams and descendants and clamped output pages to 1 MiB ([#2905](https://github.com/bastani-inc/atomic/pull/2905)).
- Preserved large and fractional wait budgets, exact numeric exit codes and metric replay, signed zero, NaN and lossless UTF-16 strings. NaN waits no longer panic scheduling ([#2884](https://github.com/bastani-inc/atomic/pull/2884)).
- Bounded activity replay to 256 hashed identities per task while retaining terminal receipts. Caller IDs cannot consume internal settlement identities or prevent cleanup ([#2884](https://github.com/bastani-inc/atomic/pull/2884)).
- Retry transient macOS process-group permission errors within the cleanup deadline, so unreaped zombies do not cause immediate failure; persistent refusals still fail closed.

## [0.9.19-alpha.4] - 2026-09-10

### Fixed

- The retained embedded Postgres process now starts on Windows administrative accounts with the same restricted access token `pg_ctl` applies: the Administrators and Power Users SIDs become deny-only, every privilege except the ones PostgreSQL keeps is deleted, and the current user is re-added to the token's default DACL so the postmaster's own child processes remain creatable. The exact process handle from `CreateProcessAsUserW` stays the retained lease, preserving exact-handle fast shutdown, retry-after-timeout ownership, and release-without-kill semantics. Non-administrative Windows accounts keep the previous spawn path unchanged, and Unix privilege handling is untouched.
- Preserved log-file stdout/stderr and closed stdin on regular Windows launches, released the child thread handle after each retained spawn, and honored Unicode case-insensitive environment overrides. Restricted launches now clean up partially acquired standard handles and propagate failed process observations instead of reporting the process as still running.
- Preserved executable lookup through `PATH` and relative paths for administrative Windows Postgres launches, including child environment overrides. Embedded NUL characters in launch paths, arguments, or environment entries are rejected before a process starts instead of truncating inputs or injecting environment variables.
- Fixed `.cmd` and `.bat` launchers with arguments on administrative Windows accounts, including paths with spaces. Restored batch-specific argument quoting and unsafe-input rejection without changing reduced privileges or direct `postgres.exe` launches.
- Preserved ordinary argument quoting for explicit Windows command interpreters and safe `\\?\` working-directory handling on administrative launches. Concurrent restricted retained children inherit only their selected standard streams, and unrelated concurrent commands cannot keep those log files open after their owners finish.

## [0.9.19-alpha.2] - 2026-09-08

### Added

- Added replay-safe model and reasoning activity reports and retained model and thinking fields on task snapshots, including settled tasks.
- Added an environment-local `TaskSupervisor` actor with owner-sealed admission, stable task/attempt identities, replay-safe reports, observation waits, cancellation and independently acknowledged cleanup. Generated bindings expose atomic snapshot subscriptions with a byte-bounded event journal; total task/report history and output storage are not bounded by this journal ([#2884](https://github.com/bastani-inc/atomic/pull/2884)).
- Added supervised Unix pipe/PTY commands with process-group cleanup, observation-independent execution deadlines, replay-safe byte-credit stdin, resize and retained output paging. Drained output stays live beyond its cap; background file-spool overflow settles `OutputLimitExceeded` ([#2884](https://github.com/bastani-inc/atomic/pull/2884)).
- Added Windows pipe task containment with suspended launch, explicit inherited handles and kill-on-close Job Objects. Assignment failure refuses execution and confirms suspended-process cleanup; failed cleanup retains diagnostic resources. Supervised Windows PTY remains unavailable ([#2884](https://github.com/bastani-inc/atomic/pull/2884)).
- Added a read-only `taskSettlement` query for authentic terminal receipts, including cancellation, so hosts can recover completion delivery after journal resets without registering another wait. Task snapshots retain `wasBackground` after a designated wait yields, including after settlement.
- Added supervised Windows ConPTY commands with suspended launch, Job Object containment before resume, retained output and confirmed cleanup. Containment failure refuses execution without an unsupervised fallback.
- Added optional `CommandIntent.shell: { program, args }` for direct executable launch with the command as one final argv argument, and `inheritEnv` (default `true`; `false` uses exactly the supplied environment). Both participate in operation replay identity; the default native pipe shell is unchanged.

### Changed

- Raised the minimum supported Bun runtime to 1.4.2.

### Fixed

- Enforced the task file cap through shared supervised pipe draining on Unix and Windows, preventing stdout/stderr and descendant writes from bypassing the budget. Output page requests are clamped to 1 MiB before allocation ([#2905](https://github.com/bastani-inc/atomic/pull/2905)).
- Preserved numeric task wait budgets above the u32 range and fractional milliseconds; timer scheduling no longer wraps `4294967296` ms into an immediate yield ([#2884](https://github.com/bastani-inc/atomic/pull/2884)).
- Preserved completed/failed task exit-code numbers without i32 narrowing, including unsigned statuses, fractional values and negative zero; exact terminal replay no longer collapses distinct numeric inputs ([#2884](https://github.com/bastani-inc/atomic/pull/2884)).
- Preserved exact activity metric replay for `elapsedMs`, `toolCount` and `tokenCount`: identical NaN reports acknowledge once, while changed signed zero or omitted/present fields conflict without normalizing values ([#2884](https://github.com/bastani-inc/atomic/pull/2884)).
- Preserved S1 caller strings losslessly across owner scopes, launch/report identity, activity, results and nested output/cleanup metadata; unpaired UTF-16 surrogates no longer become replacement characters or collapse distinct replays ([#2884](https://github.com/bastani-inc/atomic/pull/2884)).
- Bounded S1 activity replay identity to the latest 256 accepted IDs with SHA-256 payload hashes instead of retaining full report history. Evicted IDs are fresh reports subject to lifecycle guards; terminal reports and receipts remain retained for the task record's lifetime ([#2884](https://github.com/bastani-inc/atomic/pull/2884)).
- Allocated trusted S1 runner terminal identities atomically against the bounded activity window, so caller report IDs cannot consume the runner's settlement identity. Caller outcome conflicts, immutable terminal replay and cancellation precedence remain unchanged ([#2884](https://github.com/bastani-inc/atomic/pull/2884)).
- Prevented accepted `NaN` task wait budgets from panicking the native timer. Such waits use bounded sleep chunks until another observation or lifecycle action finishes them; finite budgets and infinities retain their existing behavior ([#2884](https://github.com/bastani-inc/atomic/pull/2884)).
- Retry transient macOS permission errors while checking whether a terminated process group has disappeared, within the existing cleanup deadline. Unreaped zombies no longer cause immediate cleanup failure; persistent refusals still fail closed.

## [0.9.16] - 2026-08-29

Cumulative release of the `0.9.16-alpha.1` prerelease. The summary below covers the user-visible outcome of that work; the per-change detail remains in the prerelease section below.

### Added

- Added the opaque retained-Postgres lease used by workflow durability: direct log-redirected spawn, Unix uid/gid ownership with inherited supplementary groups cleared before a root privilege drop, process-instance-safe PostgreSQL fast shutdown on Unix and Windows, bounded wait/reap, retry retention after timeout, and explicit release without termination ([#2544](https://github.com/bastani-inc/atomic/pull/2544) by [@darionco](https://github.com/darionco)).

## [0.9.16-alpha.1] - 2026-08-23

### Added

- Added the opaque retained-Postgres lease used by workflow durability: direct log-redirected spawn, Unix uid/gid ownership with inherited supplementary groups cleared before a root privilege drop, process-instance-safe PostgreSQL fast shutdown on Unix and Windows, bounded wait/reap, retry retention after timeout, and explicit release without termination ([#2544](https://github.com/bastani-inc/atomic/pull/2544) by [@darionco](https://github.com/darionco)).

## [0.9.13] - 2026-08-13

Cumulative release of the `0.9.13-alpha.1` prerelease. The summary below covers the user-visible outcome of that work; the per-change detail remains in the prerelease section below.

### Added

- Added the Rust `SubagentControl` N-API surface that backs Atomic's in-process subagents: canonical child identities, RAII spawn reservations, turn-scoped execution guards, LRU residency, status watches, and an explicit 100 ms interruption grace ([#2188](https://github.com/bastani-inc/atomic/issues/2188)).

### Changed

- Child termination is awaitable across the N-API boundary, so the 100 ms cooperative grace no longer blocks the JavaScript thread, and termination causes are reported on child identities and status-watch updates ([#2188](https://github.com/bastani-inc/atomic/issues/2188)).
- Generated N-API string enums are literal TypeScript unions, so strict isolated-module consumers can use subagent statuses and causes without ambient const-enum errors ([#2188](https://github.com/bastani-inc/atomic/issues/2188)).

## [0.9.13-alpha.1] - 2026-08-05

### Added

- Added the Rust `SubagentControl` N-API surface with canonical child identities, RAII spawn reservations, turn-scoped execution guards, LRU residency, status watches, and explicit 100 ms interruption grace for in-process subagents ([#2188](https://github.com/bastani-inc/atomic/issues/2188)).

### Changed

- Generated N-API string-enum declarations as literal TypeScript unions so strict isolated-module consumers can use subagent statuses and causes without ambient const-enum errors ([#2188](https://github.com/bastani-inc/atomic/issues/2188)).
- Made child termination awaitable across the N-API boundary so the literal 100 ms cooperative grace does not block the JavaScript thread, and exposed termination causes on child identities and status-watch updates ([#2188](https://github.com/bastani-inc/atomic/issues/2188)).

## [0.9.12] - 2026-08-04

### Changed

- Released with Atomic 0.9.12. No native transport changes were made after 0.9.11; the package is published in sync so `@bastani/atomic` resolves a matching `@bastani/atomic-natives` version.

## [0.9.11] - 2026-08-03

### Removed

- Removed the Cursor-specific HTTP/2 native transport, its generated N-API exports, transport-only dependencies, metadata, and attribution ([#1994](https://github.com/bastani-inc/atomic/issues/1994)).

## [0.9.11-alpha.6] - 2026-07-28

### Removed

- Removed the Cursor-specific HTTP/2 native transport, generated N-API exports, transport-only dependencies, metadata, and attribution ([#1994](https://github.com/bastani-inc/atomic/issues/1994)).

## [0.9.11-alpha.1] - 2026-07-20

### Changed

- Published a synchronized Atomic 0.9.11-alpha.1 prerelease for the native transport package; no native transport changes were made after 0.9.9.

## [0.9.10] - 2026-07-20

### Changed

- Published the stable Atomic 0.9.10 release for the native transport package; no native transport changes were made after 0.9.9.

## [0.9.10-alpha.1] - 2026-07-19

### Changed

- Published a synchronized Atomic 0.9.10-alpha.1 prerelease for the native transport package; no native transport changes were made after 0.9.9.

## [0.9.9] - 2026-07-15

### Changed

- Refreshed the native Rust lockfile to `rustls` 0.23.42, `bytes` 1.12.1, Rust `ignore` 0.4.28, `napi-derive` 3.5.10 (with `napi-derive-backend` 5.1.2), and `tree-sitter` 0.26.11; no native API or source changes were required.

## [0.9.9-alpha.4] - 2026-07-15

### Changed

- Published a synchronized Atomic 0.9.9-alpha.4 prerelease for the native transport package; no native transport changes were made after 0.9.9-alpha.3.

## [0.9.9-alpha.3] - 2026-07-14

### Changed

- Published a synchronized Atomic 0.9.9-alpha.3 prerelease for the native transport package; no native transport changes were made after 0.9.9-alpha.2.

## [0.9.9-alpha.2] - 2026-07-14

### Changed

- Refreshed the native Rust lockfile to `rustls` 0.23.42, `bytes` 1.12.1, Rust `ignore` 0.4.28, `napi-derive` 3.5.10 (with `napi-derive-backend` 5.1.2), and `tree-sitter` 0.26.11; no native API or source changes were required.

## [0.9.9-alpha.1] - 2026-07-14

### Changed

- Published a synchronized Atomic 0.9.9-alpha.1 prerelease for the native transport package; no native transport changes were made after 0.9.8.

## [0.9.8] - 2026-07-12

### Changed

- Published the stable Atomic 0.9.8 release for the native transport package; no native transport changes were made after 0.9.7.

## [0.9.8-alpha.1] - 2026-07-12

### Changed

- Published a synchronized Atomic 0.9.8-alpha.1 prerelease for the native transport package; no native transport changes were made after 0.9.7.

## [0.9.7] - 2026-07-12

### Changed

- Published the stable Atomic 0.9.7 release for the native transport package; no native transport changes were made after 0.9.6.

## [0.9.7-alpha.1] - 2026-07-12

### Changed

- Published a synchronized Atomic 0.9.7-alpha.1 prerelease for the native transport package; no native transport changes were made after 0.9.6.

## [0.9.6] - 2026-07-12

### Changed

- Published the stable Atomic 0.9.6 release for the native transport package; no native transport changes were made after 0.9.5.

## [0.9.6-alpha.1] - 2026-07-12

### Changed

- Published a synchronized Atomic 0.9.6-alpha.1 prerelease for the native transport package; no native transport changes were made after 0.9.5.

## [0.9.5] - 2026-07-11

### Changed

- Published the stable Atomic 0.9.5 release for the native transport package; no native transport changes were made after 0.9.4.

## [0.9.5-alpha.10] - 2026-07-11

### Changed

- Published a synchronized Atomic 0.9.5-alpha.10 prerelease for the native transport package; no native transport changes were made after 0.9.4.

## [0.9.4] - 2026-07-03

### Changed

- Published the stable Atomic 0.9.4 release for the native transport package; no native transport changes were made after 0.9.3.

## [0.9.4-alpha.6] - 2026-07-01

### Changed

- Published a synchronized Atomic 0.9.4-alpha.6 prerelease for the native transport package; no native transport changes were made after 0.9.4-alpha.1.

## [0.9.4-alpha.5] - 2026-07-01

### Changed

- Published a synchronized Atomic 0.9.4-alpha.5 prerelease for the native transport package; no native transport changes were made after 0.9.4-alpha.1.

## [0.9.4-alpha.4] - 2026-06-30

### Changed

- Published a synchronized Atomic 0.9.4-alpha.4 prerelease for the native transport package; no native transport changes were made after 0.9.4-alpha.1.

## [0.9.4-alpha.3] - 2026-06-30

### Changed

- Published a synchronized Atomic 0.9.4-alpha.3 prerelease for the native transport package; no native transport changes were made after 0.9.4-alpha.1.

## [0.9.4-alpha.1] - 2026-06-29

### Changed

- Published a synchronized Atomic 0.9.4-alpha.1 prerelease for the native transport package; no native transport changes were made after 0.9.3.

## [0.9.3] - 2026-06-29

### Added

- Added a Rust-backed `PtySession` N-API surface using `portable-pty`, enabling Atomic `bash` calls with `pty: true` to run through a real PTY/ConPTY with streaming output, resize, kill, timeout, cwd, shell, and environment support.
- Added native `glob`, `grep`, in-memory `search`, `hasMatch`, and filesystem scan-cache invalidation bindings for Atomic's full-level `find`/`search` tool parity.

### Changed

- Refreshed the native build toolchain and transitive Rust dependencies, including `@napi-rs/cli` 3.7.2, `rustls` 0.23.41, `napi` 3.9.4, `bytes` 1.12.0, and `webpki-roots` 1.0.8.

## [0.9.3-alpha.6] - 2026-06-29

### Changed

- Published a synchronized Atomic 0.9.3-alpha.6 prerelease for the native transport package; no native transport changes were made after 0.9.3-alpha.5.

## [0.9.3-alpha.5] - 2026-06-28

### Changed

- Bumped the native build toolchain devDependency `@napi-rs/cli` from 3.7.0 to 3.7.2 (includes the Node 12-compatible CJS binding-loader fix and an esbuild 0.28.1 security update), and refreshed transitive Cargo crates used by the `@bastani/atomic-natives` Rust build: `rustls` 0.23.40 → 0.23.41, `napi` 3.9.2 → 3.9.4, `bytes` 1.11.1 → 1.12.0, and `webpki-roots` 1.0.7 → 1.0.8 (the latter removing the Mozilla-deprecated `SecureSign Root CA12` root). No native transport source changes were needed.

## [0.9.3-alpha.4] - 2026-06-28

### Changed

- Published a synchronized Atomic 0.9.3-alpha.4 prerelease for the native transport package; no native transport changes were made after 0.9.3-alpha.3.

## [0.9.3-alpha.3] - 2026-06-27

### Changed

- Published a synchronized Atomic 0.9.3-alpha.3 prerelease for the native transport package; no native transport changes were made after 0.9.3-alpha.1.

## [0.9.3-alpha.1] - 2026-06-25

### Added

- Added a Rust-backed `PtySession` N-API surface using `portable-pty`, enabling Atomic's `bash` tool to execute `pty: true` calls through a real PTY/ConPTY with output streaming, resize, kill, timeout, shell, cwd, and environment support ([#1483](https://github.com/bastani-inc/atomic/issues/1483)).
- Added oh-my-pi-derived native `glob`, `grep`, in-memory `search`, `hasMatch`, and filesystem scan-cache invalidation N-API bindings for Atomic's full-level `find`/`search` tool parity, backed by the Rust `ignore`, `globset`, and ripgrep crates ([#1483](https://github.com/bastani-inc/atomic/issues/1483)).

## [0.9.2] - 2026-06-23

### Changed

- Published the stable Atomic 0.9.2 release for the native transport package; no functional native transport changes were made after 0.9.1.

## [0.9.2-alpha.1] - 2026-06-23

### Changed

- Published a synchronized Atomic 0.9.2-alpha.1 prerelease for the native transport package; no functional native transport changes were made after 0.9.1.

## [0.9.1] - 2026-06-23

### Changed

- Published the stable Atomic 0.9.1 release for the native transport package; no functional native transport changes were made after 0.9.0.

## [0.9.1-alpha.1] - 2026-06-22

### Changed

- Published a synchronized Atomic 0.9.1-alpha.1 prerelease for the native transport package; no functional native transport changes were made after 0.9.0.

## [0.9.0] - 2026-06-22

### Changed

- Published the stable Atomic 0.9.0 release for the native transport package; no functional native transport changes were made after the 0.9.0 prerelease line.
- Changed contributor validation to include the monorepo-wide file-length gate for tracked TS/JS/Rust files in local `prek` hooks and PR CI, with only documented generated/vendored exclusions and no grandfathered baseline allowlist.

## [0.9.0-alpha.2] - 2026-06-21

### Changed

- Published a synchronized Atomic 0.9.0-alpha.2 prerelease; no functional native transport changes were made after 0.9.0-alpha.1.

## [0.9.0-alpha.1] - 2026-06-20

### Changed

- Published a synchronized Atomic 0.9.0-alpha.1 prerelease; no functional native transport changes were made after 0.8.30.
- Changed contributor validation to include the monorepo-wide file-length gate for tracked TS/JS/Rust files in local `prek` hooks and PR CI, with only documented generated/vendored exclusions and no grandfathered baseline allowlist ([#1445](https://github.com/bastani-inc/atomic/issues/1445)).

## [0.8.30] - 2026-06-17

### Changed

- Published a synchronized Atomic 0.8.30 stable release; no functional native transport changes were made after 0.8.29.

## [0.8.29] - 2026-06-15

### Added

- Added the initial `@bastani/atomic-natives` NAPI-RS package with a Cursor HTTP/2 native transport binding.

### Changed

- Updated the prerelease publishing pipeline to build native NAPI artifacts on architecture-matched Blacksmith and macOS runners and publish `@bastani/atomic-natives` as the runtime dependency that `@bastani/atomic` consumes for bundled native transports.
