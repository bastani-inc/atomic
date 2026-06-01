---
date: 2026-01-21 05:58:31 UTC
researcher: Claude Code
git_commit: 38273399ecd104aff56275907e0cbff6e8c07011
branch: main
repository: atomic
topic: "Binary Distribution via GitHub Releases and Shell Installer Scripts"
tags:
    [
        research,
        codebase,
        binary-distribution,
        github-releases,
        installer-scripts,
        curl-bash,
        powershell,
    ]
status: complete
last_updated: 2026-01-21
last_updated_by: Claude Code
last_updated_note: "Updated with user decisions on PATH auto-modification, checksum verification, and URL hosting"
---

# Research: Binary Distribution and Installer Scripts

## Research Question

Research the codebase and best practices to release binary publish for each platform that can be installed from GitHub Releases (in publish.yml). Then, have the ability to install the binary using: `curl -fsSL https://atomic/install.sh | bash` and `irm https://atomic/install.ps1 | iex` or similar.

## Summary

This document covers the current state of Atomic CLI's binary distribution setup and best practices for creating shell-based installer scripts. The Atomic CLI already has a robust multi-platform binary compilation workflow in `publish.yml` using Bun's cross-compilation. To enable `curl | bash` style installation, the project needs to add `install.sh` and `install.ps1` scripts that detect platform/architecture, download the appropriate binary from GitHub Releases, and configure the user's PATH.

## Detailed Findings

### 1. Current Build and Distribution Setup

#### Binary Compilation (`.github/workflows/publish.yml:34-51`)

The existing workflow compiles binaries for five platform/architecture combinations using Bun's cross-compilation:

```bash
# Linux x64
bun build src/index.ts --compile --minify --target=bun-linux-x64 --outfile dist/atomic-linux-x64

# Linux arm64
bun build src/index.ts --compile --minify --target=bun-linux-arm64 --outfile dist/atomic-linux-arm64

# macOS x64
bun build src/index.ts --compile --minify --target=bun-darwin-x64 --outfile dist/atomic-darwin-x64

# macOS arm64 (Apple Silicon)
bun build src/index.ts --compile --minify --target=bun-darwin-arm64 --outfile dist/atomic-darwin-arm64

# Windows x64
bun build src/index.ts --compile --minify --target=bun-windows-x64 --outfile dist/atomic-windows-x64.exe
```

#### Current Asset Naming

```
atomic-linux-x64
atomic-linux-arm64
atomic-darwin-x64
atomic-darwin-arm64
atomic-windows-x64.exe
checksums.txt
```

#### Release Upload (`.github/workflows/publish.yml:83-97`)

Uses `softprops/action-gh-release@v2` with:

- SHA256 checksums via `sha256sum * > checksums.txt`
- Auto-generated release notes
- Version tag from `package.json`

### 2. Platform Detection Patterns

#### Unix Shell (from Bun, Deno, Starship examples)

```bash
# Basic detection
platform=$(uname -ms)

case $platform in
'Darwin x86_64')
    target=darwin-x64
    ;;
'Darwin arm64')
    target=darwin-arm64
    ;;
'Linux aarch64' | 'Linux arm64')
    target=linux-arm64
    ;;
'Linux x86_64' | *)
    target=linux-x64
    ;;
esac
```

**Rosetta 2 Detection (macOS Intel emulation on Apple Silicon)**:

```bash
if [[ $target = darwin-x64 ]]; then
    if [[ $(sysctl -n sysctl.proc_translated 2>/dev/null) = 1 ]]; then
        target=darwin-arm64
        info "Your shell is running in Rosetta 2. Downloading native arm64 binary."
    fi
fi
```

**Windows Detection and Delegation**:

```bash
if [[ ${OS:-} = Windows_NT ]]; then
    powershell -c "irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1 | iex"
    exit $?
fi
```

#### Windows PowerShell (from Bun, Deno examples)

```powershell
# OS version check (Windows 10 1809+ required for most tools)
$WinVer = [System.Environment]::OSVersion.Version
if ($WinVer.Major -lt 10) {
    Write-Warning "Windows 10 or later is required"
    return 1
}

# Architecture check
if (-not ((Get-CimInstance Win32_ComputerSystem)).SystemType -match "x64-based") {
    Write-Output "Currently only available for x86_64 Windows"
    return 1
}
```

### 3. Download URL Patterns

Based on the current `publish.yml` setup, the download URLs will follow this pattern:

```
# Latest release
https://github.com/bastani-inc/atomic/releases/latest/download/atomic-{target}

# Specific version
https://github.com/bastani-inc/atomic/releases/download/v{version}/atomic-{target}
```

**Target Mapping**:
| Platform/Arch | Target Name |
|---------------|-------------|
| Linux x64 | `linux-x64` |
| Linux arm64 | `linux-arm64` |
| macOS x64 | `darwin-x64` |
| macOS arm64 | `darwin-arm64` |
| Windows x64 | `windows-x64.exe` |

### 4. Installation Directory Configuration

#### Decided Locations

| Platform    | Default Path               | Environment Override |
| ----------- | -------------------------- | -------------------- |
| Linux/macOS | `$HOME/.local/bin`         | `ATOMIC_INSTALL`     |
| Windows     | `%USERPROFILE%\.local\bin` | `ATOMIC_INSTALL`     |

**Rationale**:

- `~/.local/bin` follows XDG Base Directory spec and is commonly in PATH on modern systems
- User-writable directory that doesn't require sudo/admin privileges
- Windows uses equivalent local directory to avoid requiring admin privileges

#### Alternative Patterns (Not Used)

Other tools use:

- Tool-specific: `~/.bun/bin`, `~/.deno/bin`, `~/.cargo/bin`
- `/usr/local/bin` (system-wide, requires sudo)

### 5. PATH Auto-Modification (Decided)

The install scripts will **automatically modify shell configuration files** to add the binary directory to PATH, similar to NVM and Rustup behavior.

#### Unix Shell Detection and Auto-Configuration

```bash
# Detect shell and config file
detect_shell_config() {
    case $(basename "$SHELL") in
    fish)
        echo "$HOME/.config/fish/config.fish"
        ;;
    zsh)
        echo "$HOME/.zshrc"
        ;;
    bash)
        # Check multiple locations in order of preference
        for f in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
            [[ -f "$f" ]] && echo "$f" && return
        done
        echo "$HOME/.bashrc"  # Default
        ;;
    *)
        echo "$HOME/.profile"  # Fallback
        ;;
    esac
}

# Add to PATH if not already present
add_to_path() {
    local config_file="$1"
    local bin_dir="$2"
    local path_line="export PATH=\"${bin_dir}:\$PATH\""

    # Fish uses different syntax
    if [[ "$config_file" == *"fish"* ]]; then
        path_line="fish_add_path ${bin_dir}"
    fi

    # Check if already in config
    if ! grep -q "$bin_dir" "$config_file" 2>/dev/null; then
        echo "" >> "$config_file"
        echo "# Added by Atomic CLI installer" >> "$config_file"
        echo "$path_line" >> "$config_file"
        info "Added ${bin_dir} to PATH in ${config_file}"
    fi
}
```

#### Windows PATH Modification (Registry-Based)

Uses user-level registry to avoid admin privileges:

```powershell
# Modify user PATH via registry (no admin required)
$UserPath = [System.Environment]::GetEnvironmentVariable('Path', 'User')
if ($UserPath -notlike "*${BinDir}*") {
    [System.Environment]::SetEnvironmentVariable('Path', "${BinDir};${UserPath}", 'User')
    $env:Path = "${BinDir};${env:Path}"

    # Broadcast WM_SETTINGCHANGE for immediate visibility in new terminals
    Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @"
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(
    IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
    uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
"@
    [Win32.NativeMethods]::SendMessageTimeout(0xFFFF, 0x1A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$null)
}
```

### 6. Checksum Verification (Required)

Checksum verification will be **mandatory** for security. The install scripts will verify SHA256 checksums before executing binaries.

#### Current Workflow Implementation

The `publish.yml` creates checksums:

```yaml
- name: Create checksums
  run: |
      cd dist
      sha256sum * > checksums.txt
```

#### Unix Checksum Verification

```bash
# Download checksum file
checksums_url="https://github.com/${GITHUB_REPO}/releases/download/${version}/checksums.txt"
curl -fsSL "$checksums_url" -o "${tmp_dir}/checksums.txt" ||
    error "Failed to download checksums"

# Verify downloaded binary (supports both Linux and macOS)
verify_checksum() {
    local file="$1"
    local checksums="$2"

    cd "$(dirname "$file")"
    local filename=$(basename "$file")

    if command -v sha256sum >/dev/null; then
        grep "$filename" "$checksums" | sha256sum -c --quiet
    elif command -v shasum >/dev/null; then
        grep "$filename" "$checksums" | shasum -a 256 -c --quiet
    else
        error "Neither sha256sum nor shasum found for verification"
    fi
}

verify_checksum "${tmp_dir}/${BINARY_NAME}" "${tmp_dir}/checksums.txt" ||
    error "Checksum verification failed! Binary may be corrupted or tampered with."
```

#### Windows Checksum Verification

```powershell
# Download and verify checksum
$ChecksumsUrl = "https://github.com/${GithubRepo}/releases/download/${Version}/checksums.txt"
$ChecksumsPath = "${TempDir}\checksums.txt"
Invoke-WebRequest -Uri $ChecksumsUrl -OutFile $ChecksumsPath -UseBasicParsing

# Parse expected checksum for our binary
$ExpectedLine = Get-Content $ChecksumsPath | Where-Object { $_ -match $Target }
$ExpectedHash = ($ExpectedLine -split '\s+')[0]

# Calculate actual checksum
$ActualHash = (Get-FileHash -Path $BinaryPath -Algorithm SHA256).Hash.ToLower()

if ($ActualHash -ne $ExpectedHash) {
    Write-Err "Checksum verification failed!"
    Write-Err "Expected: $ExpectedHash"
    Write-Err "Actual:   $ActualHash"
    Remove-Item $BinaryPath -Force
    return 1
}
Write-Info "Checksum verified successfully"
```

**Security Note**: While most popular tools (Bun, Deno, Starship) rely only on HTTPS, we include checksum verification for additional security against compromised mirrors or CDN issues.

### 7. Error Handling Best Practices

#### Unix Shell

```bash
set -euo pipefail  # Exit on error, undefined vars, pipe failures

error() {
    echo -e "\033[0;31merror\033[0m: $*" >&2
    exit 1
}

info() {
    echo -e "\033[0;34minfo\033[0m: $*"
}

# Dependency check
command -v curl >/dev/null || error "curl is required to install atomic"

# Download with error handling
curl --fail --location --progress-bar --output "$exe" "$download_url" ||
    error "Failed to download atomic from \"$download_url\""
```

#### PowerShell

```powershell
$ErrorActionPreference = 'Stop'

# Download with fallback
try {
    curl.exe "-#SfLo" "$ZipPath" "$URL"
} catch {
    Write-Warning "curl.exe failed, trying Invoke-RestMethod..."
    Invoke-RestMethod -Uri $URL -OutFile $ZipPath
}
```

### 8. URL Hosting (Decided)

**Decision**: Use GitHub raw URLs directly. No custom domain needed.

| Option         | URL Pattern                                                    | Status       |
| -------------- | -------------------------------------------------------------- | ------------ |
| **GitHub Raw** | `raw.githubusercontent.com/bastani-inc/atomic/main/install.sh` | **Selected** |
| Custom Domain  | N/A                                                            | Not needed   |

**Final Installation Commands**:

```bash
# Linux/macOS
curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | bash

# Windows PowerShell
irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1 | iex
```

### 9. Script Parameter Support

#### Unix

```bash
# Version parameter (positional or flag)
version=${1:-latest}

# Or with getopts
while getopts "v:b:h" opt; do
    case $opt in
        v) version="$OPTARG" ;;
        b) bin_dir="$OPTARG" ;;
        h) usage; exit 0 ;;
    esac
done
```

**Usage**:

```bash
curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | bash
curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | bash -s -- v1.0.0
curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | bash -s -- -b /usr/local/bin
```

#### PowerShell

```powershell
param(
    [String]$Version = "latest",
    [String]$InstallDir = "",
    [Switch]$NoPathUpdate = $false
)
```

**Usage**:

```powershell
irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1 | iex
iex "& { $(irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1) } -Version v1.0.0"
```

### 10. Complete Install Script Templates

These templates incorporate all decided requirements:

- Install to `~/.local/bin` (Unix) / `%USERPROFILE%\.local\bin` (Windows)
- Auto-modify shell configs for PATH
- SHA256 checksum verification
- No admin/sudo required

#### install.sh Template

```bash
#!/bin/bash
# Atomic CLI Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | bash

set -euo pipefail

# Configuration
GITHUB_REPO="bastani-inc/atomic"
BINARY_NAME="atomic"
BIN_DIR="${ATOMIC_INSTALL:-$HOME/.local/bin}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

info() { echo -e "${BLUE}info${NC}: $*"; }
success() { echo -e "${GREEN}success${NC}: $*"; }
warn() { echo -e "${YELLOW}warn${NC}: $*"; }
error() { echo -e "${RED}error${NC}: $*" >&2; exit 1; }

# Detect platform
detect_platform() {
    local os arch
    os=$(uname -s | tr '[:upper:]' '[:lower:]')
    arch=$(uname -m)

    case "$os" in
        linux) os="linux" ;;
        darwin) os="darwin" ;;
        mingw*|msys*|cygwin*)
            # Delegate to PowerShell on Windows
            powershell -c "irm https://raw.githubusercontent.com/${GITHUB_REPO}/main/install.ps1 | iex"
            exit $?
            ;;
        *) error "Unsupported OS: $os" ;;
    esac

    case "$arch" in
        x86_64|amd64) arch="x64" ;;
        arm64|aarch64) arch="arm64" ;;
        *) error "Unsupported architecture: $arch" ;;
    esac

    # Detect Rosetta 2
    if [[ "$os" == "darwin" && "$arch" == "x64" ]]; then
        if [[ $(sysctl -n sysctl.proc_translated 2>/dev/null) == "1" ]]; then
            info "Detected Rosetta 2, using native arm64 binary"
            arch="arm64"
        fi
    fi

    echo "${os}-${arch}"
}

# Detect shell config file
detect_shell_config() {
    case $(basename "${SHELL:-bash}") in
    fish)
        echo "$HOME/.config/fish/config.fish"
        ;;
    zsh)
        echo "$HOME/.zshrc"
        ;;
    bash)
        for f in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
            [[ -f "$f" ]] && echo "$f" && return
        done
        echo "$HOME/.bashrc"
        ;;
    *)
        echo "$HOME/.profile"
        ;;
    esac
}

# Add to PATH in shell config
add_to_path() {
    local config_file="$1"
    local path_line

    # Fish uses different syntax
    if [[ "$config_file" == *"fish"* ]]; then
        path_line="fish_add_path $BIN_DIR"
    else
        path_line="export PATH=\"$BIN_DIR:\$PATH\""
    fi

    # Create config file if it doesn't exist
    mkdir -p "$(dirname "$config_file")"
    touch "$config_file"

    # Check if already in config
    if ! grep -q "$BIN_DIR" "$config_file" 2>/dev/null; then
        {
            echo ""
            echo "# Added by Atomic CLI installer"
            echo "$path_line"
        } >> "$config_file"
        info "Added $BIN_DIR to PATH in $config_file"
        return 0
    fi
    return 1
}

# Verify checksum
verify_checksum() {
    local file="$1"
    local checksums_file="$2"
    local filename
    filename=$(basename "$file")

    local expected
    expected=$(grep "$filename" "$checksums_file" | awk '{print $1}')

    if [[ -z "$expected" ]]; then
        error "Could not find checksum for $filename"
    fi

    local actual
    if command -v sha256sum >/dev/null; then
        actual=$(sha256sum "$file" | awk '{print $1}')
    elif command -v shasum >/dev/null; then
        actual=$(shasum -a 256 "$file" | awk '{print $1}')
    else
        error "Neither sha256sum nor shasum found for verification"
    fi

    if [[ "$actual" != "$expected" ]]; then
        error "Checksum verification failed!\nExpected: $expected\nActual:   $actual"
    fi

    info "Checksum verified successfully"
}

# Get latest version
get_latest_version() {
    curl -fsSL "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" |
        grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/'
}

# Main installation
main() {
    local version="${1:-}"
    local platform download_url checksums_url tmp_dir

    # Check dependencies
    command -v curl >/dev/null || error "curl is required"

    # Detect platform
    platform=$(detect_platform)
    info "Detected platform: $platform"

    # Get version
    if [[ -z "$version" ]]; then
        version=$(get_latest_version)
        info "Latest version: $version"
    fi

    # Setup directories
    mkdir -p "$BIN_DIR"
    tmp_dir=$(mktemp -d)
    trap "rm -rf $tmp_dir" EXIT

    # Download URLs
    local base_url="https://github.com/${GITHUB_REPO}/releases/download/${version}"
    download_url="${base_url}/${BINARY_NAME}-${platform}"
    checksums_url="${base_url}/checksums.txt"

    # Download binary
    info "Downloading ${BINARY_NAME} ${version}..."
    curl --fail --location --progress-bar --output "${tmp_dir}/${BINARY_NAME}-${platform}" "$download_url" ||
        error "Failed to download binary"

    # Download checksums
    info "Downloading checksums..."
    curl -fsSL --output "${tmp_dir}/checksums.txt" "$checksums_url" ||
        error "Failed to download checksums"

    # Verify checksum
    verify_checksum "${tmp_dir}/${BINARY_NAME}-${platform}" "${tmp_dir}/checksums.txt"

    # Install binary
    mv "${tmp_dir}/${BINARY_NAME}-${platform}" "${BIN_DIR}/${BINARY_NAME}"
    chmod +x "${BIN_DIR}/${BINARY_NAME}"

    # Verify installation
    "${BIN_DIR}/${BINARY_NAME}" --version >/dev/null 2>&1 ||
        error "Installation verification failed"

    success "Installed ${BINARY_NAME} ${version} to ${BIN_DIR}/${BINARY_NAME}"

    # Update PATH in shell config
    if [[ ":$PATH:" != *":${BIN_DIR}:"* ]]; then
        local config_file
        config_file=$(detect_shell_config)

        if add_to_path "$config_file"; then
            echo ""
            warn "Restart your shell or run: source $config_file"
        fi
    fi

    echo ""
    success "Run 'atomic --help' to get started!"
}

main "$@"
```

#### install.ps1 Template

```powershell
# Atomic CLI Installer for Windows
# Usage: irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1 | iex

param(
    [String]$Version = "latest",
    [Switch]$NoPathUpdate = $false
)

$ErrorActionPreference = 'Stop'

# Configuration
$GithubRepo = "bastani-inc/atomic"
$BinaryName = "atomic"
$BinDir = if ($env:ATOMIC_INSTALL) { $env:ATOMIC_INSTALL } else { "${Home}\.local\bin" }

# Colors for output
$C_RESET = [char]27 + "[0m"
$C_RED = [char]27 + "[0;31m"
$C_GREEN = [char]27 + "[0;32m"
$C_BLUE = [char]27 + "[0;34m"
$C_YELLOW = [char]27 + "[0;33m"

function Write-Info { Write-Output "${C_BLUE}info${C_RESET}: $args" }
function Write-Success { Write-Output "${C_GREEN}success${C_RESET}: $args" }
function Write-Warn { Write-Output "${C_YELLOW}warn${C_RESET}: $args" }
function Write-Err { Write-Output "${C_RED}error${C_RESET}: $args" }

# Check architecture
if (-not ((Get-CimInstance Win32_ComputerSystem).SystemType -match "x64-based")) {
    Write-Err "Atomic CLI requires 64-bit Windows"
    return 1
}

Write-Info "Installing to: $BinDir"

# Create install directory
$null = New-Item -ItemType Directory -Force -Path $BinDir

# Get version
if ($Version -eq "latest") {
    Write-Info "Fetching latest version..."
    $Release = Invoke-RestMethod "https://api.github.com/repos/${GithubRepo}/releases/latest"
    $Version = $Release.tag_name
}
Write-Info "Installing version: $Version"

# Setup URLs
$Target = "windows-x64.exe"
$BaseUrl = "https://github.com/${GithubRepo}/releases/download/${Version}"
$DownloadUrl = "${BaseUrl}/${BinaryName}-${Target}"
$ChecksumsUrl = "${BaseUrl}/checksums.txt"
$BinaryPath = "${BinDir}\${BinaryName}.exe"

# Create temp directory
$TempDir = Join-Path $env:TEMP "atomic-install-$(Get-Random)"
$null = New-Item -ItemType Directory -Force -Path $TempDir
$TempBinary = "${TempDir}\${BinaryName}-${Target}"
$TempChecksums = "${TempDir}\checksums.txt"

try {
    # Download binary
    Write-Info "Downloading ${BinaryName}..."
    if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
        curl.exe "-#SfLo" $TempBinary $DownloadUrl
        if ($LASTEXITCODE -ne 0) { throw "curl failed" }
    } else {
        Invoke-WebRequest -Uri $DownloadUrl -OutFile $TempBinary -UseBasicParsing
    }

    # Download checksums
    Write-Info "Downloading checksums..."
    Invoke-WebRequest -Uri $ChecksumsUrl -OutFile $TempChecksums -UseBasicParsing

    # Verify checksum
    Write-Info "Verifying checksum..."
    $ExpectedLine = Get-Content $TempChecksums | Where-Object { $_ -match $Target }
    if (-not $ExpectedLine) {
        throw "Could not find checksum for $Target"
    }
    $ExpectedHash = ($ExpectedLine -split '\s+')[0].ToLower()
    $ActualHash = (Get-FileHash -Path $TempBinary -Algorithm SHA256).Hash.ToLower()

    if ($ActualHash -ne $ExpectedHash) {
        Write-Err "Checksum verification failed!"
        Write-Err "Expected: $ExpectedHash"
        Write-Err "Actual:   $ActualHash"
        return 1
    }
    Write-Info "Checksum verified successfully"

    # Install binary
    Move-Item -Force $TempBinary $BinaryPath

    # Verify installation
    & $BinaryPath --version | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Installation verification failed"
    }

    Write-Success "Installed ${BinaryName} ${Version} to ${BinaryPath}"

    # Update PATH
    if (-not $NoPathUpdate) {
        $UserPath = [System.Environment]::GetEnvironmentVariable('Path', 'User')
        if ($UserPath -notlike "*${BinDir}*") {
            [System.Environment]::SetEnvironmentVariable('Path', "${BinDir};${UserPath}", 'User')
            $env:Path = "${BinDir};${env:Path}"
            Write-Info "Added ${BinDir} to PATH"

            # Broadcast environment change
            Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @"
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(
    IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
    uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
"@
            $result = [UIntPtr]::Zero
            [Win32.NativeMethods]::SendMessageTimeout(
                [IntPtr]0xFFFF, 0x1A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result
            ) | Out-Null
        }
    }

    Write-Output ""
    Write-Success "Run 'atomic --help' to get started!"

} catch {
    Write-Err "Installation failed: $_"
    return 1
} finally {
    # Cleanup
    if (Test-Path $TempDir) {
        Remove-Item -Recurse -Force $TempDir
    }
}
```

## Code References

- `.github/workflows/publish.yml:34-51` - Multi-platform binary compilation
- `.github/workflows/publish.yml:79-82` - Checksum creation
- `.github/workflows/publish.yml:83-97` - GitHub Release upload with `softprops/action-gh-release@v2`
- `src/index.ts:1` - Bun shebang for npm distribution
- `package.json:19-21` - Bin configuration for npm
- `package.json:36-37` - Local build script

## Architecture Documentation

### Current Distribution Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     GitHub Release Created                       │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                        publish.yml                               │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────────────┐   │
│  │ Build Job   │──▶│ Release Job │   │ Publish npm Job     │   │
│  │ (binaries)  │   │ (assets)    │   │ (source + shebang)  │   │
│  └─────────────┘   └─────────────┘   └─────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                       GitHub Releases                            │
├─────────────────────────────────────────────────────────────────┤
│  atomic-linux-x64         atomic-darwin-x64                     │
│  atomic-linux-arm64       atomic-darwin-arm64                   │
│  atomic-windows-x64.exe   checksums.txt                         │
└─────────────────────────────────────────────────────────────────┘
```

### Proposed Installation Flow

```
┌──────────────────────────────────────────────────────────────────┐
│  curl -fsSL https://raw.githubusercontent.com/.../install.sh | bash │
└──────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│                       install.sh                                  │
├──────────────────────────────────────────────────────────────────┤
│  1. Detect OS/Arch (uname -ms)                                   │
│  2. Determine target (linux-x64, darwin-arm64, etc.)             │
│  3. Get latest version from GitHub API                           │
│  4. Download binary to temp directory                            │
│  5. Download checksums.txt                                        │
│  6. Verify SHA256 checksum                                        │
│  7. Move binary to ~/.local/bin/                                 │
│  8. Set execute permissions                                       │
│  9. Verify installation (--version)                              │
│  10. Auto-modify shell config for PATH                           │
└──────────────────────────────────────────────────────────────────┘
```

## Historical Context (from research/)

- `research/docs/2026-01-20-cross-platform-support.md` - Related research on cross-platform considerations

## Related Research

- [Bun install.sh source](https://github.com/oven-sh/bun/blob/main/src/cli/install.sh)
- [Deno install.sh source](https://github.com/denoland/deno_install/blob/master/install.sh)
- [Starship install.sh source](https://raw.githubusercontent.com/starship/starship/master/install/install.sh)
- [softprops/action-gh-release](https://github.com/softprops/action-gh-release)

## Decisions Made

| Question                  | Decision                                                    |
| ------------------------- | ----------------------------------------------------------- |
| **Custom domain**         | No - use `raw.githubusercontent.com` URLs directly          |
| **Checksum verification** | Yes - mandatory SHA256 verification for security            |
| **PATH modification**     | Auto-modify shell configs (like NVM/Rustup)                 |
| **Install directory**     | `~/.local/bin` (Unix), `%USERPROFILE%\.local\bin` (Windows) |
| **Admin privileges**      | Not required - install to user directories only             |

## Open Questions (Remaining)

1. **Windows ARM64 support**: Currently only x64 Windows is supported. Is ARM64 Windows support needed?

2. **Homebrew/Scoop distribution**: Should package manager distribution be added alongside curl|bash installers?

## Implementation Checklist

To enable curl|bash installation:

1. [ ] Create `install.sh` in repository root
2. [ ] Create `install.ps1` in repository root
3. [ ] Test install.sh on Linux x64, Linux arm64, macOS x64, macOS arm64
4. [ ] Test install.ps1 on Windows x64
5. [ ] Test checksum verification works correctly
6. [ ] Test PATH auto-modification for bash, zsh, fish
7. [ ] Update README with installation instructions
