(no external research applicable)

The partition contains a single Windows PowerShell installer script (`install.ps1`) that is pure distribution infrastructure with no package manifest and no external library or SDK dependencies. Its only external interaction is a raw HTTPS download from GitHub Releases plus SHA256 checksum validation using built-in PowerShell cmdlets — neither of which requires third-party library documentation. Nothing in this partition is affected by the planned removal of tmux, Claude Agent SDK, GitHub Copilot CLI/SDK, or OpenCode SDK dependencies.
