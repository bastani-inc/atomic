"""Windows: run a command in a console of its own, then press Ctrl+C in it or close it.

usage: python console-event.py <ctrl-c|close> <records folder> <count> <key> <start seconds> <exit seconds> <command...>

The command starts on a pseudoconsole. Once the folder holds <count> .json records that each have
<key> (any record when <key> is "-"), or <start seconds> have passed, Ctrl+C is typed into the
console, which sends CTRL_C_EVENT to the processes attached to it, or the console is closed, as
closing its window does, which sends them CTRL_CLOSE_EVENT. Prints one JSON object: how many such
records there were then, the command's exit status (null if it still ran <exit seconds> later, when
it is ended), the seconds it took to exit, and what it wrote to the console.
"""

import ctypes
import json
import subprocess
import sys
import threading
import time
from ctypes import wintypes
from pathlib import Path

action, records, count, key = sys.argv[1], Path(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
start_seconds, exit_seconds = float(sys.argv[5]), float(sys.argv[6])
command = subprocess.list2cmdline(sys.argv[7:])
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)


class Coord(ctypes.Structure):
    _fields_ = [("X", ctypes.c_short), ("Y", ctypes.c_short)]


class StartupInfo(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("lpReserved", wintypes.LPWSTR),
        ("lpDesktop", wintypes.LPWSTR),
        ("lpTitle", wintypes.LPWSTR),
        *((name, wintypes.DWORD) for name in ("dwX", "dwY", "dwXSize", "dwYSize", "dwXCountChars", "dwYCountChars")),
        ("dwFillAttribute", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("wShowWindow", wintypes.WORD),
        ("cbReserved2", wintypes.WORD),
        ("lpReserved2", ctypes.c_void_p),
        ("hStdInput", wintypes.HANDLE),
        ("hStdOutput", wintypes.HANDLE),
        ("hStdError", wintypes.HANDLE),
    ]


class StartupInfoEx(ctypes.Structure):
    _fields_ = [("StartupInfo", StartupInfo), ("lpAttributeList", ctypes.c_void_p)]


class ProcessInformation(ctypes.Structure):
    _fields_ = [
        ("hProcess", wintypes.HANDLE),
        ("hThread", wintypes.HANDLE),
        ("dwProcessId", wintypes.DWORD),
        ("dwThreadId", wintypes.DWORD),
    ]


kernel32.CreatePseudoConsole.restype = ctypes.c_long
kernel32.CreatePseudoConsole.argtypes = (
    Coord,
    wintypes.HANDLE,
    wintypes.HANDLE,
    wintypes.DWORD,
    ctypes.POINTER(ctypes.c_void_p),
)
kernel32.ClosePseudoConsole.argtypes = (ctypes.c_void_p,)
kernel32.CreatePipe.argtypes = (
    ctypes.POINTER(wintypes.HANDLE),
    ctypes.POINTER(wintypes.HANDLE),
    ctypes.c_void_p,
    wintypes.DWORD,
)
kernel32.InitializeProcThreadAttributeList.argtypes = (
    ctypes.c_void_p,
    wintypes.DWORD,
    wintypes.DWORD,
    ctypes.POINTER(ctypes.c_size_t),
)
kernel32.UpdateProcThreadAttribute.argtypes = (
    ctypes.c_void_p,
    wintypes.DWORD,
    ctypes.c_size_t,
    ctypes.c_void_p,
    ctypes.c_size_t,
    ctypes.c_void_p,
    ctypes.c_void_p,
)
kernel32.CreateProcessW.argtypes = (
    wintypes.LPCWSTR,
    wintypes.LPWSTR,
    ctypes.c_void_p,
    ctypes.c_void_p,
    wintypes.BOOL,
    wintypes.DWORD,
    ctypes.c_void_p,
    wintypes.LPCWSTR,
    ctypes.POINTER(StartupInfoEx),
    ctypes.POINTER(ProcessInformation),
)
kernel32.ReadFile.argtypes = (wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p)
kernel32.WriteFile.argtypes = (wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p)
kernel32.SetConsoleCtrlHandler.argtypes = (ctypes.c_void_p, wintypes.BOOL)
kernel32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
kernel32.WaitForSingleObject.restype = wintypes.DWORD
kernel32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
kernel32.TerminateProcess.argtypes = (wintypes.HANDLE, wintypes.UINT)
kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)

input_read, input_write, output_read, output_write = (wintypes.HANDLE() for _ in range(4))
assert kernel32.CreatePipe(ctypes.byref(input_read), ctypes.byref(input_write), None, 0)
assert kernel32.CreatePipe(ctypes.byref(output_read), ctypes.byref(output_write), None, 0)
console = ctypes.c_void_p()
result = kernel32.CreatePseudoConsole(Coord(200, 50), input_read, output_write, 0, ctypes.byref(console))
assert result == 0, f"CreatePseudoConsole: {result:#x}"
kernel32.CloseHandle(input_read)
kernel32.CloseHandle(output_write)

screen = bytearray()


def drain() -> None:
    # The console's output must be read, or the command blocks on writing it.
    chunk = ctypes.create_string_buffer(65536)
    read = wintypes.DWORD()
    while kernel32.ReadFile(output_read, chunk, 65536, ctypes.byref(read), None) and read.value:
        screen.extend(chunk.raw[: read.value])


threading.Thread(target=drain, daemon=True).start()
size = ctypes.c_size_t()
kernel32.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
attributes = ctypes.create_string_buffer(size.value)
assert kernel32.InitializeProcThreadAttributeList(attributes, 1, 0, ctypes.byref(size))
pseudoconsole_attribute = 0x20016
assert kernel32.UpdateProcThreadAttribute(
    attributes, 0, pseudoconsole_attribute, console, ctypes.sizeof(ctypes.c_void_p), None, None
)
startup = StartupInfoEx()
startup.StartupInfo.cb = ctypes.sizeof(StartupInfoEx)
# None of this process's standard handles: the pseudoconsole provides the command's.
startup.StartupInfo.dwFlags = 0x100
startup.StartupInfo.hStdInput = startup.StartupInfo.hStdOutput = startup.StartupInfo.hStdError = wintypes.HANDLE(-1)
startup.lpAttributeList = ctypes.cast(attributes, ctypes.c_void_p)
process = ProcessInformation()
# The command inherits whether Ctrl+C is ignored; this process may have been started with it ignored.
kernel32.SetConsoleCtrlHandler(None, False)
extended_startup_info, unicode_environment = 0x80000, 0x400
assert kernel32.CreateProcessW(
    None,
    ctypes.create_unicode_buffer(command),
    None,
    None,
    False,
    extended_startup_info | unicode_environment,
    None,
    None,
    ctypes.byref(startup),
    ctypes.byref(process),
), ctypes.get_last_error()


def ready() -> int:
    found = 0
    for path in records.glob("*.json"):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue  # Being written.
        found += key == "-" or key in record
    return found


deadline = time.monotonic() + start_seconds
while ready() < count and time.monotonic() < deadline:
    time.sleep(0.05)
started = ready()
sent = time.monotonic()
if action == "ctrl-c":
    written = wintypes.DWORD()
    assert kernel32.WriteFile(input_write, b"\x03", 1, ctypes.byref(written), None)
else:
    # ClosePseudoConsole can wait for the console's processes; the command's exit is what is measured.
    threading.Thread(target=kernel32.ClosePseudoConsole, args=(console,), daemon=True).start()
status = None
if kernel32.WaitForSingleObject(process.hProcess, int(exit_seconds * 1000)) == 0:
    code = wintypes.DWORD()
    kernel32.GetExitCodeProcess(process.hProcess, ctypes.byref(code))
    status = code.value
else:
    kernel32.TerminateProcess(process.hProcess, 1)
seconds = time.monotonic() - sent
print(json.dumps({"ready": started, "status": status, "seconds": seconds, "screen": screen.decode("utf-8", errors="replace")}))
