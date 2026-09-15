"""Extract a verified EDB CookFS data file; never execute the vendor installer.

bitrock-unpacker 0.1.2 is a pinned, dependency-free build tool (MIT). Its CLI
assumes a PE overlay; EDB's macOS Resources/installbuilder is the raw overlay.
The parser/extractor is unmodified upstream code. Restore executable modes and
relative aliases from the vendor manifest (the generic extractor omits them).
"""
import sys
import os
from pathlib import Path
from types import SimpleNamespace
from bitrock_unpacker import cli
from bitrock_unpacker.tcllist import tokenize_tcl_list

cli.parse_pe_overlay = lambda data: SimpleNamespace(overlay_start=0, overlay_length=len(data))
result = cli.main(sys.argv[1:])
if result:
    raise SystemExit(result)
root = Path(sys.argv[sys.argv.index("--extract") + 1]).resolve()
manifest = list(tokenize_tcl_list(cli.recover_manifest(Path(sys.argv[1]).read_bytes(), 0)))
for name, details in zip(manifest[::2], manifest[1::2]):
    fields = list(tokenize_tcl_list(details))
    path = root / name
    if not path.resolve().is_relative_to(root):
        raise ValueError(f"languagepack path escapes extraction: {name}")
    if fields[0] == "file":
        path.chmod(0o644 | (int(fields[1], 8) & 0o111))
    elif fields[0] == "link":
        target = fields[1]
        if os.path.isabs(target) or not (path.parent / target).resolve().is_relative_to(root):
            raise ValueError(f"languagepack alias escapes extraction: {name}")
        path.symlink_to(target)
