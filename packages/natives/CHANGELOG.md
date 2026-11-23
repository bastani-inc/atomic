# Changelog

## [Unreleased]

## [0.10.5-alpha.1] - 2026-11-23

### Added

- `containProcessTreeAllowingBreakaway(pid)`: on Windows, puts process `pid` into a kill-on-close Job object with `JOB_OBJECT_LIMIT_BREAKAWAY_OK`, so descendants that explicitly ask to leave the job (`CREATE_BREAKAWAY_FROM_JOB`) can start and outlive it while non-breakaway descendants remain contained and end on `terminate()`. `release()` clears kill-on-close while keeping `JOB_OBJECT_LIMIT_BREAKAWAY_OK`. Returns `null` off Windows ([#6445](https://github.com/bastani-inc/atomic/pull/6445)).
- `HeldProcessDescendants.endDescendants()`: ends only the held descendants while keeping the root handle intact so a process cleaning up its own tree can terminate verified descendants before ending itself ([#6477](https://github.com/bastani-inc/atomic/pull/6477)).
- `holdWindowsProcessExit(pid, expectedCreated?)`: on Windows, opens and holds a creation-time-, parent-, and sequence-verified handle to a direct child process so callers can detect termination (`WaitForSingleObject`) and read the child's exact 32-bit exit status (`GetExitCodeProcess`, including exit code `259`) via `WindowsProcessExitHandle.pollExit()` until `close()` or drop. Returns `null` off Windows or when verification fails ([#6484](https://github.com/bastani-inc/atomic/pull/6484)).

### Fixed

- Windows native process helpers (`processCreationTime`, `terminateProcessCreatedAt`, `holdProcessDescendants`, `containProcessTree`, `containProcessTreeAllowingBreakaway`, `holdWindowsProcessExit`, and `watchHostProcess`) now verify `GetProcessId(handle) == pid` after `OpenProcess`, so unaligned process IDs never silently alias and inspect or terminate a running process at `pid & ~3` ([#6498](https://github.com/bastani-inc/atomic/pull/6498)).

## [0.10.4] - 2026-11-22

### Breaking Changes

- Removed `blockRangeAt` (`BlockRange`, `BlockRangeOptions`) and its bundled `tree-sitter` language grammars, which have had no caller since 0.9.72 replaced hashline editing with exact-text editing ([#6381](https://github.com/bastani-inc/atomic/pull/6381)).

### Added

- `signalIgnored(signal)`: whether this process ignores a signal, as a process started under `nohup` ignores `SIGHUP`; `null` on Windows ([#6178](https://github.com/bastani-inc/atomic/pull/6178)).
- `watchSessionEnd(onEnd)`: on Windows, a hidden top-level window that hears the end of the user's session (sign-out, restart or shutdown), calls `onEnd` with how many milliseconds ago Windows said so, and keeps Windows waiting while the process shuts down: until `onEnd` returns false, the process exits, or 4.5 seconds have passed. Elsewhere it does nothing ([#6187](https://github.com/bastani-inc/atomic/pull/6187)).
- `startHostProcess` takes `endWithParent`: the process gets `SIGKILL` when the process that started it ends, however it ends; not the processes it starts.
- `terminateProcessCreatedAt(pid, created, descendants)`: on Windows, ends the running process `pid` only if it was created at `created`, as `processCreationTime` reads it, and with `descendants` what it started, each through a handle checked before anything is ended; `null` when `pid` names no such process, and off Windows. It takes a process as one `pid` started only while the parent id its own handle reports is its parent's and the kernel's order of process starts puts it after that parent, never by the system clock; on a Windows that does not report that order (before Windows 10), only `pid` itself ends ([#6288](https://github.com/bastani-inc/atomic/pull/6288)).
- `holdProcessDescendants(pid)`: on Windows, holds a running child process and the processes it started, and those they started, each through a handle of its own, taken only while it is still its parent's child and started after it (by the kernel's order of process starts, not by a clock), so a process given one of their ids is never held. `endAll()` ends the child and then them, only if it ended the child, so what a child that exited by itself left keeps running; `release()` lets go of them. `null` once the child has exited and elsewhere.
- `nativeVersion()`: the Atomic release the native module was built for (`0.0.0` from a source checkout) ([#6319](https://github.com/bastani-inc/atomic/pull/6319)).

### Changed

- The package no longer includes the native binaries of every platform: each platform's binary comes from its own optional package (`@bastani/atomic-natives-<platform>`), which package managers install for the platform they run on. When the binary cannot load, the error says why instead of blaming an npm bug: which platform package an install that omitted optional dependencies left out and how to reinstall with it, an installed platform package that fails to load and its reason, a platform with no published package, or a `NAPI_RS_NATIVE_LIBRARY_PATH` override that fails.
- Removing the unused `tree-sitter` grammars and unused network dependencies cuts the native module by about 72 to 74% (on Linux x64 glibc and musl from 18.2 to 18.4 MiB to 4.7 MiB unpacked and 3.6 MiB to 2.0 MiB compressed; on Windows x64 from 18.3 MiB to 5.2 MiB unpacked and 3.6 MiB to 2.1 MiB compressed) with no regression in search, glob, lock or process-tree performance ([#6381](https://github.com/bastani-inc/atomic/pull/6381)).
- `processCreationTime(pid)` also reads a process's start on macOS, also of a process another user owns, to the microsecond, as 100-nanosecond intervals since 1601 like the Windows creation time. It still answers `null` on Linux ([#6394](https://github.com/bastani-inc/atomic/pull/6394)).

## [0.10.4-alpha.2] - 2026-11-22

### Breaking Changes

- Removed `blockRangeAt` (`BlockRange`, `BlockRangeOptions`) and its bundled `tree-sitter` language grammars, which have had no caller since 0.9.72 replaced hashline editing with exact-text editing ([#6381](https://github.com/bastani-inc/atomic/pull/6381)).

### Added

- `nativeVersion()`: the Atomic release the native module was built for (`0.0.0` from a source checkout) ([#6319](https://github.com/bastani-inc/atomic/pull/6319)).

### Changed

- Removing the unused `tree-sitter` grammars and unused network dependencies cuts the native module by about 72 to 74% (on Linux x64 glibc and musl from 18.2 to 18.4 MiB to 4.7 MiB unpacked and 3.6 MiB to 2.0 MiB compressed; on Windows x64 from 18.3 MiB to 5.2 MiB unpacked and 3.6 MiB to 2.1 MiB compressed) with no regression in search, glob, lock or process-tree performance ([#6381](https://github.com/bastani-inc/atomic/pull/6381)).
- `processCreationTime(pid)` also reads a process's start on macOS, also of a process another user owns, to the microsecond, as 100-nanosecond intervals since 1601 like the Windows creation time. It still answers `null` on Linux ([#6394](https://github.com/bastani-inc/atomic/pull/6394)).

### Fixed

- `terminateProcessCreatedAt(pid, created, descendants)` takes a process as one `pid` started only while the parent id its own handle reports is its parent's and the kernel's order of process starts puts it after that parent. It compared creation times on the system clock, so a clock set back, or two processes created within one tick, could end an older process that had nothing to do with `pid`. On a Windows that does not report that order (before Windows 10), only `pid` itself ends ([#6288](https://github.com/bastani-inc/atomic/pull/6288)).

## [0.10.4-alpha.1] - 2026-11-22

### Added

- `signalIgnored(signal)`: whether this process ignores a signal, as a process started under `nohup` ignores `SIGHUP`; `null` on Windows ([#6178](https://github.com/bastani-inc/atomic/pull/6178)).
- `watchSessionEnd(onEnd)`: on Windows, a hidden top-level window that hears the end of the user's session (sign-out, restart or shutdown), calls `onEnd` with how many milliseconds ago Windows said so, and keeps Windows waiting while the process shuts down: until `onEnd` returns false, the process exits, or 4.5 seconds have passed. Elsewhere it does nothing ([#6187](https://github.com/bastani-inc/atomic/pull/6187)).
- `startHostProcess` takes `endWithParent`: the process gets `SIGKILL` when the process that started it ends, however it ends; not the processes it starts.
- `terminateProcessCreatedAt(pid, created, descendants)`: on Windows, ends the running process `pid` only if it was created at `created`, as `processCreationTime` reads it, and with `descendants` what it started, each through a handle checked before anything is ended; `null` when `pid` names no such process, and off Windows.
- `holdProcessDescendants(pid)`: on Windows, holds a running child process and the processes it started, and those they started, each through a handle of its own, taken only while it is still its parent's child and started after it (by the kernel's order of process starts, not by a clock), so a process given one of their ids is never held. `endAll()` ends the child and then them, only if it ended the child, so what a child that exited by itself left keeps running; `release()` lets go of them. `null` once the child has exited and elsewhere.

### Changed

- The package no longer includes the native binaries of every platform: each platform's binary comes from its own optional package (`@bastani/atomic-natives-<platform>`), which package managers install for the platform they run on. When the binary cannot load, the error says why instead of blaming an npm bug: which platform package an install that omitted optional dependencies left out and how to reinstall with it, an installed platform package that fails to load and its reason, a platform with no published package, or a `NAPI_RS_NATIVE_LIBRARY_PATH` override that fails.

## [0.10.1] - 2026-11-20

### Added

- `trySharedAdvisoryLockAsync(path, waitMs)`: the shared advisory lock on a worker thread, without blocking the JavaScript event loop ([#5376](https://github.com/bastani-inc/atomic/issues/5376)).

## [0.10.1-alpha.1] - 2026-11-20

### Added

- `trySharedAdvisoryLockAsync(path, waitMs)`: the shared advisory lock on a worker thread, without blocking the JavaScript event loop ([#5376](https://github.com/bastani-inc/atomic/issues/5376)).

## [0.9.90] - 2026-11-19

### Fixed

- On Windows, `TaskSupervisor` no longer reports a command started with `keepBackgroundOnExit` that ran to completion as failed with `Windows stdin worker stop was not confirmed` when a loaded machine has not yet run its input thread by the end of the cleanup grace. Such a command keeps its background processes, so its job never counts as ended and the earlier fix did not apply. An input thread that is not writing is now confirmed once the supervisor closes the command's input under it, which leaves it nothing to write; one blocked in a write still fails the cleanup. A completed command also no longer fails when its idle stdin writer holds the input queue lock past the stop grace; an outstanding pipe write still requires confirmation ([#5512](https://github.com/bastani-inc/atomic/issues/5512), [#5702](https://github.com/bastani-inc/atomic/issues/5702))
- Windows clock probes use the host runtime’s creation mask. If removing a pool record’s temporary hard link is refused, cleanup retries only if both names still identify the file pinned before publication ([#5605](https://github.com/bastani-inc/atomic/issues/5605), [#5636](https://github.com/bastani-inc/atomic/issues/5636)).

## [0.9.90-alpha.1] - 2026-11-19

### Fixed

- On Windows, `TaskSupervisor` no longer reports a command started with `keepBackgroundOnExit` that ran to completion as failed with `Windows stdin worker stop was not confirmed` when a loaded machine has not yet run its input thread by the end of the cleanup grace. Such a command keeps its background processes, so its job never counts as ended and the earlier fix did not apply. An input thread that is not writing is now confirmed once the supervisor closes the command's input under it, which leaves it nothing to write; one blocked in a write still fails the cleanup. A completed command also no longer fails when its idle stdin writer holds the input queue lock past the stop grace; an outstanding pipe write still requires confirmation ([#5512](https://github.com/bastani-inc/atomic/issues/5512), [#5702](https://github.com/bastani-inc/atomic/issues/5702))
- Windows clock probes use the host runtime’s creation mask. If removing a pool record’s temporary hard link is refused, cleanup retries only if both names still identify the file pinned before publication ([#5605](https://github.com/bastani-inc/atomic/issues/5605), [#5636](https://github.com/bastani-inc/atomic/issues/5636)).

## [0.9.89] - 2026-11-18

### Added

- `tryAdvisoryLockAsync` and `renameNoReplaceAsync`: the advisory lock and the non-replacing rename on a worker thread, without blocking the JavaScript event loop
- Added `pendingStdinInput()`: how much input waits unread on standard input, as bytes on Unix and as input events for a Windows console, or `null` where the operating system cannot say without waiting, such as for a Windows pipe ([#5241](https://github.com/bastani-inc/atomic/issues/5241))
- Added `windowsDirectorySecurity(path)`: on Windows, reads a file or directory's owner SID, its DACL in SDDL form and the SID of each allow and deny entry, along with the current user's SID, without starting a process. It returns `null` where the descriptor cannot be read, and on other platforms. `windowsDirectorySecurityAsync(path)` reads a directory's security descriptor on a native worker without blocking the caller ([#5324](https://github.com/bastani-inc/atomic/issues/5324)).
- Added `trySharedAdvisoryLock(path, waitMs)`: takes a shared operating-system advisory lock on `path` (`flock` on Unix, `LockFileEx` on Windows), waiting up to `waitMs` while an exclusive holder keeps it, and returns an `AdvisoryLock` or `null`. Both `tryAdvisoryLock` and `trySharedAdvisoryLock` reopen `path` when the file was unlinked while acquiring the lock, and treat a delete-pending file on Windows as contention until `waitMs` expires. Permanent access errors still throw, and repeated path replacement does not extend the wait ([#5317](https://github.com/bastani-inc/atomic/issues/5317)).

### Fixed

- On Windows, `tryAdvisoryLock`, `tryAdvisoryLockAsync` and `trySharedAdvisoryLock` no longer throw `Access is denied` when another process removes the lock file while they open or lock it. A refusal that the removal explains is retried, a bounded number of times in a row, before it counts as a real permission error ([#5317](https://github.com/bastani-inc/atomic/issues/5317)).
- On Windows, `TaskSupervisor` no longer reports a command that ran to completion as failed with `Windows stdin worker stop was not confirmed` when its input thread, on a loaded or briefly stalled machine, closed the command's stdin just after the cleanup grace or ended later than it. A stop the thread reported counts as confirmed; one it never reports still fails the cleanup. On a busy Windows machine, a supervised command that ran to completion, such as a Git command of a named worktree, also no longer fails this way when its input thread has not run yet by the time the command's processes have all ended. Nothing reads that input any more, so the thread ends on its own; a command with processes still running fails as before ([#5340](https://github.com/bastani-inc/atomic/pull/5340), [#5202](https://github.com/bastani-inc/atomic/issues/5202), [#5450](https://github.com/bastani-inc/atomic/pull/5450))

## [0.9.89-alpha.2] - 2026-11-18

### Fixed

- On a busy Windows machine, a supervised command that ran to completion, such as a Git command of a named worktree, no longer fails with `Windows stdin worker stop was not confirmed` when its input thread has not run yet by the time the command's processes have all ended. Nothing reads that input any more, so the thread ends on its own; a command with processes still running fails as before ([#5202](https://github.com/bastani-inc/atomic/issues/5202))

## [0.9.89-alpha.1] - 2026-11-18

### Added

- `tryAdvisoryLockAsync` and `renameNoReplaceAsync`: the advisory lock and the non-replacing rename on a worker thread, without blocking the JavaScript event loop
- Added `pendingStdinInput()`: how much input waits unread on standard input, as bytes on Unix and as input events for a Windows console, or `null` where the operating system cannot say without waiting, such as for a Windows pipe ([#5241](https://github.com/bastani-inc/atomic/issues/5241))
- Added `windowsDirectorySecurity(path)`: on Windows, reads a file or directory's owner SID, its DACL in SDDL form and the SID of each allow and deny entry, along with the current user's SID, without starting a process. It returns `null` where the descriptor cannot be read, and on other platforms. `windowsDirectorySecurityAsync(path)` reads a directory's security descriptor on a native worker without blocking the caller ([#5324](https://github.com/bastani-inc/atomic/issues/5324)).
- Added `trySharedAdvisoryLock(path, waitMs)`: takes a shared operating-system advisory lock on `path` (`flock` on Unix, `LockFileEx` on Windows), waiting up to `waitMs` while an exclusive holder keeps it, and returns an `AdvisoryLock` or `null`. Both `tryAdvisoryLock` and `trySharedAdvisoryLock` reopen `path` when the file was unlinked while acquiring the lock, and treat a delete-pending file on Windows as contention until `waitMs` expires. Permanent access errors still throw, and repeated path replacement does not extend the wait ([#5317](https://github.com/bastani-inc/atomic/issues/5317)).

### Fixed

- On Windows, `tryAdvisoryLock`, `tryAdvisoryLockAsync` and `trySharedAdvisoryLock` no longer throw `Access is denied` when another process removes the lock file while they open or lock it. A refusal that the removal explains is retried, a bounded number of times in a row, before it counts as a real permission error ([#5317](https://github.com/bastani-inc/atomic/issues/5317)).
- On Windows, `TaskSupervisor` no longer reports a command that ran to completion as failed with `Windows stdin worker stop was not confirmed` when its input thread, on a loaded or briefly stalled machine, closed the command's stdin just after the cleanup grace or ended later than it. A stop the thread reported counts as confirmed; one it never reports still fails the cleanup ([#5340](https://github.com/bastani-inc/atomic/pull/5340))

## [0.9.88] - 2026-11-16

### Added

- Added `tryAdvisoryLock(path, waitMs)`: takes the exclusive operating-system advisory lock of a file (`flock` on Unix, `LockFileEx` on Windows), created when missing and never removed, waiting up to `waitMs` while another holder keeps it, and returns an `AdvisoryLock` whose `release()` gives it up, or `null`. The kernel releases it when its holder dies. On Unix, new lock files are readable and writable only by their owner. Added `renameNoReplace(from, to)`, a rename that returns `false` and moves nothing when anything is at `to` ([#5193](https://github.com/bastani-inc/atomic/issues/5193)).
- Added `CommandResourceOptions.keepBackgroundOnExit`: when `true`, `TaskSupervisor.startCommandTask` leaves backgrounded descendant processes running when the command leader exits on its own, including processes that write to stdout or stderr later; cancellation, owner close, or host exit still terminates the tree while the leader is running. Added `retainRecordOnStart` to keep a command's record and output available until `releaseTaskRecord`, including when many commands finish before the caller can read their results ([#5202](https://github.com/bastani-inc/atomic/issues/5202)).
- Added `ProcessTreeContainment.release()`: gives the job up without ending the processes still in it, for a caller that ends the tree only when it stops a command.
- Added `containProcessTree(pid)`: on Windows, puts a running process and every process it starts from then on in a kill-on-close job that allows no breakaway, the containment the task supervisor gives its commands, and returns a `ProcessTreeContainment` whose `terminate()` ends them all, `activeProcesses()` counts those still running and `close()` releases the job, ending any left; `null` on other platforms and for a process that is gone or cannot be assigned.
- Added `processCreationTime(pid)`: on Windows, the creation time of a running process, as the decimal count of 100-nanosecond intervals since 1601 UTC; `null` for a process that is gone or cannot be queried, and on other platforms ([#5141](https://github.com/bastani-inc/atomic/issues/5141)).

### Fixed

- Supervised commands on Windows no longer wait for a polling interval after their input worker finishes; stalled workers still have a bounded cleanup wait ([#5202](https://github.com/bastani-inc/atomic/issues/5202)).

## [0.9.88-alpha.1] - 2026-11-16

### Added

- Added `tryAdvisoryLock(path, waitMs)`: takes the exclusive operating-system advisory lock of a file (`flock` on Unix, `LockFileEx` on Windows), created when missing and never removed, waiting up to `waitMs` while another holder keeps it, and returns an `AdvisoryLock` whose `release()` gives it up, or `null`. The kernel releases it when its holder dies. On Unix, new lock files are readable and writable only by their owner. Added `renameNoReplace(from, to)`, a rename that returns `false` and moves nothing when anything is at `to` ([#5193](https://github.com/bastani-inc/atomic/issues/5193)).
- Added `CommandResourceOptions.keepBackgroundOnExit`: when `true`, `TaskSupervisor.startCommandTask` leaves backgrounded descendant processes running when the command leader exits on its own, including processes that write to stdout or stderr later; cancellation, owner close, or host exit still terminates the tree while the leader is running. Added `retainRecordOnStart` to keep a command's record and output available until `releaseTaskRecord`, including when many commands finish before the caller can read their results ([#5202](https://github.com/bastani-inc/atomic/issues/5202)).
- Added `ProcessTreeContainment.release()`: gives the job up without ending the processes still in it, for a caller that ends the tree only when it stops a command.
- Added `containProcessTree(pid)`: on Windows, puts a running process and every process it starts from then on in a kill-on-close job that allows no breakaway, the containment the task supervisor gives its commands, and returns a `ProcessTreeContainment` whose `terminate()` ends them all, `activeProcesses()` counts those still running and `close()` releases the job, ending any left; `null` on other platforms and for a process that is gone or cannot be assigned.
- Added `processCreationTime(pid)`: on Windows, the creation time of a running process, as the decimal count of 100-nanosecond intervals since 1601 UTC; `null` for a process that is gone or cannot be queried, and on other platforms ([#5141](https://github.com/bastani-inc/atomic/issues/5141)).

### Fixed

- Supervised commands on Windows no longer wait for a polling interval after their input worker finishes; stalled workers still have a bounded cleanup wait ([#5202](https://github.com/bastani-inc/atomic/issues/5202)).

## [0.9.72] - 2026-11-08

### Added

- `Cleanup` has a `quarantined` state with the `resources` still unconfirmed: a command's result settled before its process-group exit or output drain was confirmed, and the supervisor keeps confirming in the background. Quarantine has no deadline until the owner closes or the task is stopped; it then ends `reaped`, or `failed` if cleanup is still unconfirmed 15 seconds later ([#4338](https://github.com/bastani-inc/atomic/issues/4338)).
- `TaskEvent` has a `task-evicted` event, and every task door that refused an unknown lease or task id with `UnknownTask` refuses a finished task its owner no longer keeps with `TaskEvicted`. `retainTaskRecord(task)` keeps a task's record past the retention while a host still reads it, until `releaseTaskRecord(task)` ([#4385](https://github.com/bastani-inc/atomic/issues/4385)).

### Changed

- A task owner keeps its 256 most recently finished task records (settled and reaped) instead of every task it admitted, evicting the one that finished longest ago, so a long-lived owner's records stop growing with each finished task. Queued, running and cancelling tasks, tasks whose cleanup is quarantined or failed, and tasks an open owner's host still holds are never evicted; the oldest unheld finished task goes instead. A finished task stays until every live subscription of its owner has drained it and drained again, a settled wait still returns its outcome after eviction, and replaying an evicted task's launch operation admits a new task. Evicting a command deletes its output spool ([#4385](https://github.com/bastani-inc/atomic/issues/4385)).

### Fixed

- A command that exits while a process outside its group still holds its output open, or (on Linux) whose group is slow to exit, now settles with its output and exit status after the drain window instead of failing with `CleanupFailed` and losing both. Its cleanup is quarantined and confirmed in the background; only cleanup still unconfirmed 15 seconds after its owner starts closing, or after a stop, fails, and the settled result stays as it was. On macOS, a process group the system still refuses to probe after the drain window fails as before ([#4338](https://github.com/bastani-inc/atomic/issues/4338)).
- A command that settles ahead of quarantined cleanup closes its output spool descriptor immediately. Its saved output remains readable without keeping a file handle open for the rest of the quarantine ([#4338](https://github.com/bastani-inc/atomic/issues/4338)).

## [0.9.72-alpha.1] - 2026-11-08

### Added

- `Cleanup` has a `quarantined` state with the `resources` still unconfirmed: a command's result settled before its process-group exit or output drain was confirmed, and the supervisor keeps confirming in the background. Quarantine has no deadline until the owner closes or the task is stopped; it then ends `reaped`, or `failed` if cleanup is still unconfirmed 15 seconds later ([#4338](https://github.com/bastani-inc/atomic/issues/4338)).
- `TaskEvent` has a `task-evicted` event, and every task door that refused an unknown lease or task id with `UnknownTask` refuses a finished task its owner no longer keeps with `TaskEvicted`. `retainTaskRecord(task)` keeps a task's record past the retention while a host still reads it, until `releaseTaskRecord(task)` ([#4385](https://github.com/bastani-inc/atomic/issues/4385)).

### Changed

- A task owner keeps its 256 most recently finished task records (settled and reaped) instead of every task it admitted, evicting the one that finished longest ago, so a long-lived owner's records stop growing with each finished task. Queued, running and cancelling tasks, tasks whose cleanup is quarantined or failed, and tasks an open owner's host still holds are never evicted; the oldest unheld finished task goes instead. A finished task stays until every live subscription of its owner has drained it and drained again, a settled wait still returns its outcome after eviction, and replaying an evicted task's launch operation admits a new task. Evicting a command deletes its output spool ([#4385](https://github.com/bastani-inc/atomic/issues/4385)).

### Fixed

- A command that exits while a process outside its group still holds its output open, or (on Linux) whose group is slow to exit, now settles with its output and exit status after the drain window instead of failing with `CleanupFailed` and losing both. Its cleanup is quarantined and confirmed in the background; only cleanup still unconfirmed 15 seconds after its owner starts closing, or after a stop, fails, and the settled result stays as it was. On macOS, a process group the system still refuses to probe after the drain window fails as before ([#4338](https://github.com/bastani-inc/atomic/issues/4338)).
- A command that settles ahead of quarantined cleanup closes its output spool descriptor immediately. Its saved output remains readable without keeping a file handle open for the rest of the quarantine ([#4338](https://github.com/bastani-inc/atomic/issues/4338)).

## [0.9.71] - 2026-11-03

### Fixed

- The task supervisor settles a command as soon as its process group is empty instead of always waiting out the 250 ms termination grace after the command exits. It now reaps the exited shell right after sending its group TERM and probes the group: a group with nobody left settles at once, and members still alive get KILL when the grace ends, as before. A stopped command whose processes exit on TERM settles at once too. On Linux 6.9 and later the group is signalled and probed through a pidfd of the shell (`PIDFD_SIGNAL_PROCESS_GROUP`), so a group ID the kernel has since handed to another process can never receive the KILL; elsewhere the KILL goes through `kill(-pgid)` straight after a probe that found the group alive ([#4268](https://github.com/bastani-inc/atomic/issues/4268)).

## [0.9.71-alpha.1] - 2026-11-03

### Fixed

- The task supervisor settles a command as soon as its process group is empty instead of always waiting out the 250 ms termination grace after the command exits. It now reaps the exited shell right after sending its group TERM and probes the group: a group with nobody left settles at once, and members still alive get KILL when the grace ends, as before. A stopped command whose processes exit on TERM settles at once too. On Linux 6.9 and later the group is signalled and probed through a pidfd of the shell (`PIDFD_SIGNAL_PROCESS_GROUP`), so a group ID the kernel has since handed to another process can never receive the KILL; elsewhere the KILL goes through `kill(-pgid)` straight after a probe that found the group alive ([#4268](https://github.com/bastani-inc/atomic/issues/4268)).

## [0.9.67] - 2026-11-02

### Fixed

- The task supervisor no longer keeps finished shell commands' output in memory until the process exits. A pipe command whose output is all in its spool file keeps no in-memory copy once it settles, and every command of a closed task owner frees its in-memory output. Spooled output still reads back from its file; what only memory held reads as omitted once its owner closed: a terminal (PTY) command's output, which has no spool, and the end of a spool that overflowed its cap or failed to write. Before, each finished command kept up to about 9 MB (its head, tail and foreground buffers) for as long as the process lived, even after the session that ran it closed ([#4218](https://github.com/bastani-inc/atomic/pull/4218)).

## [0.9.67-alpha.1] - 2026-11-02

### Fixed

- The task supervisor no longer keeps finished shell commands' output in memory until the process exits. A pipe command whose output is all in its spool file keeps no in-memory copy once it settles, and every command of a closed task owner frees its in-memory output. Spooled output still reads back from its file; what only memory held reads as omitted once its owner closed: a terminal (PTY) command's output, which has no spool, and the end of a spool that overflowed its cap or failed to write. Before, each finished command kept up to about 9 MB (its head, tail and foreground buffers) for as long as the process lived, even after the session that ran it closed ([#4218](https://github.com/bastani-inc/atomic/pull/4218)).

## [0.9.58] - 2026-11-01

### Fixed

- A cancelled task whose cleanup is reported as failed now settles instead of staying `cancelling` forever. A command settles as failed with code `CleanupUnconfirmed`, naming the cancellation cause and the unconfirmed resources; an agent keeps its `cancelled` result and cause. The cleanup record keeps the failure, and a later confirmed reap still updates it ([#4142](https://github.com/bastani-inc/atomic/pull/4142)).

## [0.9.58-alpha.1] - 2026-11-01

### Fixed

- A cancelled task whose cleanup is reported as failed now settles instead of staying `cancelling` forever. A command settles as failed with code `CleanupUnconfirmed`, naming the cancellation cause and the unconfirmed resources; an agent keeps its `cancelled` result and cause. The cleanup record keeps the failure, and a later confirmed reap still updates it ([#4142](https://github.com/bastani-inc/atomic/pull/4142)).

## [0.9.44] - 2026-10-25

### Fixed

- Task completion ids now include a token unique to the native environment, so a restarted process that numbers its tasks from the start again no longer repeats completion ids already recorded in an earlier process's session history ([#3908](https://github.com/bastani-inc/atomic/issues/3908)).

## [0.9.44-alpha.1] - 2026-10-24

### Fixed

- Task completion ids now include a token unique to the native environment, so a restarted process that numbers its tasks from the start again no longer repeats completion ids already recorded in an earlier process's session history ([#3908](https://github.com/bastani-inc/atomic/issues/3908)).

## [0.9.42] - 2026-10-23

### Fixed

- On macOS, paused managed commands no longer get mistaken for exited commands and terminated before they can resume ([#3869](https://github.com/bastani-inc/atomic/issues/3869)).

## [0.9.42-alpha.1] - 2026-10-23

### Fixed

- On macOS, paused managed commands no longer get mistaken for exited commands and terminated before they can resume ([#3869](https://github.com/bastani-inc/atomic/issues/3869)).

## [0.9.41] - 2026-10-22

### Added

- The task supervisor accepts the `pause` and `quit` cancel causes, for agents stopped resumably.

## [0.9.41-alpha.1] - 2026-10-21

### Added

- The task supervisor accepts the `pause` and `quit` cancel causes, for agents stopped resumably.

## [0.9.23] - 2026-09-27

### Fixed

- Long sessions no longer leak one open file per bash command. A finished command now releases its output file, an output file with no output is deleted, and output files left behind by Atomic processes that have exited are removed. On macOS, where a child process cannot receive a file descriptor numbered 10240 or higher, the leak eventually made every bash call and spawn fail with `Bad file descriptor`; if a spawn still fails that way, the error now names the cause ([#3313](https://github.com/bastani-inc/atomic/issues/3313)).

## [0.9.23-alpha.1] - 2026-09-27

### Fixed

- Long sessions no longer leak one open file per bash command. A finished command now releases its output file, an output file with no output is deleted, and output files left behind by Atomic processes that have exited are removed. On macOS, where a child process cannot receive a file descriptor numbered 10240 or higher, the leak eventually made every bash call and spawn fail with `Bad file descriptor`; if a spawn still fails that way, the error now names the cause ([#3313](https://github.com/bastani-inc/atomic/issues/3313)).

## [0.9.20] - 2026-09-24

### Fixed

- Supervised commands no longer fail when retained output files collide after process IDs are reused; other output-file creation failures now include the operating-system error ([#3105](https://github.com/bastani-inc/atomic/issues/3105)).
- Command output files use timestamped random names and bounded collision retries, preventing retained files from indefinitely delaying startup without overwriting existing output.
- Corrected the binding-target diagnostic type to allow an absent marker when a native override or exports hook returns a non-extensible binding.

## [0.9.20-alpha.4] - 2026-09-20

### Fixed

- Supervised commands no longer fail when retained output files collide after process IDs are reused; other output-file creation failures now include the operating-system error ([#3105](https://github.com/bastani-inc/atomic/issues/3105)).
- Command output files use timestamped random names and bounded collision retries, preventing retained files from indefinitely delaying startup without overwriting existing output.
- Corrected the binding-target diagnostic type to allow an absent marker when a native override or exports hook returns a non-extensible binding.

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
