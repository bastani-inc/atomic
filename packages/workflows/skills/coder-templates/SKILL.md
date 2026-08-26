---
name: coder-templates
description: Creates and updates Coder Registry workspace templates with agent setup, infrastructure provisioning, and module consumption
license: Apache-2.0. LICENSE.txt has complete terms
metadata:
    author: Coder Technologies, Inc.
    github-repo: https://github.com/coder/registry
    github-path: .agents/skills/coder-templates
    github-ref: refs/heads/main
    github-tree-sha: efc74987635b05ef203b49b67aee6a90559857fa
---

# Coder Templates

Coder workspace templates are complete workspace definitions that live under `registry/<namespace>/templates/<name>/` and provision the infrastructure that workspaces run on.

## Before You Start

Before writing or modifying any code:

1. **Understand the request.** What platform is the template targeting (Docker, AWS, GCP, Azure, Kubernetes)? What kind of workspace (VM, container, devcontainer)?
2. **Research existing templates and modules.** Look under `registry/` in this repo for similar templates and modules first; if you are not in the repo or cannot find a match, browse <https://registry.coder.com>. Read `main.tf` to understand patterns for that platform, especially how they handle agent setup, persistent storage, and module consumption. Prefer platform-specific helper modules (e.g. region selectors) that provide ready-made `coder_parameter` blocks over hard-coding option lists.
3. **Check provider docs.** Verify the infrastructure provider resources you plan to use. Check both the Coder provider and the platform provider (AWS, Docker, etc.) version-specific docs if needed.
4. **Clarify before building.** If the request is ambiguous (e.g. unclear platform, whether to use devcontainers vs plain VMs, what parameters to expose, or which namespace to use), ask for clarification rather than guessing. Never assume a namespace; always confirm with the user.
5. **Plan the structure.** Decide on infrastructure resources, what `coder_parameter` options to expose, which registry modules to consume, and whether additional files like cloud-init configs are needed. When the user describes requirements in terms of their development needs rather than specific Terraform changes (e.g. "I need Node 20 + Postgres 16" or "make this template work for data science"), summarize what you plan to add or change before proceeding. Keep it brief: list the parameters, modules, and infrastructure changes. Skip this for straightforward requests where the action is clear (e.g. "add the code-server module" or "change the default region to us-west-2").

When updating an existing template, read and understand all of its current resources, parameters, and module consumption before making changes. If you observe patterns that deviate from the coder template standards (e.g. missing metadata blocks, hardcoded values that should be parameters, inline implementations that existing modules could replace, missing error handling in scripts), note these to the user as improvement opportunities in your response.

Always prefer the proper implementation over a simpler shortcut. Templates are infrastructure that users depend on. Doing less work is not the same as reducing complexity if it leaves the template incomplete or fragile.

Features marked as "Premium" in this skill require a Coder Premium license. When your implementation uses a Premium feature, note this in your response to the user so they can verify their deployment supports it.

## Documentation References

### Coder

- Platform docs (latest): <https://coder.com/docs>
- Version-specific docs: `https://coder.com/docs/@v{MAJOR}.{MINOR}.{PATCH}` (e.g. <https://coder.com/docs/@v2.31.5>)
- Creating templates: <https://coder.com/docs/admin/templates/creating-templates>
- Extending templates: <https://coder.com/docs/admin/templates/extending-templates>
- Template parameters: <https://coder.com/docs/admin/templates/extending-templates/parameters>
- Dynamic parameters: <https://coder.com/docs/admin/templates/extending-templates/dynamic-parameters>
- Workspace presets: <https://coder.com/docs/admin/templates/extending-templates/parameters#workspace-presets>
- Prebuilt workspaces: <https://coder.com/docs/admin/templates/extending-templates/prebuilt-workspaces>
- Agent Boundaries: <https://coder.com/docs/ai-coder/agent-boundaries>
- Coder Registry: <https://registry.coder.com>

### Coder Terraform provider

- Provider docs (latest): <https://registry.terraform.io/providers/coder/coder/latest/docs>
- Version-specific provider docs: replace `latest` with a version number (e.g. <https://registry.terraform.io/providers/coder/coder/2.13.1/docs>)

Resources:

| Resource         | Docs                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------ |
| `coder_agent`    | <https://registry.terraform.io/providers/coder/coder/latest/docs/resources/agent>    |
| `coder_app`      | <https://registry.terraform.io/providers/coder/coder/latest/docs/resources/app>      |
| `coder_script`   | <https://registry.terraform.io/providers/coder/coder/latest/docs/resources/script>   |
| `coder_env`      | <https://registry.terraform.io/providers/coder/coder/latest/docs/resources/env>      |
| `coder_metadata` | <https://registry.terraform.io/providers/coder/coder/latest/docs/resources/metadata> |

Data sources:

| Data Source              | Docs                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `coder_parameter`        | <https://registry.terraform.io/providers/coder/coder/latest/docs/data-sources/parameter>        |
| `coder_workspace`        | <https://registry.terraform.io/providers/coder/coder/latest/docs/data-sources/workspace>        |
| `coder_workspace_owner`  | <https://registry.terraform.io/providers/coder/coder/latest/docs/data-sources/workspace_owner>  |
| `coder_provisioner`      | <https://registry.terraform.io/providers/coder/coder/latest/docs/data-sources/provisioner>      |
| `coder_workspace_preset` | <https://registry.terraform.io/providers/coder/coder/latest/docs/data-sources/workspace_preset> |

### Terraform providers commonly used in templates

All provider docs follow `https://registry.terraform.io/providers/ORG/NAME/latest/docs`:

| Provider   | Source                 |
| ---------- | ---------------------- |
| Docker     | `kreuzwerker/docker`   |
| AWS        | `hashicorp/aws`        |
| Azure      | `hashicorp/azurerm`    |
| GCP        | `hashicorp/google`     |
| Kubernetes | `hashicorp/kubernetes` |
| Cloud-Init | `hashicorp/cloudinit`  |

Browse all providers: <https://registry.terraform.io/browse/providers>

## Scaffolding a New Template

Only use this when creating a brand new template that does not yet exist. When updating an existing template, edit its files directly.

From repo root:

```bash
./scripts/new_template.sh namespace/template-name
```

Names must be lowercase alphanumeric with hyphens (e.g. `my-org/aws-ec2`). Underscores are not allowed.

Creates `registry/<namespace>/templates/<template-name>/` with:

- `main.tf`: full workspace Terraform config with common patterns — read this as the primary reference for template structure
- `README.md`: frontmatter and documentation

If the namespace is new, the script also creates `registry/<namespace>/` with a README. New namespaces additionally need:

- `registry/<namespace>/.images/avatar.svg` (or `.png`): square image, 400x400px minimum
- The namespace README `avatar` field pointing to `./.images/avatar.svg`

The scaffolding script does not create the `.images/` directory or avatar file. When a new namespace is created, create `registry/<namespace>/.images/` and add a placeholder `avatar.svg` so the directory structure is ready for the user to replace with their real avatar.

The generated namespace README contains placeholder fields (`display_name`, `bio`, `status`, `github`, `avatar`, etc.) that the user must fill out. The `status` field is required and must be `official`, `partner`, or `community` (typically `community` for new contributors).

## Key Patterns

- Provider version constraints must reflect actual functionality requirements. Only set a minimum `coder` provider version when the template uses a resource, attribute, or behavior introduced in that version. The same applies to infrastructure providers (Docker, AWS, etc.); check provider changelogs to confirm.
- Include `data.coder_workspace.me` and `data.coder_workspace_owner.me` for workspace and owner metadata. Include `data.coder_provisioner.me` only when you need the provisioner's `arch` or `os` for `coder_agent` (typical for Docker, Kubernetes, Incus); omit when the workspace OS/arch is fixed (e.g. cloud VMs with a known image).
- Use `locals {}` for computed values: username, environment variables, startup scripts, URL assembly
- Use `data.coder_workspace.me.start_count` as `count` on ephemeral resources
- Connect containers/VMs to the agent via `coder_agent.main.init_script` and `CODER_AGENT_TOKEN`
- Add `metadata` blocks for workspace dashboard stats (`coder stat cpu`, `coder stat mem`, etc.)
- Use `coder_metadata` on the primary compute resource to surface key details (region, instance type, image, disk size) in the workspace dashboard
- Optionally use `display_apps` block to hide specific built-in apps (defaults show all)
- Before implementing functionality from scratch, look for an existing module under `registry/*/modules/` in this repo; if you cannot find one or are not in the repo, search <https://registry.coder.com>. If a module already exists for what you need, consume it rather than reimplementing it. When multiple modules serve similar purposes, prefer the actively maintained one and check that you are not using a deprecated or superseded module.
- Before consuming a module, read its `main.tf` and `README.md` to understand the full interface: accepted variables, outputs, prerequisites, and runtime requirements. Prefer paths under `registry/<namespace>/modules/<name>/` in this workspace; otherwise use `https://registry.coder.com/modules/<namespace>/<module-name>`. Never pass arguments without confirming they exist.
- After identifying a module's prerequisites, verify the template's base image satisfies them. If it lacks a required tool, either switch to an image that includes it or ensure the prerequisite is installed before the module's script runs. These runtime issues are not caught by `terraform validate`; they only surface when the workspace starts.
- Module source URLs use `registry.coder.com/<namespace>/<module>/coder`. Older templates may use `registry.coder.com/modules/...`; prefer the shorter form when writing new modules or templates.
- Label infrastructure resources with `coder.owner` and `coder.workspace_id` for tracking orphans
- Use `lifecycle { ignore_changes = all }` on persistent volumes to prevent data loss
- Do not add comments that narrate what the code does or label sections. Only comment when explaining something non-obvious (e.g. why a workaround exists, a subtle constraint, or an unusual design choice).

### Additional files

Templates can include files beyond `main.tf` + `README.md`:

- `cloud-init/*.tftpl`: cloud-init configs for VM provisioning (AWS, Azure, GCP), loaded via `templatefile()`. Prefer this subdirectory over placing cloud-init files at the template root.
- `build/Dockerfile`: custom container images built by the template
- `.tftpl` files: any Terraform template files for scripts, configs, or cloud-init data

### Parameters

Use `data "coder_parameter"` for user-facing workspace options. Typical parameters: region/instance type/CPU/memory/disk for cloud VMs; container image or runtime version for Docker (pass as `build_arg` when using a local Dockerfile). Use same-platform templates in `registry/` as a starting reference, not a rigid pattern. Expose stated preferences as the parameter `default` with additional sensible `option` values unless the user explicitly restricts it.

- Prefer `dynamic "option"` blocks with `for_each` from a `locals` map over static `option` blocks. See the region selector modules (e.g. `coder/aws-region`) for the pattern.
- Use `form_type` for richer UI controls: `dropdown` (searchable), `multi-select` (for `list(string)`), `slider` (numeric), `radio`, `checkbox`, `textarea`.
- Conditional parameters: use `count` to show/hide a parameter based on another parameter's value.
- `mutable = false` for infrastructure that can't change after creation (region, disk); `mutable = true` for runtime config.
- `ephemeral = true` for one-shot build options that don't persist between starts.
- `validation {}` with `min`/`max`/`monotonic` for numbers, `regex`/`error` for strings.
- Dynamic parameter features require Coder provider `>= 2.4.0`.

### Presets

Workspace presets bundle commonly-used parameter combinations into selectable options. When a user creates a workspace, they can pick a preset to auto-fill multiple parameters at once. Define presets with `data "coder_workspace_preset"`:

```tf
data "coder_workspace_preset" "default" {
  name    = "Standard Dev Environment"
  default = true

  parameters = {
    "region"          = "us-east-1"
    "cpu"             = "4"
    "memory"          = "8"
    "container_image" = "codercom/enterprise-base:ubuntu"
  }
}
```

- The keys in `parameters` must match the `name` attribute of `coder_parameter` data sources in the same template.
- Set `default = true` on at most one preset to pre-select it in the UI.
- A template can define multiple presets for different use cases.
- Optional fields: `description` (context text in UI) and `icon` (e.g. `/emojis/1f680.png`).

### Prebuilds (Premium)

Prebuilds maintain an automatically-managed pool of pre-provisioned workspaces for a preset, reducing workspace creation time. This is a Premium feature. Prebuilds are configured as a nested block inside a preset:

```tf
data "coder_workspace_preset" "goland" {
  name = "GoLand: Large"
  parameters = {
    "jetbrains_ide" = "GO"
    "cpu"           = "8"
    "memory"        = "16"
  }

  prebuilds {
    instances = 3

    expiration_policy {
      ttl = 86400
    }

    scheduling {
      timezone = "UTC"
      schedule {
        cron      = "* 8-18 * * 1-5"
        instances = 5
      }
    }
  }
}
```

- `instances`: number of prebuilt workspaces to keep in the pool (base count when no schedule matches).
- `expiration_policy.ttl`: seconds before unclaimed prebuilds are cleaned up.
- `scheduling`: scale the pool up or down on a time-based cron schedule. The `cron` minute field must always be `*`.
- The preset must define all required parameters needed to build the workspace.
- When a prebuild is claimed, ownership transfers to the real user. Use `lifecycle { ignore_changes = [...] }` on resources that reference owner-specific values to prevent unnecessary recreation.

## README.md

Required YAML frontmatter:

```yaml
---
display_name: Docker Containers
description: Provision Docker containers with persistent home volumes as Coder workspaces
icon: ../../../../.icons/docker.svg
verified: false
tags: [docker, container]
---
```

Content rules:

- Single H1 heading matching `display_name`, directly below frontmatter
- When increasing header levels, increment by one each time (h1 -> h2 -> h3, not h1 -> h3)
- Opening paragraph describing what the template provisions. Be specific about the platform, compute type, and key capabilities (e.g. "Provision Kubernetes pods on an existing Amazon EKS cluster as Coder workspaces with persistent home volumes") rather than generic (e.g. "AWS Kubernetes template"). The frontmatter `description` field should follow the same principle.
- **Prerequisites** section (infrastructure requirements, provider credentials)
- **Architecture** section (what resources are created, what's ephemeral vs persistent)
- Code fences labeled `tf` (NOT `hcl`)
- Relative icon paths (e.g. `../../../../.icons/`)
- **Do NOT include tables or lists that enumerate variables, parameters, or outputs.** The registry generates variable and output documentation automatically from the Terraform source. Workspace parameter options are visible in the Coder UI. Describe what the template does and how to use it in prose, not by listing every configurable field.
- Use [GFM alerts](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#alerts) for callouts: `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]`

## Icons

Templates reference icons in the README frontmatter `icon:` field using a relative path to the repo's `.icons/` directory (e.g. `../../../../.icons/aws.svg`). This icon is displayed on the registry website.

Workflow:

1. **Check what exists.** List the `.icons/` directory at the repo root for available SVGs.
2. **Use existing icons when they fit.** Most templates use a platform icon (aws, gcp, azure, docker, kubernetes) that already exists.
3. **When an icon doesn't exist,** reference the expected path anyway so the structure is correct. Try to source the official SVG from the platform's branding page or repository. If you can obtain it, add it to `.icons/` in this repo.
4. **Don't substitute a generic icon.** If the platform has its own brand identity, use the correct name even if the file doesn't exist yet.
5. **Track missing icons** so you can report them in your response.

## Testing

Templates do NOT require `.tftest.hcl` or `main.test.ts`. Testing is done by pushing the template to a Coder deployment.

## Commands

| Task       | Command                           | Scope |
| ---------- | --------------------------------- | ----- |
| Format all | `bun run fmt`                     | Repo  |
| Validate   | `./scripts/terraform_validate.sh` | Repo  |
| ShellCheck | `bun run shellcheck`              | Repo  |

## Final Checks

Before considering the work complete, verify:

- `terraform init && terraform validate` passes in the template directory
- `bun run fmt` has been run
- `bun run shellcheck` passes if the template includes shell scripts
- README documents prerequisites and architecture
- Shell scripts handle errors gracefully (`|| echo "Warning..."` for non-fatal failures). If a script sources external files (`$HOME/.bashrc`, `/etc/bashrc`, `/etc/os-release`), the `source` must come before `set -u`; CI enforces this ordering.
- No hardcoded values that should be configurable via variables or parameters
- Asset and icon paths in frontmatter and Terraform must be relative (e.g. `../../../../.icons/`), not absolute. External hyperlinks to docs or other websites are fine.

## Response to the User

In your response, include:

- A ready-to-run push command with real values filled in. Use `-d` to point at the template directory (so it works from the repo root), `-m` for a short description, and `-y` to skip interactive prompts:

```bash
coder templates push \
  registry/ \
  -m "Initial version: <brief description>" \
  -y < template-name > -d < namespace > /templates/ < template-name > /
```

- If a new namespace was created, remind the user to fill out the namespace README (`display_name`, `bio`, `status`, `github`, etc.) and replace the placeholder avatar. Note that this is only needed if they plan to contribute to the registry.
- If any icons were referenced but not found, list them and note they need to be sourced and added to both this repo's `.icons/` directory and the `coder/coder` repo at `site/static/icon/`.
- A note that to contribute the template to the public registry, they can open a pull request to <https://github.com/coder/registry>.
