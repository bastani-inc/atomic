---
name: gh-create-pr
description: Commit unstaged changes, push changes, submit a pull request.
metadata:
    internal: true
---

# Create Pull Request

Commit changes, push to remote, and create a pull request with a conventional commit-style title and comprehensive description: $ARGUMENTS

## Current Repository State

- Git status: !`git status --porcelain`
- Current branch: !`git branch --show-current`
- Default branch: !`git rev-parse --abbrev-ref origin/HEAD 2>/dev/null | sed 's|origin/||' || echo main`
- Staged changes: !`git diff --cached --stat`
- Unstaged changes: !`git diff --stat`
- Recent commits on this branch: !`git log --oneline -10`
- Existing PR for branch: !`gh pr view --json number,title,body 2>/dev/null || echo "No existing PR"`

## What This Command Does

1. **Stage and commit changes** using conventional commit format (follow the gh-commit skill conventions)
    - If there are unstaged changes, stage and commit them with appropriate conventional commit messages
    - If multiple distinct logical changes exist, create separate commits for each
    - ALWAYS attribute AI-assisted code authorship in commits
2. **Push the branch** to the remote repository
    - If the current branch is the default branch (main/master), create a new feature branch first
    - Use `git push -u origin <branch>` to set upstream tracking
3. **Analyze all changes** in the branch relative to the base branch
    - Run `git diff origin/<default-branch>...HEAD` to review the full scope of changes
    - Read relevant modified files to understand the context and impact of changes
4. **Generate a PR title** following Conventional Commits format:
    - Format: `<type>[optional scope]: <description>`
    - Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`
    - Use `!` after type/scope for breaking changes: `feat(api)!: change response format`
    - Keep the title concise (under 72 characters)
    - For multi-commit PRs, synthesize a higher-level title that captures the overall theme
5. **Generate a PR description** with the structure defined in the PR Description Template below
6. **Create or update the pull request**
    - If no PR exists for this branch: `gh pr create --title "TITLE" --body "DESCRIPTION"`
    - If a PR already exists: `gh pr edit <number> --title "TITLE" --body "DESCRIPTION"`

## PR Title Examples

```
feat(auth): add JWT token refresh endpoint
fix(ui): resolve layout shift on mobile navigation
docs: update API reference for v2 endpoints
refactor(db): migrate from raw SQL to query builder
feat(api)!: change pagination response format
chore(deps): bump TypeScript to 5.x
```

## PR Description Template

Use this structure for the PR body. Omit sections that are not applicable.

```markdown
## Summary

[1-2 sentence overview of what this PR does and why]

## Changes

- [Key change 1]
- [Key change 2]
- [Key change 3]

## Breaking Changes

[Describe what breaks and required migration steps]

## Notes

[Additional context, testing instructions, or deployment considerations]
```

## Guidelines

- **Respect existing content**: If the PR title already follows conventional commit format, keep it unless it's inaccurate. If a PR already has a meaningful description, enhance it rather than replace it entirely.
- **Issue references**: If the branch name contains an issue number (e.g., `feat/123-add-auth`), reference it in the description with `Closes #123` or `Refs #123`.
- **Holistic analysis**: The PR title should capture the overall intent of the changes, not just list individual commits.
- **Single-commit PRs**: The PR title can mirror the commit message.
- **Multi-commit PRs**: Synthesize a higher-level title that captures the full scope.
- Use markdown formatting in the description for readability.

## Important Notes

- By default, pre-commit checks (defined in `prek.toml`) will run to ensure code quality
    - IMPORTANT: DO NOT SKIP pre-commit checks
- ALWAYS attribute AI-Assisted Code Authorship in commit messages
- Always review the diff before generating the title and description to ensure accuracy
- If `gh` CLI is not authenticated, prompt the user to run `gh auth login` first
