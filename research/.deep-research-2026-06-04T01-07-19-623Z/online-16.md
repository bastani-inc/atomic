## 1. Relevant external facts

- **npm `package.json` is the canonical package manifest format**; it must be actual JSON, and fields like `name`, `version`, `keywords`, `dependencies`, `peerDependencies`, and `bundleDependencies` are standard npm metadata. `keywords` specifically improve discoverability in `npm search`.  
  Source: **package.json | npm Docs**

- **`bundleDependencies` / `bundledDependencies` are honored by npm pack/publish** and are used to ship selected dependencies inside the tarball.  
  Source: **package.json | npm Docs**

- **`peerDependencies` are the right mechanism for host-plugin compatibility**: npm treats them as compatibility constraints rather than normal runtime deps.  
  Source: **package.json | npm Docs**

- **Local path dependencies and git URLs are valid npm package sources**.  
  Source: **package.json | npm Docs**

- **The repo’s package contract is more specific than npm’s generic manifest**: `atomic` / legacy `pi` keys define resource lists, and conventional dirs are used when manifests are absent.  
  Source: **`packages/coding-agent/docs/packages.md`**

## 2. Local implications

- In a TS→Rust migration, **do not change the manifest contract**. `package.json` parsing must still support:
  - `atomic` and legacy `pi`
  - `extensions`, `skills`, `prompts`, `themes`, `workflows` / singular `workflow`
  - glob patterns, `!` excludes, `+` includes, and scope precedence

- **Resource discovery is the migration boundary**, not just JSON parsing:
  - package discovery (`npm`, `git`, local path)
  - conventional directories fallback
  - dedupe/precedence rules across user/project scope
  - builtin package merging in the resource loader

- If Rust replaces the TS loader, it must preserve npm-compatible package semantics where this repo relies on them, especially:
  - **`peerDependencies`** for bundled host SDKs
  - **`bundleDependencies`** for shipping nested packages
  - **git/local source handling** for package installation/discovery

- The biggest risk is changing **ordering/precedence**: `resource-loader.ts` merges package resources, builtin resources, and CLI-injected resources. Any Rust rewrite must keep “first wins” collision behavior identical.

## 3. Version/API assumptions

- Assumed npm manifest behavior from **npm v10/v11 docs**.
- Assumed package contract from current repo docs:
  - `atomic` key is primary
  - `pi` key remains backward-compatible
  - workflows may use `workflow` as a singular alias
- Assumed resource file conventions remain:
  - `extensions/*.ts|.js`
  - `skills/**/SKILL.md` and top-level `.md`
  - `prompts/*.md`
  - `themes/*.json`
  - `workflows/*.ts|.js|.mjs|.cjs`

## 4. Unverified or unnecessary research

- I did **not** verify Rust crate choices for globbing, ignore rules, or package parsing; that’s implementation detail, not contract.
- I did **not** trace the full builtin packaging pipeline from CI scripts here; the local docs already show the relevant published-package shape.
- I did **not** research broader Node module-resolution behavior because this partition is about **resource loading and manifest semantics**, not JS module loading itself.