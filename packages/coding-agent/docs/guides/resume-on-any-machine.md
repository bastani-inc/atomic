---
title: Resume on any machine
description: "Continue a session or workflow run on another machine that shares your storage: what Atomic restores, when it asks, how blueprints set the environment up again, and what each error means."
---

# Resume on any machine

When several machines share one storage database, a session or workflow run started on one machine can continue on any of them. Atomic finds the session in the shared storage, rebuilds the repository state it was working against, and continues the conversation where it stopped.

## Join each machine

Every machine must use the same shared storage. Install the libSQL adapter and join the database on each one:

```bash
atomic install npm:@bastani/atomic-storage-libsql
atomic storage join <url> --token-file <path>
```

`atomic storage join` keeps sessions and workflow runs in the shared database, so both resume on any joined machine. `atomic team join` shares workflow runs and Intercom but keeps sessions on each machine, so with it only workflow runs resume elsewhere; to share sessions on a machine joined that way, run `atomic team leave` and then `atomic storage join`. See [Sharing storage across hosts](/storage#sharing-storage-across-hosts) for prefixes, tokens and `atomic storage status`.

Keep snapshots on (`snapshots.enabled`, the default). A session records the state of each Git checkout it changes at the end of every turn that ran a file-writing tool, including uncommitted edits, untracked files and commits that were never pushed. That record lives in the shared storage, so a joined machine needs nothing else.

## Resume a session

Resume as usual, with `atomic --session <id>`, `atomic --resume` or `/resume`. When the session's checkout is missing or changed on this machine:

- If you start Atomic inside a checkout of the same repository and its files match what the session recorded, the session continues there.
- Otherwise Atomic restores the recorded state into a new worktree under `~/.atomic/agent/worktree-snapshots` and continues there. It never writes into an existing checkout. One line names the new worktree.
- If the recorded state cannot be rebuilt exactly, for example because unpushed commits touch files that are never recorded (`.env`, keys), a remote is unreachable, or a snapshot blob is missing, the session still opens with its whole conversation. Atomic restores the best state it can reach: the recorded commit with the uncommitted changes that apply, else the closest commit it can fetch (the last pushed commit, an earlier snapshot's commit, or the branch tip), else nothing, and then the session continues in its recorded directory, or in the directory you started from when that is not on this machine. One notice says what was restored, what is missing and what to do, for example push the missing commits from the original machine and `/resume` again. `/session snapshot` shows the same. See [Resuming](/worktree-snapshots#resuming).
- To see where a slow resume spent its time, run `/session snapshot`: its **Last resume** block lists each restore phase (fetch, materialize, LFS, verify, …) and each blueprint step with its duration. `ATOMIC_TIMING=1 atomic --session <id>` prints the same lines to stderr. See [Inspecting snapshots](/worktree-snapshots#inspecting-snapshots).
- If you start `atomic` inside a checkout of the same repository that differs from the recording and has uncommitted or untracked changes, Atomic asks whether to restore a fresh worktree (the default), continue in your checkout as it is, or cancel. `/resume` and non-interactive modes such as `-p` do not ask; they restore a fresh worktree. A clean checkout that differs, such as a fresh clone at another commit, is left alone without asking, and a fresh worktree is restored. A checkout where the recorded edits were committed counts as matching.
- A session that worked in several checkouts gets each of them back where it can, also when it worked from a directory outside all of them: the checkout you started in is used for its repository, and every other recorded checkout that is missing here is restored. Only the checkout the session works in has to be restorable. Any other checkout that is missing or changed never stops the resume: one the session worked in on this machine (a sibling worktree, for example) and that changed since continues as it is, and one that cannot be restored is left out. Each checkout that is left out or kept as it is gets a warning that names its path and why, for example `Continuing without restoring /tmp/probe (snapshot 3f2a9c1d7b04): it does not exist on this node, and Git is unavailable here (not-installed), which restoring it needs`. If you choose to continue in a checkout that differs, the other checkouts are not restored, and a warning names those that are missing here.

Absolute paths from the earlier machine keep working: a tool call that names a file under the old checkout opens the same file in the restored worktree. Shell commands are run as written, so a command that names an old absolute path needs the new one.

A `--session` id whose recorded directory does not exist on this machine, or that a restore moved to the current directory, opens directly instead of offering to fork the session into the current directory.

An SDK `createAgentSession({ sessionManager })` call prepares a supplied session the same way before it starts, unless you pass `cwd` or `workspace`. That includes a session whose recorded directory exists on this machine but holds a different tree, for example a runner built from the same image: the session continues in a restored worktree, not in that directory.

When the shared storage does not answer, `atomic --session`, `--resume`, `--continue` and `/resume` stop after 15 seconds with a retryable `ResumeCatalogTimeoutError` instead of waiting for the network to give up. Nothing was changed; resume again once `atomic storage status` reaches the database.

## Wake a released subagent

A background subagent that was released while it waited keeps its session in the shared storage when it was launched with `context: "fork"`, so it can be woken on another machine. The wake maps its recorded directory through the restores of the session that owns it. The subagent's own session is then prepared as a woken session is: each checkout it worked in on this machine stays as it is, and every other checkout is restored from its snapshots into a worktree on this machine, with its blueprints built. Its tools resolve the earlier machine's absolute paths there, and follow the restores of the session or run it was launched in. A subagent started without `context: "fork"` keeps a session file on the machine that launched it, which another machine cannot reopen; it is reported as unrestorable.

## Resume a workflow run

Resume a run with `/workflow resume <run>`, or from the SDK with `run(definition, inputs, { runId })`. A run restores its checkouts from the snapshots on its checkpoints, once, before it continues; see [Worktree snapshots](/worktree-snapshots):

- Each checkout gets its latest recorded state. Completed `ctx.tool` calls are not run again; the step that was interrupted runs again in the restored worktree.
- A child workflow bound to a repository with `workspace({ repo, branch })` continues in its restored worktree, also when its repository or branch exists only on the machine that recorded it.
- A run bound to an input worktree (`worktreeFromInputs`, as `goal` and `ralph` use) continues in the worktree restored for it.
- Children of a pooled run restore their worktree on whichever host claims them, and only hosts that can restore it claim them. A worker host builds the blueprints below, from its own agent directory, in each worktree it restores, before the child starts there; a host given its own `restore` function builds none. See [Workers on other hosts](/workflows/operations#workers-on-other-hosts).
- `forkRun` on another machine materializes the worktrees recorded where the fork starts, not the source run's latest state.

Each checkout the run restores gets its blueprints built, as below, before the run continues, and absolute paths from the earlier machine resolve in the restored worktrees for the run's tools. A missing Git is reported before anything is restored or claimed. A blueprint never stops a run or a pooled child: a step that fails is reported as a warning, and the run continues in the restored worktree.

`run()` with the id of a run in shared storage stops after 15 seconds with a retryable `ResumeCatalogTimeoutError` when the storage does not answer; once it answers, listing the journal's runs is not bounded, and a retry opens the journal again. `/workflow resume` with a run id this machine cannot find fails with the journal's `run-not-found` error, which tells a machine on local storage only to join the shared storage. `run()` with a run id its journal does not hold starts a new run under that id, so check with `atomic storage status` that the machine uses the shared storage before resuming a run from the SDK. If the machine that ran it stopped without releasing it, another machine can take the run over two minutes after its last heartbeat; until then the resume reports that another execution owns it before it restores or sets up anything, and resuming again later continues it.

## Set the environment up with a blueprint

A restored worktree contains the repository's files but not installed dependencies, tools or build output. A *blueprint* tells Atomic how to set that up again. It is Devin's [blueprint](https://docs.devin.ai/onboard-devin/environment/blueprints) format, with one change: the repository file is `.atomic/blueprint.yaml` where Devin reads `.devin/blueprint.yaml`. Atomic reads no `.devin/` path.

| Blueprint | File | Runs in |
|---|---|---|
| Global | `~/.atomic/agent/blueprint.yaml` | your home directory |
| Repository | `.atomic/blueprint.yaml` at the repository root | the repository root |
| Workspace | `<dir>/.atomic/blueprint.yaml`, named by `includes` in the repository blueprint | the workspace directory |

```yaml
includes:
  - services/api
initialize:
  - name: Install Node.js
    uses: github.com/actions/setup-node@v4
    with:
      node-version: "22"
  - name: Install pnpm
    run: npm install -g pnpm
maintenance:
  - name: Install dependencies
    run: pnpm install
knowledge:
  - name: test
    contents: |
      Run the tests with `pnpm test`.
```

| Section | Purpose | When it runs |
|---|---|---|
| `initialize` | Install tools, runtimes and system packages. | In a build. |
| `maintenance` | Install or update project dependencies. Make it self-contained, fast and incremental (`npm install`, not `npm ci`). | In a build. At session start it is shown to the agent, never run automatically. |
| `knowledge` | A list of `{ name, contents }` items, by convention `lint`, `test` and `build`. | Never run. The agent reads it. |
| `post-build` | Check the assembled environment. Global blueprint only. | In a build, after every repository. |

A section is either a string, which is one `run` step, or a list of steps. A list entry may be a bare string. A step is `{ name?, run, env? }` or `{ name?, uses, with?, env? }`, never both `run` and `uses`. `with` is valid only on `uses`, and its values are strings. `uses` takes a `github.com/<owner>/<repo>[/<subpath>]@<ref>` GitHub Action, in `initialize` and `post-build` but not in `maintenance`, where it is rejected with `'uses' steps are not supported in maintenance sections`. Node.js and composite actions run; Docker actions, actions Atomic cannot fetch or read, and composite actions that use `hashFiles`, `secrets` or `matrix` expressions fail the step. Fetched actions are cached per ref under `~/.atomic/agent/blueprint-actions`; set `ATOMIC_BLUEPRINT_GITHUB_BASE_URL` to fetch them from another host than `https://github.com`.

- **Shell.** `run` steps run in bash (Git Bash on Windows) and stop at the first failing command. `shell: powershell` runs them in PowerShell on Windows. Commands must not wait for input.
- **Environment.** `env` applies to its own step. A line written to `$ENVRC`, such as `echo "API_URL=http://localhost:3000" >> $ENVRC` or an `export PATH=...` line, is exported to later steps and to the resumed session's bash tool. In PowerShell, the file path is `$env:ENVRC`; append UTF-8 bash assignments with LF line endings and no byte-order mark, since later bash steps source the same file. `PATH` entries written by bash reach PowerShell and Node.js actions in native Windows path-list format. `$ENVRC` starts empty in every build, so `maintenance` must not rely on what `initialize` wrote to it in an earlier build.
- **Timeout.** A step that runs for 3 hours is stopped and counts as failed.
- **Platforms.** `runs-on` is a string or a list, default `default`. `default` and `linux` are the same platform; `macos` and `windows` are always explicit. A file can hold several `---` documents, each a mapping, and two documents cannot resolve to the same platform. A machine uses only the document for its own platform; when none matches, nothing runs and nothing is shown.
- **Includes.** The repository blueprint may list workspace directories in `includes`. An entry is a directory, or the full path of its blueprint file (`<dir>/.atomic/blueprint.yaml`; no other file name is read), without `..`, and each workspace appears once. Includes are not allowed in a workspace blueprint. A missing workspace blueprint, or a missing workspace directory, means that workspace is removed. `includes` is ignored in the global blueprint, and `post-build` is allowed only there.
- **Clone.** `clone` is accepted and ignored, with a warning: a restore recreates the recorded tree instead of cloning.

### Builds

When a resume restores a worktree, Atomic builds it, in this order: the global blueprint's `initialize` and `maintenance`, then each repository's `initialize` and `maintenance` (its included workspaces follow it), then the global `post-build`. Builds run only for restored worktrees: a checkout the session continues in as it is is never built. A build runs only for a trusted project (`--approve` or `"defaultProjectTrust": "always"`); an untrusted worktree is skipped, silently, and the global blueprint runs only when at least one restored worktree is trusted.

Like Devin's differential builds, a build compares each workspace's blueprint with the last successful build of that workspace on this machine. An unchanged workspace is inherited: its `initialize` is skipped and its `maintenance` runs on top of the existing state. A changed, new or previously failed workspace is rebuilt: `initialize` and `maintenance` both run. A workspace that is no longer configured is removed from the record. A full build, where every workspace is rebuilt and the global `initialize` runs, replaces a differential one when the global blueprint changed or the last full build is older than 7 days. Editing a blueprint is all it takes to retry it.

A step fails when its command exits non-zero, a PowerShell error is raised, or it times out. As in GitHub Actions, the rest of that step stops at once, and as in Devin, "only the setup steps of the failing blueprints did not run": the remaining `initialize` steps and the `maintenance` of that blueprint are skipped, while the other repositories and workspaces keep building. Setup never blocks a resume:

| What happened | Outcome | What you see |
|---|---|---|
| A repository or workspace blueprint failed | Partial. The worktree is complete and usable. | A warning naming the blueprint and the failing step. |
| The global blueprint or its `post-build` failed | Failed. Repositories are not built after a global failure. | A prominent warning. The session resumes anyway. |
| No blueprint, an untrusted worktree, or a platform with no document | Nothing ran. | Nothing. |

Every step writes a log under `~/.atomic/agent/worktree-snapshots/blueprint-logs` with the step's name, command, start and finish times, duration, exit status or timeout and output; the warning gives the path. The fix is to read the log, fix the environment and the blueprint, and resume: a worktree whose last build failed or never finished is built again on its next resume, whether you resume a session or a workflow run, and an edited blueprint is rebuilt. Builds that run at the same time, for example several pooled children restoring on one host, take turns writing the build record.

### What the agent sees

The first turn of a resumed session carries each applicable blueprint's `maintenance` steps and `knowledge` items, labelled with what happened: ran in this build, not yet run on this machine (skipped or untrusted), or not run or partial with the failing step and its log. The same holds for the stages of a resumed workflow run and for pooled children that start in a restored worktree: their sessions get that worktree's context and its `$ENVRC` variables. The agent re-runs `maintenance` itself when it finds that dependencies changed. Atomic's default system prompt also asks the agent to keep `.atomic/blueprint.yaml` current as part of normal work: to write one when a repository has none, to update it in the same change that adds a dependency, tool or workspace, to record hard-won commands in `knowledge`, to leave secrets out, and to fix it after a Partial build. It edits `~/.atomic/agent/blueprint.yaml` only when you ask.

### `resume.setupCommand` and `.atomic/setup`

`.atomic/setup` is no longer read. `resume.setupCommand` is deprecated and stays for one release as an alias for one maintenance step of the global blueprint, run in the root of each restored worktree. A resume that builds a worktree prints a deprecation warning while it is set; move the command into the `maintenance` of `.atomic/blueprint.yaml`.

## What can stop a resume

Missing setup is checked in one pass before anything is restored: the storage adapter and its token (for a session resumed with `atomic`) and Git. A machine without Git gets a portable Git automatically, as it does for other Git work; only when that is impossible, for example in offline mode or when the download fails, does `git-unavailable` stop the resume. Every missing piece is reported together, with the command that fixes it. For a session, Git being unavailable never stops the resume: the session continues without restoring its checkouts, in its recorded directory or the directory you started from, with one notice per checkout that names its path and why. A session resume stops only when the session cannot be read, when a snapshot record fails the security checks (`invalid-snapshot`, for example a remote with credentials or a Git remote helper), or when a restore would write into a directory that holds other files (`unsafe-target`). A blueprint is never one of them: it is built after the restore and cannot stop the resume.

| Error | Code | When it happens | What to do |
|---|---|---|---|
| `ResumeNotFoundError` | `not-found` | The session id matches nothing this machine can read. With reason `local-storage-not-joined`, this machine uses local storage only. | Join the machine's sessions with `atomic storage join <url> --token-file <path>`. `atomic team join` keeps sessions on each machine: on a machine joined that way, run `atomic team leave` first. With reason `shared-miss`, check the id and that every machine uses the same storage and prefix. |
| `ResumePreconditionError` | `preconditions-unmet` | Setup the resume needs is missing. Every missing piece is listed in `problems`: `adapter-not-installed`, `credential-missing`, `credential-unreadable`, `git-unavailable`; a piece that belongs to one checkout names it in `checkout`. With `git-unavailable` (workflow runs; a session continues without its checkouts instead), its `cause` is the `GitUnavailableError` that says why. | Run each listed fix, for example `atomic install npm:@bastani/atomic-storage-libsql`, write the token file, or unset offline mode or install Git. |
| `GitUnavailableError` | `not-installed`, `unsupported-platform`, `offline`, `checksum-mismatch`, `download-failed`, `install-failed` | A workflow run's checkout must be verified or restored and no Git can be started or provisioned. A session continues without its checkouts instead. | Do what its hint says, for example unset `ATOMIC_OFFLINE` or install Git with the command it names. |
| `ResumeCatalogUnavailableError` | `catalog-unavailable` | The shared storage could not be reached while looking the session or run up, for example because the connection was refused or broke. Retryable. Any other storage failure, such as a missing token file, is reported as that storage error itself. | Check connectivity with `atomic storage status` and resume again. |
| `ResumeCatalogTimeoutError` | `catalog-timeout` | The shared storage did not answer the lookup within 15 seconds, for example during a network partition. `subject` is `session` or `run`. Retryable. A partition that starts later in the resume is reported when the connection gives up. | Check connectivity with `atomic storage status` and resume again. |
| `WorkspaceDriftError` | `tree-drift` | A workflow run's recorded state cannot be rebuilt, for example because unpushed commits touch files that are never recorded (`.env`, keys), a snapshot blob is missing, or the disk is full. The message names what the restore could not do (the commits, blob, remote or full volume) and the fix. A session resume does not stop for these; it restores what it can, with a notice. | Do what the message says; for unpushed commits, push them from the original machine, or continue there. |
| `WorkspaceRestoreError` | `invalid-snapshot` | A snapshot record names a remote with credentials, a Git remote helper (`ext::`), another scheme than `https`, `http`, `ssh`, `git` or `file`, or holds a value Atomic never writes. Nothing is fetched or run. | Resume only sessions and runs from storage you trust, or export the session again on the machine that recorded it. |

Secret values never appear in these messages; they name the environment variable or file instead. The classes, their codes and the `isResume…Error` guards are exported from `@bastani/atomic`.

## Windows

Sessions and workflow runs resume on Windows as they do elsewhere. Local workers are not available on Windows, because Atomic cannot contain their tool processes there: a run with `localWorkers` fails with `SharedPoolSetupError` (code `process-containment-unavailable`) before it starts, so resume pooled runs on Linux or macOS.

## Trust

A restored worktree is a new directory, so project trust starts unset there, exactly as for a fresh clone. Until you trust it, project instructions and resources are not loaded and its blueprints are not built; the agent still gets their `maintenance` and `knowledge`, marked as not yet run.
