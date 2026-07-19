# Security Policy

## Supported Versions

Security fixes are provided for the latest released version of Atomic. Before reporting a vulnerability, confirm that it is reproducible on the latest release.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Older releases | No |

## Reporting a Vulnerability

Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.

Use GitHub's [private vulnerability reporting form](https://github.com/bastani-inc/atomic/security/advisories/new) to submit a report confidentially. Include as much of the following information as possible:

- the affected Atomic version and platform
- a description of the vulnerability and its potential impact
- reproducible steps or a minimal proof of concept
- relevant logs, configuration, or screenshots with secrets removed
- any known mitigations or workarounds

We will acknowledge the report, investigate it, and provide status updates through the private advisory. Please allow time for a fix to be developed and released before publicly disclosing the vulnerability.

## Scope

Reports should demonstrate a security boundary violation, unauthorized access, or another concrete security impact. Atomic is a local coding agent that runs with the invoking user's permissions. Expected tool execution, access explicitly granted by the user, prompt injection from untrusted content without a privilege-boundary bypass, and behavior introduced by user-installed extensions or skills are generally outside the security boundary.

Thank you for helping keep Atomic and its users safe.
