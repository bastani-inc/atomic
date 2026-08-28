# Plugins and Linter Extensions

> **Sources** (retrieved 2026-08-26): <https://docs.qlty.sh/cli/concepts/plugins.md> and
> <https://docs.qlty.sh/cli/linter-extensions.md>.
> Copied from those pages. Text and TOML examples are unchanged; MDX `<Note>`, `<Warning>`, and
> `<CodeGroup>` wrappers are rendered as Markdown blockquotes and separate code blocks, and
> relative links are expanded to absolute URLs. Full `qlty.toml` reference:
> <https://docs.qlty.sh/cli/qlty-toml.md>.

---

## Plugins

Qlty integrates with linters, auto-formatters, security scanners, and other static analysis tools as plugins.

> **Note:** Looking for plugin-specific configuration options, supported versions, or invocation
> details? Each plugin lives in its own folder under
> [qltysh/qlty/qlty-plugins](https://github.com/qltysh/qlty/tree/main/qlty-plugins) on GitHub —
> check the plugin's `plugin.toml` and `README.md` for specifics.

Each plugin consists of two components:

1. A plugin definition in a TOML configuration file
2. A results parser implemented in Rust

Here is a simplified example plugin definition for [Ruff](https://github.com/astral-sh/ruff):

```toml
# plugin.toml for ruff
config_version = "0"

[plugins.definitions.ruff]
runtime = "python"
package = "ruff"
file_types = ["python"]
version_command = "ruff version"
config_files = ["ruff.toml"]
issue_url_format = "https://docs.astral.sh/ruff/rules/${rule}"

[plugins.definitions.ruff.drivers.lint]
script = "ruff check --exit-zero --output-format sarif --output-file ${tmpfile}  ${target}"
success_codes = [0]
output = "tmpfile"
output_format = "sarif"
batch = true
```

Gitleaks supports outputting results in the [SARIF](https://sarifweb.azurewebsites.net/) standard format, so a custom results parser is not needed. For tools which do not support SARIF, a results parser is implemented within the Qlty CLI and referenced by name.

### Auto-Formatters

Auto-formatters are a special type of plugin because they *rewrite* files rather than outputting findings. Therefore, they do not require results parsers.

Here is an example of a plugin definition for the [shfmt](https://github.com/mvdan/sh) auto-formatter:

```toml
# plugin.toml for shfmt
config_version = "0"

[plugins.definitions.shfmt]
package = "mvdan.cc/sh/v${major_version}/cmd/shfmt"
runtime = "go"
file_types = ["shell"]
version_command = "shfmt --version"
affects_cache = [".editorconfig"]

[plugins.definitions.shfmt.drivers.format]
script = "shfmt -w -s ${target}"
success_codes = [0, 1]
output = "rewrite"
cache_results = true
batch = true
driver_type = "formatter"
```

Note the specification of `output = "rewrite"` and `driver_type = "formatter"`.

---

## Linter Extensions

Linter extensions are additional packages or plugins that extend the functionality of base linter tools that Qlty uses. Depending on the linter, extensions can add:

* Additional rule sets
* Custom rules
* Language support
* Framework-specific checks
* Additional parsers

For example, ESLint has numerous plugins like `eslint-plugin-react`, `eslint-plugin-security`, and `eslint-plugin-jest` that add specialized rules for React development, security checks, and Jest testing, respectively.

### Supported Package Managers

Qlty supports linter extensions through the following package managers:

* **NPM** (Node.js) - For JavaScript/TypeScript tools like ESLint, Stylelint, etc.
* **RubyGems** (Ruby) - For Ruby tools like RuboCop, Standard, etc.
* **PIP** (Python) - For Python tools like Ruff, Pylint, Bandit, etc.
* **Composer** (PHP) - For PHP tools like PHP\_CodeSniffer, PHPStan, etc.

### Managing linter extensions

Qlty provides two mutually exclusive ways to configure linter extensions in your `qlty.toml` file: `extra_packages` and `package_file`.

#### `extra_packages`

The `extra_packages` property allows you to explicitly list additional packages that should be installed alongside the main linter package (including their versions).

```toml
# qlty.toml
[[plugin]]
name = "eslint"
version = "8.57.0"
extra_packages = [
  "eslint-plugin-react@7.33.2",
  "eslint-plugin-jest@27.6.0"
]
```

This works best when your project contains a very limited set of extra packages (1-2), but does not scale well for moderate to complex projects.

**Pros:**

* Simple, direct specification
* Version pinning
* Works without existing package files

**Cons:**

* Duplicates existing dependency management (e.g. package.json)
* May diverge from project dependencies
* Supports external packages only (not, e.g. in Project packages)

#### `package_file`

The `package_file` property allows you to reference a package manager file (like `package.json` or `Gemfile`) to manage dependencies. Depending on your use case, you can point the `package_file` either at your project's main package file or at a specific file that contains the linter-related packages.

```toml
# Project package file
[[plugin]]
name = "eslint"
version = "8.57.0"
package_file = "package.json"
```

```toml
# Linter package file
[[plugin]]
name = "eslint"
version = "8.57.0"
package_file = ".qlty/configs/package.json"
```

**Pros:**

* Take advantage of package manager's dependency resolution
* Consistent with project dependencies (if pointing to the main package file)

**Cons:**

* Project's main package file contains many dependencies

##### `package_filters`

When using `package_file`, you can use `package_filters` to selectively include only specific packages from the package file. This will cause Qlty to *filter* the packages in the package file and only install the ones that match the filters.

This is most useful when you are pointing the `package_file` directive to your project's main package file, and you want to install only the linter-related packages. This can be used to speed up the installation of linters.

> **Warning:** You can achieve the same goal as package\_filters by using a separate package file
> which only contains linter dependencies. Because a separate package file's dependencies can be
> fully resolved using a lock file, we prefer this option.

```toml
# qlty.toml
[[plugin]]
name = "eslint"
version = "8.57.0"
package_file = "package.json"
package_filters = ["eslint"]
```

The `package_filters` option can offer a performance speed up or workaround issues installing the app dependencies at the tradeoff of additional complexity.

### Lock files

Package lock files (like `package-lock.json`, `Gemfile.lock`, `yarn.lock`) can impact how Qlty installs and manages linter extensions:

* When using `package_file`, Qlty respects the locked versions for reliability
* When using `package_file` with `package_filters`, the lock files are ignored
* For `extra_packages`, lock files are not used and specific versions are installed directly

### Limitations

Qlty currently does not support:

* **Private linter extensions** - Extensions from private Git repositories or private package registries that require authentication
* **Git-based dependencies** - Extensions referenced directly as Git repositories
* **Local file dependencies outside the repository** - Extensions referenced from paths outside the repository

### Troubleshooting

1. **Version conflicts**

   If you see errors like "Dependency conflict" or "Incompatible versions", try:

   * Aligning versions between your package file and extra\_packages
   * Using `package_filters` to selectively include compatible packages

2. **Missing extensions**

   If a linter reports missing plugins or rules:

   * Verify the extension is correctly specified in `extra_packages` or `package_file`.
   * Check for typos in package names.
   * Ensure compatible versions are specified.

3. **Slow performance**

   If linter installation becomes slow with extensions:

   * Use either `package_filters` to filter installations, or create a separate package file for linter-related packages.

4. **Configuration issues**

   If the linter can't find the extension configuration:

   * Ensure your configuration file correctly references the extensions.
   * Check that the extension is properly installed.
