(no external research applicable)

The `install.cmd` script is a self-contained Windows batch file with zero external library or package manager dependencies. It relies exclusively on Windows built-in tools — `curl` (ships with Windows 10+), `certutil` (SHA256 hashing), and `powershell` (JSON parsing via `ConvertFrom-Json`, regex validation) — plus plain HTTPS requests to GitHub Releases REST endpoints. There are no npm/bun packages, no SDKs, and no third-party frameworks in scope; therefore no external documentation is central to answering the research question for this partition.
