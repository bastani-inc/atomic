from __future__ import annotations

import ast
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

from skill_prerequisites import (
    LITEPARSE_VERSION,
    NO_EXTERNAL_PREREQUISITES,
    PLAYWRIGHT_CLI_VERSION,
    PREREQUISITES,
    SHIPPED_SKILLS,
    UV_VERSION,
    agent_install_command,
    root_install_command,
    runtime_environment_command,
    verification_command,
)

ROOT = Path(__file__).resolve().parents[1]


class InventoryTests(unittest.TestCase):
    def test_inventory_exactly_covers_shipped_package_skills(self) -> None:
        actual = {
            path.parent.name
            for path in ROOT.glob("packages/*/skills/**/SKILL.md")
            if "/test/fixtures/" not in path.as_posix()
        }
        documented = {item.skill for item in PREREQUISITES} | set(
            NO_EXTERNAL_PREREQUISITES
        )
        self.assertEqual(actual, set(SHIPPED_SKILLS))
        self.assertEqual(actual, documented)

    def test_project_local_agent_skills_are_excluded(self) -> None:
        names = {item.skill for item in PREREQUISITES} | set(SHIPPED_SKILLS)
        self.assertTrue({"crabbox", "prek", "gh-commit"}.isdisjoint(names))

    def test_required_prerequisites_are_mapped_to_install_and_verify(self) -> None:
        required = {
            ("tmux", "tmux-compatible CLI"),
            ("playwright-cli", f"@playwright/cli@{PLAYWRIGHT_CLI_VERSION}"),
            ("effective-liteparse", f"@llamaindex/liteparse@{LITEPARSE_VERSION}"),
            ("effective-liteparse", "LibreOffice"),
            ("effective-liteparse", "ImageMagick"),
            ("effective-liteparse", f"uv {UV_VERSION} and Python 3.13"),
            ("skill-creator", "Python 3 and PyYAML"),
            ("impeccable", "Node.js"),
        }
        actual = {(item.skill, item.prerequisite) for item in PREREQUISITES}
        self.assertLessEqual(required, actual)
        self.assertTrue(all(item.install and item.verify for item in PREREQUISITES))


class CommandTests(unittest.TestCase):
    def test_pier_root_plan_has_all_package_manager_branches(self) -> None:
        command = root_install_command()
        for fragment in (
            "apk add --no-cache",
            "apt-get install -y --no-install-recommends",
            "yum install -y",
        ):
            self.assertIn(fragment, command)
        for package in (
            "ca-certificates",
            "tmux",
            "libreoffice",
            "imagemagick",
            "python3",
        ):
            self.assertIn(package.lower(), command.lower())
        self.assertIn("Error: no supported package manager", command)

    def test_yum_plan_enables_required_repositories_before_packages(self) -> None:
        command = root_install_command()
        self.assertIn("dnf-plugins-core epel-release", command)
        self.assertIn("config-manager --set-enabled crb", command)
        self.assertIn("--allowerasing", command)
        for package in (
            "ImageMagick",
            "chromium",
            "libreoffice-core",
            "libreoffice-writer",
            "ripgrep",
            "tmux",
        ):
            self.assertIn(package, command)

    def test_harbor_root_plan_is_debian_only_and_noninteractive_friendly(self) -> None:
        command = root_install_command(harbor=True)
        for package in (
            "ca-certificates",
            "tmux",
            "libreoffice",
            "imagemagick",
            "python3",
        ):
            self.assertIn(package.lower(), command.lower())
        self.assertIn("apt-get", command)
        self.assertNotIn("apk add", command)
        self.assertNotIn("yum install", command)
        self.assertIn("--no-install-recommends", command)
        self.assertIn("rm -rf /var/lib/apt/lists/*", command)

    def test_agent_plan_is_pinned_idempotent_and_preloads_browser(self) -> None:
        command = agent_install_command("@next")
        self.assertIn("@bastani/atomic@next", command)
        self.assertIn(f"@playwright/cli@{PLAYWRIGHT_CLI_VERSION}", command)
        self.assertIn(f"@llamaindex/liteparse@{LITEPARSE_VERSION}", command)
        self.assertIn(f"astral.sh/uv/{UV_VERSION}/install.sh", command)
        self.assertIn("uv python install 3.13", command)
        self.assertIn("alpine/edge/main", root_install_command())
        self.assertIn("libc++", root_install_command())
        self.assertIn('npm config set prefix "$HOME/.local"', command)
        self.assertIn("PLAYWRIGHT_MCP_EXECUTABLE_PATH", command)
        self.assertIn("PLAYWRIGHT_MCP_SANDBOX=false", command)
        self.assertNotIn("PLAYWRIGHT_MCP_NO_SANDBOX", command)
        self.assertIn(".atomic-eval-env.tmp", command)
        self.assertIn('mv -f "$env_tmp" "$HOME/.atomic-eval-env"', command)
        self.assertIn("@playwright/cli/node_modules/playwright/cli.js", command)
        self.assertIn("install chromium", command)
        self.assertNotIn("@latest", command)

    def test_verification_exercises_cli_and_offline_browser(self) -> None:
        command = verification_command()
        for fragment in (
            "tmux -V",
            "lit --version",
            "python3 -c 'import yaml'",
            "libreoffice --version",
            "UV_OFFLINE=1",
            "uv python find 3.13",
            "playwright-cli open about:blank",
            "playwright-cli snapshot",
            "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
            "npm_config_offline=true",
            "playwright-cli close",
        ):
            self.assertIn(fragment, command)

    def test_generated_shell_is_bash_syntax_safe(self) -> None:
        for command in (
            root_install_command(),
            root_install_command(harbor=True),
            agent_install_command("@0.9.7-alpha.1"),
        ):
            result = subprocess.run(
                ["bash", "-n", "-c", command], capture_output=True, text=True
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_runtime_environment_loads_browser_config_in_non_login_shell(self) -> None:
        with tempfile.TemporaryDirectory() as home:
            Path(home, ".atomic-eval-env").write_text(
                "export PLAYWRIGHT_MCP_EXECUTABLE_PATH=/usr/bin/chromium\n"
                "export PLAYWRIGHT_MCP_HEADLESS=true\n"
            )
            result = subprocess.run(
                [
                    "bash",
                    "-c",
                    runtime_environment_command()
                    + '; printf "%s|%s" "$PLAYWRIGHT_MCP_EXECUTABLE_PATH" '
                    '"$PLAYWRIGHT_MCP_HEADLESS"',
                ],
                capture_output=True,
                text=True,
                env={"HOME": home, "PATH": os.environ["PATH"]},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "/usr/bin/chromium|true")

    def test_version_input_rejects_shell_metacharacters(self) -> None:
        with self.assertRaises(ValueError):
            agent_install_command("@next; touch /tmp/injected")

    def test_both_adapters_explicitly_consume_shared_plan(self) -> None:
        for name in ("atomic_pier.py", "atomic_harbor.py"):
            tree = ast.parse((ROOT / "evals" / name).read_text())
            imports = [
                node for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)
            ]
            self.assertTrue(
                any(node.module == "skill_prerequisites" for node in imports), name
            )
            source = (ROOT / "evals" / name).read_text()
            self.assertRegex(source, re.compile(r"root_install_command\("))
            self.assertRegex(source, re.compile(r"agent_install_command\("))
            self.assertRegex(source, re.compile(r"runtime_environment_command\(\)"))


if __name__ == "__main__":
    unittest.main()
