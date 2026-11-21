#!/usr/bin/env python3
"""
Skill Packager - Creates a distributable .skill file of a skill folder

Usage:
    python utils/package_skill.py <path/to/skill-folder> [output-directory]

Example:
    python utils/package_skill.py skills/public/my-skill
    python utils/package_skill.py skills/public/my-skill ./dist
"""

import errno
import fnmatch
import os
import secrets
import shutil
import stat
import sys
import time
import zipfile
from pathlib import Path
from scripts.atomic_cli import remove_file
from scripts.quick_validate import validate_skill
from scripts.utils import write_output_in_utf8

# Patterns to exclude when packaging skills.
EXCLUDE_DIRS = {"__pycache__", "node_modules"}
EXCLUDE_GLOBS = {"*.pyc"}
EXCLUDE_FILES = {".DS_Store"}
# Directories excluded only at the skill root (not when nested deeper).
ROOT_EXCLUDE_DIRS = {"evals"}


def should_exclude(rel_path: Path) -> bool:
    """Check if a path should be excluded from packaging."""
    parts = rel_path.parts
    if any(part in EXCLUDE_DIRS for part in parts):
        return True
    # rel_path is relative to skill_path.parent, so parts[0] is the skill
    # folder name and parts[1] (if present) is the first subdir.
    if len(parts) > 1 and parts[1] in ROOT_EXCLUDE_DIRS:
        return True
    name = rel_path.name
    if name in EXCLUDE_FILES:
        return True
    return any(fnmatch.fnmatch(name, pat) for pat in EXCLUDE_GLOBS)


def creation_mode(target: Path) -> int:
    """The permissions to create a file standing in for target with: target's own when it exists (the umask can
    only narrow them), so its contents are never readable by more than target's were; a new file's otherwise."""
    try:
        return stat.S_IMODE(os.stat(target).st_mode)
    except OSError:
        return 0o666


def create_temporary(target: Path) -> tuple[Path, int]:
    """A new, empty file next to target, open for writing, with the permissions creation_mode gives."""
    for _ in range(100):
        path = target.with_name(f".{target.name}.{secrets.token_hex(4)}.tmp")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
        try:
            return path, os.open(path, flags, creation_mode(target))
        except FileExistsError:
            continue
    raise FileExistsError(f"no free temporary name next to {target}")


def replace(temporary: Path, target: Path) -> None:
    """Give the complete archive the .skill file's name.

    On Windows a program that has the .skill file open, as Python and Node open files there, lets it be
    written but not replaced: it is then written in place, as before. Something holding it for a moment,
    such as a scanner, is waited for a bounded time.
    """
    for attempt in range(20):
        try:
            os.replace(temporary, target)
            return
        except PermissionError:
            if os.name != "nt":
                raise
            if target.is_file():
                try:
                    with open(temporary, "rb") as source, open(target, "wb") as destination:
                        shutil.copyfileobj(source, destination)
                    return
                except PermissionError:
                    pass
            if attempt == 19:
                raise
            time.sleep(0.05)


def package_skill(skill_path, output_dir=None):
    """
    Package a skill folder into a .skill file.

    Args:
        skill_path: Path to the skill folder
        output_dir: Optional output directory for the .skill file (defaults to current directory)

    Returns:
        Path to the created .skill file, or None if error
    """
    skill_path = Path(skill_path).resolve()

    # Validate skill folder exists
    if not skill_path.exists():
        print(f"❌ Error: Skill folder not found: {skill_path}")
        return None

    if not skill_path.is_dir():
        print(f"❌ Error: Path is not a directory: {skill_path}")
        return None

    # Validate SKILL.md exists
    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        print(f"❌ Error: SKILL.md not found in {skill_path}")
        return None

    # Run validation before packaging
    print("🔍 Validating skill...")
    valid, message = validate_skill(skill_path)
    if not valid:
        print(f"❌ Validation failed: {message}")
        print("   Please fix the validation errors before packaging.")
        return None
    print(f"✅ {message}\n")

    # Determine output location
    skill_name = skill_path.name
    if output_dir:
        output_path = Path(output_dir).resolve()
        output_path.mkdir(parents=True, exist_ok=True)
    else:
        output_path = Path.cwd()

    skill_filename = output_path / f"{skill_name}.skill"
    # A link is written through to the file it links to, as writing it in place did before.
    target = Path(os.path.realpath(skill_filename)) if skill_filename.is_symlink() else skill_filename

    # Create the .skill file (zip format) under a temporary name next to it, and give it its name only once it is
    # complete: a failure or an interruption leaves no partial file, and an earlier .skill file as it was.
    temporary = None
    try:
        if target.exists() and not os.access(target, os.W_OK):
            # A file that cannot be written is refused, as before.
            raise PermissionError(errno.EACCES, os.strerror(errno.EACCES), str(skill_filename))
        try:
            temporary, handle = create_temporary(target)
            archive = os.fdopen(handle, "wb")
        except PermissionError:
            if not target.is_file():
                raise PermissionError(errno.EACCES, os.strerror(errno.EACCES), str(skill_filename)) from None
            # A folder that cannot take new files: the file is written in place, as before.
            temporary = None
            archive = open(target, "wb")
        with archive, zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as zipf:
            # Walk through the skill directory, excluding build artifacts
            for file_path in skill_path.rglob('*'):
                if not file_path.is_file():
                    continue
                # Never the archive itself, when it is written inside the skill folder.
                if file_path in (temporary, skill_filename, target):
                    continue
                arcname = file_path.relative_to(skill_path.parent)
                if should_exclude(arcname):
                    print(f"  Skipped: {arcname}")
                    continue
                zipf.write(file_path, arcname)
                print(f"  Added: {arcname}")

        if temporary is not None:
            if target.exists():
                # A .skill file it replaces keeps exactly its permissions, as when it was written over before.
                os.chmod(temporary, creation_mode(target))
            replace(temporary, target)
            temporary = None
        print(f"\n✅ Successfully packaged skill to: {skill_filename}")
        return skill_filename

    except Exception as e:
        if isinstance(e, OSError) and temporary is not None and str(temporary) in (e.filename, e.filename2):
            # Named by the .skill file, never by the file written next to it.
            e = OSError(e.errno, e.strerror, str(skill_filename))
        print(f"❌ Error creating .skill file: {e}")
        return None
    finally:
        if temporary is not None:
            remove_file(temporary)


def main():
    if len(sys.argv) < 2:
        print("Usage: python utils/package_skill.py <path/to/skill-folder> [output-directory]")
        print("\nExample:")
        print("  python utils/package_skill.py skills/public/my-skill")
        print("  python utils/package_skill.py skills/public/my-skill ./dist")
        sys.exit(1)

    skill_path = sys.argv[1]
    output_dir = sys.argv[2] if len(sys.argv) > 2 else None

    print(f"📦 Packaging skill: {skill_path}")
    if output_dir:
        print(f"   Output directory: {output_dir}")
    print()

    result = package_skill(skill_path, output_dir)

    if result:
        sys.exit(0)
    else:
        sys.exit(1)


if __name__ == "__main__":
    write_output_in_utf8()
    main()
