# Dependency PR inventory and checkout discovery

Generated: 2026-07-09

## Checkout / git worktree

- Worktree path: `/Users/tonystark/Documents/projects/atomic-deps-latest-pi-0.80.5`
- `git rev-parse --show-toplevel`: `/Users/tonystark/Documents/projects/atomic-deps-latest-pi-0.80.5`
- Current branch after setup: `chore/update-dependencies-pi-0.80.5` (created from main at `5a465d58c13480082f6c70c03a48ad3b2eadfaf5`). Initial discovery ran before branch creation while HEAD was detached at the same main commit.
- HEAD/base commit at discovery: `5a465d58c13480082f6c70c03a48ad3b2eadfaf5`
- Base/main evidence:
  - `main`: `5a465d58c13480082f6c70c03a48ad3b2eadfaf5`
  - `origin/main`: `5a465d58c13480082f6c70c03a48ad3b2eadfaf5`
  - `git merge-base HEAD origin/main`: `5a465d58c13480082f6c70c03a48ad3b2eadfaf5`
  - Branches containing the base commit include local `main` and `remotes/origin/main`.
- Remote:
  - `origin` fetch: `ngit:bastani-inc/atomic.git`
  - `origin` push: `ngit:bastani-inc/atomic.git`
- Worktree list confirmed this path is an isolated git worktree at the same commit as main before the dependency-update branch was created.

## Repo setup evidence

- Bun version installed: `1.3.14`
- Root `package.json` declares `packageManager: bun@1.3.14`.
- Root workspace config: `workspaces: ["packages/*"]`.
- Key root scripts from `package.json`:
  - `test`: `bun run test:unit`
  - `test:unit`: `bun test test/unit`
  - `test:integration`: `bun test test/integration`
  - `test:all`: `bun run test:unit && bun run test:integration`
  - `typecheck`: `tsc --noEmit`
  - `lint`: `tsc --noEmit`
  - `check:file-length`: `bun scripts/check-file-length.ts`
  - `check:shrinkwrap`: `bun run scripts/generate-coding-agent-shrinkwrap.mjs --check`
- Lock/manifests/tooling observed in root listing: `bun.lock`, `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`, `tsconfig.json`, `tsconfig.base.json`, `bunfig.toml`, `rust-toolchain.toml`, `.github/dependabot.yml`, `packages/`, `test/`, `scripts/`.
- Dependabot config (`.github/dependabot.yml`) includes ecosystems: `github-actions`, `bun`, and `cargo`.
- No dependency files were modified during this focused discovery; only this inventory artifact was written.

## GitHub / gh CLI evidence

- `gh version`: `2.96.0 (2026-07-02)`
- `gh auth status`: authenticated to `github.com`; active account `flora131`; token scopes include `repo` and `workflow`.
- Open Dependabot dependency PR discovery commands found 5 currently open PRs authored by Dependabot for dependency updates in `bastani-inc/atomic`.

## Open Dependabot dependency PR inventory

| PR | Title | Dependency | Ecosystem | Target files | Proposed version | Labels | URL |
|---:|---|---|---|---|---|---|---|
| #1653 | `deps: bump napi-derive from 3.5.8 to 3.5.9` | `napi-derive` | Cargo (`package-manager=cargo`; head `dependabot/cargo/napi-derive-3.5.9`) | `Cargo.lock` | `3.5.9` | `dependencies` | https://github.com/bastani-inc/atomic/pull/1653 |
| #1652 | `deps: bump napi from 3.10.0 to 3.10.3` | `napi` | Cargo (`package-manager=cargo`; head `dependabot/cargo/napi-3.10.3`) | `Cargo.lock` | `3.10.3` | `dependencies` | https://github.com/bastani-inc/atomic/pull/1652 |
| #1651 | `deps: bump tree-sitter from 0.25.10 to 0.26.10` | `tree-sitter` | Cargo (`package-manager=cargo`; head `dependabot/cargo/tree-sitter-0.26.10`) | `Cargo.lock`, `Cargo.toml` | `0.26.10` | `dependencies` | https://github.com/bastani-inc/atomic/pull/1651 |
| #1650 | `deps: bump @dbos-inc/dbos-sdk from 4.22.6 to 4.23.6` | `@dbos-inc/dbos-sdk` | Bun (`package-manager=bun`; head `dependabot/bun/dbos-inc/dbos-sdk-4.23.6`) | `bun.lock`, `packages/coding-agent/package.json` | `4.23.6` | `dependencies` | https://github.com/bastani-inc/atomic/pull/1650 |
| #1649 | `deps: bump lru-cache from 11.3.6 to 11.5.1` | `lru-cache` | Bun (`package-manager=bun`; head `dependabot/bun/lru-cache-11.5.1`) | `bun.lock`, `packages/coding-agent/package.json` | `11.5.1` | `dependencies` | https://github.com/bastani-inc/atomic/pull/1649 |


## Latest stable versions applied

- `napi-derive`: latest stable `3.5.9` (matches Dependabot proposal #1653).
- `napi`: latest stable `3.10.3` (matches Dependabot proposal #1652).
- `tree-sitter`: latest stable `0.26.10` (matches Dependabot proposal #1651).
- `@dbos-inc/dbos-sdk`: latest stable `4.23.6` (matches Dependabot proposal #1650).
- `lru-cache`: latest stable `11.5.2` (newer than Dependabot proposal #1649's `11.5.1`).
- Upstream Pi runtime packages: `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui` updated from `^0.80.3` to exactly the `^0.80.5` dependency line, resolving installed packages at `0.80.5`.
### Structured inventory JSON

```json
[
  {
    "number": 1653,
    "title": "deps: bump napi-derive from 3.5.8 to 3.5.9",
    "dependency": "napi-derive",
    "ecosystem": "cargo",
    "targetFiles": ["Cargo.lock"],
    "proposedVersion": "3.5.9",
    "labels": ["dependencies"],
    "url": "https://github.com/bastani-inc/atomic/pull/1653",
    "headRefName": "dependabot/cargo/napi-derive-3.5.9",
    "baseRefName": "main"
  },
  {
    "number": 1652,
    "title": "deps: bump napi from 3.10.0 to 3.10.3",
    "dependency": "napi",
    "ecosystem": "cargo",
    "targetFiles": ["Cargo.lock"],
    "proposedVersion": "3.10.3",
    "labels": ["dependencies"],
    "url": "https://github.com/bastani-inc/atomic/pull/1652",
    "headRefName": "dependabot/cargo/napi-3.10.3",
    "baseRefName": "main"
  },
  {
    "number": 1651,
    "title": "deps: bump tree-sitter from 0.25.10 to 0.26.10",
    "dependency": "tree-sitter",
    "ecosystem": "cargo",
    "targetFiles": ["Cargo.lock", "Cargo.toml"],
    "proposedVersion": "0.26.10",
    "labels": ["dependencies"],
    "url": "https://github.com/bastani-inc/atomic/pull/1651",
    "headRefName": "dependabot/cargo/tree-sitter-0.26.10",
    "baseRefName": "main"
  },
  {
    "number": 1650,
    "title": "deps: bump @dbos-inc/dbos-sdk from 4.22.6 to 4.23.6",
    "dependency": "@dbos-inc/dbos-sdk",
    "ecosystem": "bun",
    "targetFiles": ["bun.lock", "packages/coding-agent/package.json"],
    "proposedVersion": "4.23.6",
    "labels": ["dependencies"],
    "url": "https://github.com/bastani-inc/atomic/pull/1650",
    "headRefName": "dependabot/bun/dbos-inc/dbos-sdk-4.23.6",
    "baseRefName": "main"
  },
  {
    "number": 1649,
    "title": "deps: bump lru-cache from 11.3.6 to 11.5.1",
    "dependency": "lru-cache",
    "ecosystem": "bun",
    "targetFiles": ["bun.lock", "packages/coding-agent/package.json"],
    "proposedVersion": "11.5.1",
    "labels": ["dependencies"],
    "url": "https://github.com/bastani-inc/atomic/pull/1649",
    "headRefName": "dependabot/bun/lru-cache-11.5.1",
    "baseRefName": "main"
  }
]
```

## Commands run

```sh
pwd && git rev-parse --show-toplevel && git status --short --branch && git branch --show-current && git remote -v
bun --version && ls -la && find . -maxdepth 2 \( -name package.json -o -name bun.lock -o -name bun.lockb -o -name AGENTS.md -o -name README.md -o -name tsconfig.json -o -name bunfig.toml -o -name .git \) -print | sort
git worktree list --porcelain && printf '\nHEAD:\n' && git log -1 --decorate=full --oneline && printf '\nBranches containing HEAD:\n' && git branch -a --contains HEAD && printf '\nMain ref:\n' && git rev-parse --verify main || true && git rev-parse --verify origin/main || true && printf '\nMerge base with origin/main:\n' && git merge-base HEAD origin/main || true && git status --porcelain=v1
gh --version && gh auth status
gh pr list --repo bastani-inc/atomic --state open --author 'app/dependabot' --limit 200 --json number,title,url,author,labels,files,body,headRefName,baseRefName,createdAt,updatedAt
gh pr list --repo bastani-inc/atomic --state open --limit 200 --json number,title,url,author,labels,headRefName,baseRefName | bun -e 'const fs=require("fs"); const prs=JSON.parse(fs.readFileSync(0,"utf8")); console.log(JSON.stringify(prs.filter(p => /dependabot/i.test(p.author.login)||/dependabot/i.test(p.headRefName)||p.labels.some(l=>/dependencies/i.test(l.name))), null, 2))'
bun -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync("package.json","utf8")); console.log(JSON.stringify({packageManager:p.packageManager, workspaces:p.workspaces, scripts:p.scripts, devDependencies:p.devDependencies, dependencies:p.dependencies}, null, 2))'
gh search prs --repo bastani-inc/atomic --state open --author app/dependabot --json number,title,url,author,labels --limit 100
```
