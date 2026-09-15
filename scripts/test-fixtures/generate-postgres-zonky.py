"""Regenerate postgres-zonky.json with Python 3's standard library.

Run: python scripts/test-fixtures/generate-postgres-zonky.py
The output is a deterministic ZIP/JAR containing a genuine xz-compressed USTAR
archive. No Windows tar compression support or zip executable is needed by tests.
The tiny ELF64 headers model linux-x64-musl; they are not runnable PostgreSQL.
"""

import base64
import hashlib
import io
import json
import lzma
import tarfile
import zipfile

binary = bytearray(128)
binary[:6] = b"\x7fELF\x02\x01"
binary[18:20] = (62).to_bytes(2, "little")
loader = b"/lib/ld-musl-x86_64.so.1"
binary[64:64 + len(loader)] = loader
archive = io.BytesIO()
with tarfile.open(fileobj=archive, mode="w", format=tarfile.USTAR_FORMAT) as tar:
    for name, data, mode, link in [
        ("bin", None, 0o755, None),
        ("lib", None, 0o755, None),
        ("share", None, 0o755, None),
        ("bin/postgres", binary, 0o755, None),
        ("bin/initdb", binary, 0o755, None),
        ("bin/pg_ctl", binary, 0o755, None),
        ("lib/libpq.so.5.18", b"library", 0o644, None),
        ("lib/libpq.so", None, 0o777, "libpq.so.5.18"),
        ("share/postgres.bki", b"catalog", 0o644, None),
    ]:
        entry = tarfile.TarInfo(name)
        entry.mode = mode
        if link:
            entry.type = tarfile.SYMTYPE
            entry.linkname = link
        elif data is None:
            entry.type = tarfile.DIRTYPE
        else:
            entry.size = len(data)
        tar.addfile(entry, io.BytesIO(data) if data is not None else None)
inner = lzma.compress(archive.getvalue(), format=lzma.FORMAT_XZ, check=lzma.CHECK_CRC64, preset=6)
jar = io.BytesIO()
inner_entry = "postgres-test.txz"
with zipfile.ZipFile(jar, "w", compression=zipfile.ZIP_STORED) as zipped:
    zipped.writestr(zipfile.ZipInfo(inner_entry, (1980, 1, 1, 0, 0, 0)), inner)
print(json.dumps({
    "innerEntry": inner_entry,
    "innerSha256": hashlib.sha256(inner).hexdigest(),
    "jarBase64": base64.b64encode(jar.getvalue()).decode("ascii"),
}, indent=2))
