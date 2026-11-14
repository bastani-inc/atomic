# Round 2: idle Azure VMs (2026-11-14)

Round 1 ran on a shared host whose load average reached about 230, so only effects larger than 2x were relied on.
Round 2 repeats the key measurements on current `main` on dedicated, otherwise idle VMs, and adds the cloud cases the
first round could only estimate: an ephemeral runner with and without caches, reuse of a restored worktree, and
seeded build output at the same and at another path.

## Machines

All in resource group `atomic-resume-exp-20261114` (tag `purpose=atomic-4748`, region `westus2`), deleted after the
measurements. Image `Canonical:ubuntu-24_04-lts:server:latest` (Ubuntu 24.04.5 LTS, kernel 7.0.0-1017-azure),
128 GB Premium SSD OS disk, ext4 (no reflink). Toolchains installed by [`scripts/vm/provision.sh`](scripts/vm/provision.sh):
Git 2.56.1 (git-core PPA), Git LFS, Node 24.22.0, npm 11.19.1, Bun 1.4.4, cargo 1.100.0 (rustup stable, all cores),
uv 0.13.8, zstd 1.5.5.

| Role | Size | CPU / memory | Load average during runs | Used for |
|---|---|---|---|---|
| workstation | `Standard_D16ds_v5` | 16 vCPU Xeon Platinum 8573C, 64 GB | 1.0–6.3 (only the benchmark) | resume phases, reuse, seeds at the same/another path, capture micro-benchmarks, fetch strategies, shallow-store checks |
| runner | `Standard_D4ds_v5` | 4 vCPU, 16 GB (GitHub-hosted `ubuntu-latest` shape) | 1.1–4.9 (only the benchmark) | ephemeral cold starts, with caches from Azure Blob Storage; warm-VM reuse |
| cache | Storage account, Standard LRS, `westus2` | — | — | zstd tarballs, the storage `actions/cache` itself uses |

Atomic under test on both: `main` at `b2b49c6bb` (0.9.86 release notes), built from source on each VM. The Atomic
benchmark project is the same commit. fastapi and ripgrep are at the round 1 commits. Models are the local mock
(`scripts/mock-openai.mjs`); no credentials.

## Stages added to `scripts/run-project.sh`

| Stage | What it is |
|---|---|
| `pack` | after `machineA`: zstd tarballs of machine A's package stores, its extension transpile cache, and its worktree's outermost ignored directories, uploaded to the blob container: a trusted prebuild |
| `runnercold` | new `HOME`, empty stores, **no** extension transpile cache, page cache dropped (`drop_caches`) |
| `runnerstores` | `runnercold` + stores and extension cache downloaded and extracted first, at machine A's store paths (cargo fingerprints hold absolute paths) |
| `runnerfull` | `runnerstores` + the build output, extracted into the restored worktree by the blueprint's first step "Restore build cache (benchmark)" (a no-op everywhere else). The restored worktree's path differs from where the output was built, as it would today |
| `reuse` | the worktree `warmstores` restored, tracked files reset (`checkout --detach`, `reset --hard`, `clean -fd`), ignored directories kept, then the blueprint's `maintenance`; with `REUSE_BACK=20`, reset to a commit 20 commits older |

Other scripts: `vm/bench.sh` (workstation driver), `vm/runner.sh` and `vm/runner-rerun.sh` (runner drivers),
`vm/seed-path.sh` (same path versus another path), `vm/capture-micro.sh` (Git work of one capture: today, with a
persistent private index, with the untracked cache).

Cache downloads are one `curl` stream from a same-region container (`cache_download_ms` in the summaries). GitHub's
cache service downloads with parallel range requests from the same kind of storage, but hosted runners are usually
farther from it; treat these download times as a lower bound.

## Corrections during the run

- The first `runnerstores`/`runnerfull` pass of ripgrep and fastapi extracted the stores to a new path per stage, so
  cargo rebuilt every crate, and fastapi's build archive missed `.venv` (the archive listed only the first ignored
  directory). Both were fixed and rerun (`rerun1`, `rerun2` in `ripgrep-summary.txt`, `fastapi-summary.txt`); the
  first-pass lines are kept but not used.
- A copy of `run-project.sh` replaced while the runner was executing one invocation cut that invocation short
  (`fastapi` rep 1, `target: unbound variable`); the rerun covers it.

## Results

| File | Content |
|---|---|
| `results/round2-idle-d16/resume-phases.md`, `.json` | per-phase table of cold, warm-stores, warm-local resumes, two repetitions |
| `results/round2-idle-d16/<project>-summary.txt` | raw stage lines, load averages, reuse timings |
| `results/round2-idle-d16/atomic-maintenance-breakdown.txt` | Atomic's maintenance steps one by one in a built worktree |
| `results/round2-idle-d16/seed-path.txt` | seeded build output at the same and at another path |
| `results/round2-idle-d16/capture-micro.txt`, `capture-bench.txt` | capture Git work and `captureWorktreeSnapshot` in fresh clones |
| `results/round2-idle-d16/fetch-bench.txt` | restore fetch strategies, two runs |
| `results/round2-idle-d16/shallow-store-capture.txt` | what a depth-1 store still supports |
| `results/round2-idle-d16/cold-home-startup.txt` | first start in a new `HOME`, then two warm starts |
| `results/round2-runner-d4/resume-phases.md`, `.json` | per-phase table of the runner stages |
| `results/round2-runner-d4/<project>-summary.txt` | raw stage lines, cache sizes and download times |
| `results/round2-runner-d4/cold-home-startup.txt` | first start in a new `HOME` on the runner |
| `results/round2-host/capture-bench.txt` | `captureWorktreeSnapshot` on the round 1 host at load average 31 |
