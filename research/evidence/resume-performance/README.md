# Resume and snapshot performance: measurement evidence

Raw results and the scripts that produced them, for
[`specs/2026-11-14-resume-performance.md`](../../../specs/2026-11-14-resume-performance.md). Nothing here changes
product code. The large Git trace files stayed on the measurement machines; `results/` holds what was derived from them.

Two rounds:

- **Round 1** (2026-11-13, exploration for the closed draft #4735, whose spec stays on branch
  `docs/spec-resume-performance`): a shared, heavily loaded 80-vCPU host, Atomic at `fb5c99df5`. Its files are the
  ones directly under `results/`. Described below.
- **Round 2** (2026-11-14, this spec): current `main` (`b2b49c6bb`) on two otherwise idle Azure VMs, a 16-vCPU
  workstation and a 4-vCPU runner shaped like a GitHub-hosted one, plus a capture benchmark on the round 1 host.
  Described in [`vm.md`](vm.md); results under `results/round2-idle-d16/`, `results/round2-runner-d4/` and
  `results/round2-host/`.

# Round 1

## Host

| Item | Value |
|---|---|
| CPU | AMD EPYC 9V45, 80 vCPUs, shared with other users (load average rose to about 230 near the end; see "Noise") |
| OS / kernel | Ubuntu 26.04.1 LTS, Linux 7.0.0-1017-azure |
| Filesystem | XFS on md RAID (`/fast`), `reflink=1`, 4 KiB blocks: `cp --reflink=always` works |
| Toolchain | Git 2.53.0, Node 24.22.0, npm 11.19.1, pnpm 10.19.0 (installed by the blueprint), uv 0.13.1, cargo 1.99.1 |
| Cargo jobs | `CARGO_BUILD_JOBS=4` was inherited from the host environment, so Rust builds used 4 jobs, like a 4-vCPU GitHub-hosted runner |
| Atomic | this branch's base (`origin/main` at `fb5c99df54`), built with `npm ci --ignore-scripts && npm run build`, run as `node packages/coding-agent/dist/cli.js` |
| Model | `scripts/mock-openai.mjs`, a local OpenAI-compatible streaming mock. No credentials. It logs every request with a timestamp |

## Projects and blueprints

| Project | Repository (commit) | Tracked files | Blueprint (`scripts/blueprints/`) |
|---|---|---:|---|
| Atomic (npm workspaces, Rust native module) | `bastani-inc/atomic` (`fb5c99df5`) | 7,645 | `npm install --ignore-scripts`; `npm run build` |
| pnpm + Turbo + Next.js monorepo | `t3-oss/create-t3-turbo` (`8f945b7`) | 141 | initialize: `npm install -g pnpm@10.19.0`; maintenance: `pnpm install` |
| Rust cargo workspace | `BurntSushi/ripgrep` (`178cc02`) | 226 | `cargo fetch --locked`; `cargo build --locked --workspace` |
| uv Python project | `fastapi/fastapi` (`703019198`) | 3,242 | `uv sync --locked` |
| Large repository, capture only | `torvalds/linux`, depth 1 (`7e1392a42`) | 97,371 | none |

The snapshot's remotes are the real GitHub URLs, so every restore fetched from github.com.

## Method

`scripts/run-project.sh <project> <stage>` drives everything; `scripts/env.sh` gives each run a throwaway `HOME` and
selects a package-store set through `npm_config_cache`, `XDG_DATA_HOME` (pnpm store), `XDG_CACHE_HOME` (uv, pnpm
metadata) and `CARGO_HOME`.

1. `prepare`: reflink-copy the clone to `runs/<p>/work`, add `.atomic/blueprint.yaml` (untracked, so the snapshot
   carries it).
2. `machineA`: install the dependencies the way a developer would, then run one session turn whose mock tool call
   edits `README.md` and creates `RESUME_NOTE.md`. Atomic captures a snapshot at the end of the turn into machine A's
   SQLite store. `GIT_TRACE2_EVENT` records every Git command. Then the checkout is moved away, so it is missing.
3. Resume as `atomic --session <id> -p "CONTINUE-..." < /dev/null` with a copy of machine A's database:
   - `cold`: new `HOME`, new empty package stores (a new team machine or a fresh cloud runner);
   - `warmstores`: new `HOME` (no Git objects, no build ledger), package stores warmed by `cold`;
   - `warmlocal`: the `warmstores` `HOME` again with its restored worktree deleted, so Git objects, ledger and
     stores are warm but the new worktree has no `node_modules`, `target` or `.venv` (today's best local case).
   Every new `HOME` got a pre-warmed extension transpile cache (`~/.atomic/agent/cache/jiti`) so its one-off cost does
   not hide the resume phases. That cost is measured separately in `results/cold-home-startup.txt`.
4. `scripts/analyze.py` splits each resume into phases from the Git trace: fetch (`init --bare` through
   `update-ref refs/atomic/heads/...`), reconstruct (patch chain), materialize (`worktree add` through the first
   `update-index --refresh`), LFS (`lfs pull` and its HEAD juggling), verify (the recomputed tree), publish
   (`worktree move`). Blueprint steps come from their log files: each step's log is created when it starts and
   last written when it ends; birth time has one-second precision, so a step starts when the previous one ended.
   Time to first prompt is the mock's request timestamp minus the launch timestamp. "Startup + other" is the rest:
   CLI start, storage, trust and session setup.
5. Each stage ran twice (`rep1`, `rep2`); `scripts/table.py` builds `results/resume-phases.md` and `.json`.

Other experiments:

| Script | What it measures | Result file |
|---|---|---|
| `capture-bench.mjs`, `capture-racy.sh` | `captureWorktreeSnapshot` from the built SDK: first capture, a no-op turn (`previous` given, nothing changed) and a one-file edit, median of 5, in a fresh clone and after one `git status` | `results/capture-bench-rerun.txt` (used in the spec), `results/capture-bench.txt` (first run, under heavy host load) |
| `analyze.py --capture --list` | the in-session capture of machine A's turn, command by command | `results/in-session-capture-git-commands.txt` |
| `proto-copy.sh` | outside Atomic: a fresh detached worktree of the snapshot's commit, the restored worktree's ignored directories copied in with no copy, `cp -a --reflink=never`, `cp -a --reflink=always` and `cp -al`, then the blueprint's maintenance on top, with warm stores | `results/dependency-dir-materialization.txt` |
| `fetch-bench.sh` | fetching only `HEAD` from GitHub into a fresh bare store: full history (today), `--filter=blob:none`, `--filter=tree:0`, `--depth=1`, each followed by a checkout | `results/fetch-bench.txt` |
| `chain-repro.sh` | a third resume, from a snapshot captured in a restored worktree | `results/chain-repro.txt` |
| manual Git commands | racily clean index entries, duplicate ignored-file listing, untracked cache, fsmonitor | `results/git-micro.txt` |
| `atomic -p hello --no-session` three times in one new `HOME` | first start without the extension transpile cache | `results/cold-home-startup.txt` |
| `du --apparent-size` | what each cache would carry | `results/cache-sizes.txt` |

## Noise

The host is shared. Package downloads varied by up to 3x between repetitions (pnpm cold install 27.1 s, then
9.2 s), and Rust and TypeScript builds by up to 1.6x (ripgrep `cargo build` 7.0 s and 11.5 s with the same inputs).
Phase splits inside one run are reliable; differences between runs smaller than about 30% are not. Capture micro
benchmarks under 100 ms move by tens of milliseconds with load.

## Re-running

```sh
cd <this worktree> && npm ci --ignore-scripts && npm run build
mkdir -p /fast/tmp/resume-perf/{harness,src} && cp -r research/evidence/resume-performance/scripts/* /fast/tmp/resume-perf/harness/
mkdir -p /fast/tmp/resume-perf/harness/projects && mv /fast/tmp/resume-perf/harness/blueprints/*.yaml /fast/tmp/resume-perf/harness/projects/
# clone the four repositories into /fast/tmp/resume-perf/src/<name>; start the mock:
node /fast/tmp/resume-perf/harness/mock-openai.mjs &
# seed one warm extension cache that run-project.sh copies into each new HOME:
H=/fast/tmp/resume-perf/smoke/homeA; source /fast/tmp/resume-perf/harness/env.sh; $ATOMIC_CLI -p hi --no-session </dev/null
cd /fast/tmp/resume-perf/harness && ./run-project.sh ripgrep prepare machineA cold warmstores warmlocal
```

`RP` (default `/fast/tmp/resume-perf`), `ATOMIC_REPO` (the built checkout whose `dist/cli.js` runs), `MOCK_PORT` and
`BENCH_PATH` (the `PATH` of each run) select the layout; `scripts/vm/common.sh` sets them for the Azure VMs.
