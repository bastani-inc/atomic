---
date: 2026-03-23 21:58:28 PDT
researcher: Claude Code
git_commit: 017ba430cfe2a0801dc478d6895a505bf2850159
branch: flora131/feature/windows-arm64
repository: atomic
topic: "Dual-binary Windows approach: standard x64 (AVX) + x64-baseline (no AVX) for ARM64 Prism"
tags:
    [
        research,
        codebase,
        windows,
        arm64,
        build,
        dual-binary,
        self-update,
        strategy-pattern,
    ]
status: complete
last_updated: 2026-03-23
last_updated_by: Claude Code
---

# Research: Dual-Binary Windows Approach

## Research Question

Document the exact mechanics for shipping two Windows binaries (`atomic-windows-x64.exe` with AVX and `atomic-windows-x64-baseline.exe` without AVX) by investigating: (1) `publish.yml` -- build jobs, artifact upload/download between jobs, release file list construction; (2) `build-binary.ts` -- how CLI args map to `Bun.build()` options, how `define` propagates build-time constants, and how to inject `__ATOMIC_BASELINE__`; (3) `download.ts` -- `getBinaryFilename()` resolution logic and self-update flow; (4) `install.ps1` -- ARM64 detection switch; (5) `install.sh` -- Windows delegation. Focus on the Strategy pattern needed: a build-time flag (`__ATOMIC_BASELINE__`) that controls self-update artifact selection so the baseline binary self-updates to itself, not the standard binary.

## Summary

The current `publish.yml` has already been modified to build a **single** Windows binary using `--target=bun-windows-x64-baseline` (AVX-free). This means native x64 users lose AVX optimizations. To preserve AVX for the x64 majority while supporting ARM64 via Prism, two Windows binaries are needed.

The core challenge is the **self-update loop**: under Prism emulation, `process.arch === "x64"`, so `getBinaryFilename()` in `download.ts` cannot distinguish "native x64" from "ARM64 running x64 via Prism." A build-time **discriminator flag** (`__ATOMIC_BASELINE__`) solves this using a Strategy-like pattern -- the flag is baked into the baseline binary at compile time and checked at runtime to select the correct artifact filename for self-update.

**Five files need changes:** `publish.yml` (two build lines + new release asset), `build-binary.ts` (auto-derive `__ATOMIC_BASELINE__` from target string), `download.ts` (`getBinaryFilename()` respects the flag), `install.ps1` (ARM64 targets baseline artifact), and `install.sh` (no additional changes -- Windows delegation already fixed).

---

## Detailed Findings

### 1. `publish.yml` -- Current CI Pipeline State

**File:** `.github/workflows/publish.yml`

**Current state (already modified on this branch):** The original `build-windows` job has been **removed**. All binaries (including Windows) are now cross-compiled from the single `build` job running on `ubuntu-latest`.

**Build step (line 71-72):**

```yaml
# Windows x64 (baseline -- AVX-free for ARM64 Prism compatibility)
bun run src/scripts/build-binary.ts --minify --target=bun-windows-x64-baseline --outfile dist/atomic-windows-x64.exe
```

**Artifact flow:**

1. `build` job (lines 30-103): builds all 5 binaries + config archives into `dist/`
2. `actions/upload-artifact@v7` (lines 99-103): uploads entire `dist/` as artifact named `binaries`
3. `release` job (lines 105-169): depends on `[build]`, downloads `binaries` artifact to `dist/`, creates checksums, publishes to GitHub Release

**Release file list (lines 161-169):**

```yaml
files: |
    dist/atomic-linux-x64
    dist/atomic-linux-arm64
    dist/atomic-darwin-x64
    dist/atomic-darwin-arm64
    dist/atomic-windows-x64.exe
    dist/atomic-config.tar.gz
    dist/atomic-config.zip
    dist/checksums.txt
```

**Checksum generation (lines 138-140):**

```yaml
- name: Create checksums
  run: |
      cd dist
      sha256sum * > checksums.txt
```

This uses `sha256sum *` which automatically includes **all files in `dist/`**. Adding a new `atomic-windows-x64-baseline.exe` to `dist/` means it will automatically get a checksum entry. No manual checksum logic changes needed.

**For dual-binary approach, changes needed:**

1. Add standard x64 build line: `--target=bun-windows-x64 --outfile dist/atomic-windows-x64.exe`
2. Change baseline build output to: `--outfile dist/atomic-windows-x64-baseline.exe`
3. Add `dist/atomic-windows-x64-baseline.exe` to the release files list

### 2. `build-binary.ts` -- Build-Time Define Injection

**File:** `src/scripts/build-binary.ts`

**CLI argument parsing (lines 22-43):** `parseBuildOptions()` extracts three flags:

- `--outfile` (required): output file path
- `--target` (optional): Bun compile target string (e.g., `bun-windows-x64-baseline`)
- `--minify` (optional): boolean

**Target validation (lines 14-20):** `parseCompileTarget()` validates the target starts with `bun-`.

**OS inference (lines 45-65):** `inferTargetOs()` extracts the OS from the `--target` string. Returns `NodeJS.Platform`.

**No architecture inference exists.** No `inferTargetArch()` function.

**`Bun.build()` call (lines 80-92):**

```typescript
const result = await Bun.build({
    entrypoints: ["src/cli.ts", parserWorker],
    minify: options.minify,
    compile: {
        outfile: options.outfile,
        autoloadDotenv: false,
        autoloadBunfig: false,
        ...(options.target ? { target: options.target as never } : {}),
    },
    define: {
        OTUI_TREE_SITTER_WORKER_PATH: JSON.stringify(
            `${getBunfsRoot(compileTargetOs)}${workerRelativePath}`,
        ),
    },
});
```

**The `define` block** is the injection point for `__ATOMIC_BASELINE__`. Bun's `define` works like esbuild's -- it performs global text substitution at bundle time. Any reference to the identifier in source code is replaced with the defined value.

**Key insight: auto-derive from target string.** The `--target` flag already contains the word `"baseline"` when building the baseline binary. No new CLI flags needed:

```typescript
const isBaseline = options.target?.includes("baseline") ?? false;

define: {
  OTUI_TREE_SITTER_WORKER_PATH: JSON.stringify(...),
  ...(isBaseline ? { __ATOMIC_BASELINE__: JSON.stringify(true) } : {}),
},
```

This is the **Strategy discriminator** -- it's derived automatically from the existing `--target` flag, requiring zero changes to the CI invocation syntax. The `define` block conditionally includes `__ATOMIC_BASELINE__` only for baseline builds.

**How `define` propagates:** Bun replaces ALL occurrences of the identifier `__ATOMIC_BASELINE__` in the bundled source with `true` (the JSON-stringified value). In standard builds where the define is absent, the identifier remains undefined. Code can check `typeof __ATOMIC_BASELINE__ !== "undefined"` to branch.

### 3. `download.ts` -- Self-Update Artifact Resolution

**File:** `src/services/system/download.ts`

**`getBinaryFilename()` (lines 307-340):**

```typescript
export function getBinaryFilename(): string {
    const platform = process.platform;
    const arch = process.arch;

    let os: string;
    switch (platform) {
        case "linux":
            os = "linux";
            break;
        case "darwin":
            os = "darwin";
            break;
        case "win32":
            os = "windows";
            break;
        default:
            throw new Error(`Unsupported platform: ${platform}`);
    }

    let archStr: string;
    switch (arch) {
        case "x64":
            archStr = "x64";
            break;
        case "arm64":
            archStr = "arm64";
            break;
        default:
            throw new Error(`Unsupported architecture: ${arch}`);
    }

    const ext = platform === "win32" ? ".exe" : "";
    return `atomic-${os}-${archStr}${ext}`;
}
```

**The self-update problem:** Under Prism, `process.arch === "x64"`. This function returns `atomic-windows-x64.exe` -- the **standard** AVX binary. If the user is on ARM64 running via Prism, this would download the standard binary which crashes under Prism due to AVX instructions.

**Call chain for self-update:**

1. `src/commands/cli/update.ts:242` calls `getBinaryFilename()`
2. Result is passed to `getDownloadUrl(version, binaryFilename)` (line 362-366)
3. URL is `https://github.com/bastani/atomic/releases/download/v{version}/{filename}`
4. Binary is downloaded, checksum-verified, and replaces the current executable

**For dual-binary approach, `getBinaryFilename()` needs baseline awareness:**

```typescript
declare const __ATOMIC_BASELINE__: boolean | undefined;

export function getBinaryFilename(): string {
    // ... existing platform/arch logic ...
    const isBaseline =
        typeof __ATOMIC_BASELINE__ !== "undefined" && __ATOMIC_BASELINE__;
    const baselineSuffix = isBaseline ? "-baseline" : "";
    return `atomic-${os}-${archStr}${baselineSuffix}${ext}`;
}
```

In the **standard** build: `__ATOMIC_BASELINE__` is never defined, so `typeof` returns `"undefined"`, suffix is empty, result is `atomic-windows-x64.exe`.

In the **baseline** build: `__ATOMIC_BASELINE__` is replaced with `true` at bundle time, suffix is `-baseline`, result is `atomic-windows-x64-baseline.exe`.

**Checksum verification (lines 274-294):** `verifyChecksum()` takes `expectedFilename` as parameter -- it uses whatever filename `getBinaryFilename()` returns, so no changes needed there.

**`getDownloadUrl()` (lines 362-366):** Constructs URL from version + filename. No changes needed.

### 4. `install.ps1` -- ARM64 Detection

**File:** `install.ps1`

**Architecture detection (lines 235-247) -- already modified on this branch:**

```powershell
$Arch = $env:PROCESSOR_ARCHITECTURE
switch ($Arch) {
    "AMD64" { $Target = "windows-x64.exe" }
    "ARM64" {
        Write-Info "Windows ARM64 detected -- installing x64 binary (runs via x64 emulation; requires Windows 11)"
        $Target = "windows-x64.exe"
    }
    default {
        Write-Err "Unsupported architecture: $Arch"
        Write-Err "Atomic CLI requires 64-bit Windows (x64 or ARM64)"
        exit 1
    }
}
```

**Current state:** ARM64 already remaps to `windows-x64.exe`. For dual-binary, ARM64 should target `windows-x64-baseline.exe`:

```powershell
"ARM64" {
    Write-Info "Windows ARM64 detected -- installing x64-baseline binary (runs via x64 emulation; requires Windows 11)"
    $Target = "windows-x64-baseline.exe"
}
```

**Download URL construction (line 292):**

```powershell
$DownloadUrl = "${BaseUrl}/${BinaryName}-${Target}"
```

This uses `$Target` directly, so changing `$Target` to `"windows-x64-baseline.exe"` produces `https://github.com/.../atomic-windows-x64-baseline.exe`. No other URL logic changes needed.

**Checksum verification (lines 329-342):** Uses `$Target` in the grep:

```powershell
$ExpectedLine = Get-Content $TempChecksums | Where-Object { $_ -match $Target }
```

Since `$Target` is `"windows-x64-baseline.exe"`, this will match the correct checksum line. No changes needed.

**Temp file naming (line 300):**

```powershell
$TempBinary = "${TempDir}\${BinaryName}-${Target}"
```

Also uses `$Target` -- correctly produces `atomic-windows-x64-baseline.exe`. No changes needed.

### 5. `install.sh` -- Windows Delegation

**File:** `install.sh`

**Windows delegation (lines 363-379) -- already modified on this branch:**

```bash
case "$(uname -s | tr '[:upper:]' '[:lower:]')" in
    mingw*|msys*|cygwin*)
        info "Windows detected, delegating to PowerShell installer..."
        local ps_args=""
        if [[ -n "${ATOMIC_INSTALL_VERSION:-}" ]]; then
            # ... version validation and arg passing ...
            ps_args="${ps_args} -Version '${ATOMIC_INSTALL_VERSION}'"
        fi
        if [[ "${ATOMIC_INSTALL_PRERELEASE:-}" == "true" ]]; then
            ps_args="${ps_args} -Prerelease"
        fi
        powershell -c "iex \"& { \$(irm https://raw.githubusercontent.com/.../install.ps1) }${ps_args}\""
        exit $?
        ;;
esac
```

**No additional changes needed.** The Windows delegation already passes version/prerelease args to `install.ps1`. The ARM64 detection and baseline remapping happen inside `install.ps1`, not in `install.sh`.

**Rosetta 2 precedent (lines 155-160):**

```bash
if [[ "$os" == "darwin" && "$arch" == "x64" ]]; then
    if [[ $(sysctl -n sysctl.proc_translated 2>/dev/null) == "1" ]]; then
        info "Detected Rosetta 2 emulation, using native arm64 binary"
        arch="arm64"
    fi
fi
```

This is the inverse pattern -- macOS remaps x64 → arm64 (native is preferred). Windows ARM64 remaps arm64 → x64-baseline (emulated is the only working option). The pattern is established.

---

## Code References

- `.github/workflows/publish.yml:71-72` -- Current baseline-only Windows build line
- `.github/workflows/publish.yml:99-103` -- Artifact upload (single `binaries` artifact)
- `.github/workflows/publish.yml:115-119` -- Artifact download in release job
- `.github/workflows/publish.yml:137-140` -- Checksum generation (`sha256sum *` -- auto-includes new files)
- `.github/workflows/publish.yml:161-169` -- Release file list (needs new entry)
- `src/scripts/build-binary.ts:14-20` -- `parseCompileTarget()` validates `bun-` prefix
- `src/scripts/build-binary.ts:22-43` -- `parseBuildOptions()` parses `--outfile`, `--target`, `--minify`
- `src/scripts/build-binary.ts:45-65` -- `inferTargetOs()` extracts OS from target
- `src/scripts/build-binary.ts:80-92` -- `Bun.build()` call with `define` block (injection point)
- `src/services/system/download.ts:307-340` -- `getBinaryFilename()` (self-update artifact resolution)
- `src/services/system/download.ts:362-366` -- `getDownloadUrl()` constructs GitHub release URL
- `src/commands/cli/update.ts:242` -- `getBinaryFilename()` call in self-update flow
- `install.ps1:235-247` -- ARM64 architecture detection switch
- `install.ps1:292` -- Download URL construction using `$Target`
- `install.ps1:329-342` -- Checksum verification using `$Target`
- `install.sh:155-160` -- Rosetta 2 remapping precedent
- `install.sh:363-379` -- Windows delegation with version/prerelease arg passing

## Architecture Documentation

### Strategy Pattern: Build-Time Discriminator

The dual-binary approach uses a compile-time Strategy discriminator (`__ATOMIC_BASELINE__`) to control runtime artifact selection:

```
                    Build Time                          Runtime (Self-Update)
                    ----------                          ---------------------

  publish.yml                                     download.ts
  +-----------------------------------------+     +------------------------------------+
  | --target=bun-windows-x64                |     | getBinaryFilename()                |
  |   build-binary.ts:                      |     |   __ATOMIC_BASELINE__ undefined    |
  |     isBaseline = false                  | --> |   -> "atomic-windows-x64.exe"      |
  |     define: {} (no flag)                |     +------------------------------------+
  |   -> atomic-windows-x64.exe (AVX)      |
  +-----------------------------------------+
                                                  +------------------------------------+
  +-----------------------------------------+     | getBinaryFilename()                |
  | --target=bun-windows-x64-baseline       |     |   __ATOMIC_BASELINE__ = true       |
  |   build-binary.ts:                      | --> |   -> "atomic-windows-x64-baseline  |
  |     isBaseline = true                   |     |       .exe"                        |
  |     define: {__ATOMIC_BASELINE__: true} |     +------------------------------------+
  |   -> atomic-windows-x64-baseline.exe    |
  +-----------------------------------------+
```

**Why Strategy, not runtime detection:** Under Prism emulation, `process.arch === "x64"` and `process.platform === "win32"` -- identical to native x64. There is no reliable runtime signal to distinguish the two environments. The build-time flag is the only deterministic discriminator.

### Self-Update Flow (Post-Change)

```
User runs `atomic update`
  -> update.ts:242 calls getBinaryFilename()
    -> checks typeof __ATOMIC_BASELINE__
      -> STANDARD build: undefined -> "atomic-windows-x64.exe"
      -> BASELINE build: true     -> "atomic-windows-x64-baseline.exe"
  -> getDownloadUrl(version, filename)
    -> "https://github.com/.../releases/download/v{ver}/{filename}"
  -> downloadFile() + verifyChecksum()
  -> replace current binary
```

The baseline binary always self-updates to the baseline artifact. The standard binary always self-updates to the standard artifact. No cross-contamination.

### Installer Flow (Post-Change)

```
install.ps1
  $Arch = $env:PROCESSOR_ARCHITECTURE
    "AMD64" -> $Target = "windows-x64.exe"           (standard, AVX)
    "ARM64" -> $Target = "windows-x64-baseline.exe"   (baseline, no AVX)
  Download: ${BaseUrl}/atomic-${Target}
  Checksum: grep $Target in checksums.txt
```

### CI Build Flow (Post-Change)

```
build job (ubuntu-latest):
  ...
  # Windows x64 (standard -- with AVX for native x64 users)
  bun run src/scripts/build-binary.ts --minify --target=bun-windows-x64 \
    --outfile dist/atomic-windows-x64.exe

  # Windows x64-baseline (AVX-free for ARM64 Prism compatibility)
  bun run src/scripts/build-binary.ts --minify --target=bun-windows-x64-baseline \
    --outfile dist/atomic-windows-x64-baseline.exe

release job:
  files: |
    ...
    dist/atomic-windows-x64.exe
    dist/atomic-windows-x64-baseline.exe
    ...
```

## Historical Context (from research/)

- `research/docs/2026-03-20-388-389-windows-arm64-support.md` -- Primary ARM64 research. Section 4, Approach A notes the single-binary tradeoff: _"Using `bun-windows-x64-baseline` instead of `bun-windows-x64` means native x64 Windows users also lose AVX optimizations."_ Open Question #9 explicitly raises the two-binary option.
- `specs/windows-arm64-support.md` -- Current spec (Draft/WIP). Section 7, Option F ("Ship two Windows binaries") was rejected as over-engineering. This research provides the implementation details to reconsider that decision.

## Related Research

- `research/docs/2026-03-20-388-389-windows-arm64-support.md` -- Primary ARM64 research (AVX/Prism analysis, TinyCC limitation, Bun version requirements)
- `specs/windows-arm64-support.md` -- Current spec (to be patched with dual-binary approach)

## Open Questions

1. **Cross-compilation of standard x64 from Linux:** The current branch builds Windows from `ubuntu-latest` using `--target=bun-windows-x64-baseline`. The **original** workflow used a dedicated `windows-latest` runner for Windows builds (for native dependency resolution). Cross-compiling the standard `bun-windows-x64` target from Linux needs validation -- `bun run prepare:opentui-bindings` already downloads all platform bindings, so this should work, but should be confirmed.

2. **`declare const __ATOMIC_BASELINE__` placement:** The TypeScript declaration for the build-time constant needs to live somewhere accessible to `download.ts`. Options: (a) `declare` directly in `download.ts`, (b) a `src/types/build-constants.d.ts` ambient declaration file, (c) inline `typeof` check without declaration. Option (a) is simplest and most localized.

3. **`define` value format:** Bun's `define` performs text substitution. `JSON.stringify(true)` produces the string `"true"` which Bun injects as the literal `true` (boolean). This means `typeof __ATOMIC_BASELINE__` would be `"boolean"`, not `"string"`. The check `typeof __ATOMIC_BASELINE__ !== "undefined"` works correctly in both cases (defined = `"boolean"`, undefined = `"undefined"`).
