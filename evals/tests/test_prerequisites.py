from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from prerequisites import (
    _node_setup_command,
    agent_install_command,
    atomic_runtime_environment_command,
)


def _write_executable(path: Path, contents: str) -> None:
    path.write_text(contents, encoding="utf-8")
    path.chmod(0o755)


def _run_node_setup(tmp_path: Path, nvm_sh: str | None) -> subprocess.CompletedProcess[str]:
    home = tmp_path / "home"
    nvm_dir = home / ".nvm"
    fake_bin = tmp_path / "bin"
    nvm_dir.mkdir(parents=True)
    fake_bin.mkdir()
    if nvm_sh is not None:
        (nvm_dir / "nvm.sh").write_text(nvm_sh, encoding="utf-8")
    _write_executable(
        fake_bin / "curl",
        "#!/bin/bash\nprintf 'curl unexpectedly invoked\\n' >&2\nexit 97\n",
    )
    env = {
        "HOME": str(home),
        "NVM_LOG": str(tmp_path / "nvm.log"),
        "PATH": f"{fake_bin}:/usr/bin:/bin",
    }
    return subprocess.run(
        ["/bin/bash", "-c", f"set -euo pipefail; {_node_setup_command()}"],
        capture_output=True,
        check=False,
        env=env,
        text=True,
    )


@pytest.mark.parametrize("source_status", [0, 3])
def test_existing_nvm_source_can_succeed_or_return_nonzero(
    tmp_path: Path, source_status: int
) -> None:
    result = _run_node_setup(
        tmp_path,
        "nvm() { printf '%s\\n' \"$*\" >> \"$NVM_LOG\"; }\n"
        f"return {source_status}\n",
    )

    assert result.returncode == 0, result.stderr
    assert (tmp_path / "nvm.log").read_text(encoding="utf-8") == (
        "install 22\nalias default 22\n"
    )
    assert "curl unexpectedly invoked" not in result.stderr


def test_nonzero_nvm_source_without_nvm_fails_clearly(tmp_path: Path) -> None:
    result = _run_node_setup(tmp_path, "return 3\n")

    assert result.returncode == 1
    assert result.stderr == "Error: NVM failed to load\n"


def test_failed_nvm_download_is_not_swallowed(tmp_path: Path) -> None:
    home = tmp_path / "home"
    fake_bin = tmp_path / "bin"
    home.mkdir()
    fake_bin.mkdir()
    _write_executable(fake_bin / "curl", "#!/bin/bash\nexit 23\n")

    result = subprocess.run(
        ["/bin/bash", "-c", f"set -euo pipefail; {_node_setup_command()}"],
        capture_output=True,
        check=False,
        env={"HOME": str(home), "PATH": f"{fake_bin}:/usr/bin:/bin"},
        text=True,
    )

    assert result.returncode == 23
    assert "Error: NVM failed to load" not in result.stderr


def test_generated_install_command_keeps_non_alpine_and_alpine_guards() -> None:
    command = agent_install_command("@latest")

    assert 'if [ ! -s "$NVM_DIR/nvm.sh" ]; then' in command
    assert '. "$NVM_DIR/nvm.sh" || true' in command
    assert "nvm install 22; nvm alias default 22" in command
    assert "Alpine nodejs must be Node.js 18 or newer" in command
    assert 'npm config set prefix "$HOME/.local"' in command


@pytest.mark.parametrize(
    "unsafe_spec",
    ["latest", "@", "@latest; touch /tmp/pwned", "@latest $(false)", "@two words"],
)
def test_unsafe_version_spec_is_rejected(unsafe_spec: str) -> None:
    with pytest.raises(ValueError, match="Unsafe Atomic npm version specifier"):
        agent_install_command(unsafe_spec)


def test_runtime_source_nonzero_still_launches_atomic(tmp_path: Path) -> None:
    home = tmp_path / "home"
    nvm_dir = home / ".nvm"
    nvm_dir.mkdir(parents=True)
    (nvm_dir / "nvm.sh").write_text(
        "nvm() { :; }\natomic() { printf 'atomic launched\\n'; }\nreturn 3\n",
        encoding="utf-8",
    )

    result = subprocess.run(
        [
            "/bin/bash",
            "-c",
            f"set -euo pipefail; {atomic_runtime_environment_command()}; atomic --version",
        ],
        capture_output=True,
        check=False,
        env={"HOME": str(home), "PATH": "/usr/bin:/bin"},
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout == "atomic launched\n"


def test_runtime_fails_when_neither_nvm_nor_atomic_is_available(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()

    result = subprocess.run(
        ["/bin/bash", "-c", atomic_runtime_environment_command()],
        capture_output=True,
        check=False,
        env={"HOME": str(home), "PATH": "/usr/bin:/bin"},
        text=True,
    )

    assert result.returncode == 1
    assert result.stderr == "Error: neither NVM nor Atomic is available\n"


def test_pier_and_harbor_use_shared_bootstrap_and_runtime_guard() -> None:
    evals_dir = Path(__file__).parents[1]
    for adapter_name in ("atomic_pier.py", "atomic_harbor.py"):
        source = (evals_dir / adapter_name).read_text(encoding="utf-8")
        assert "agent_install_command(version_spec)" in source
        assert source.count("atomic_runtime_environment_command()") == 2
        assert ". ~/.nvm/nvm.sh" not in source
