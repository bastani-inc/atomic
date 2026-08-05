// Shared test helpers for fs_cache submodule test suites.

#[cfg(unix)]
use std::{ffi::CString, os::unix::ffi::OsStrExt};
use std::{
	fs,
	path::{Path, PathBuf},
	sync::atomic::{AtomicU64, Ordering},
	time::{SystemTime, UNIX_EPOCH},
};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(super) struct TempDirGuard(PathBuf);

impl TempDirGuard {
	pub(super) fn new() -> Self {
		let timestamp = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("system time is after UNIX_EPOCH")
			.as_nanos();
		let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
		let path = std::env::temp_dir().join(format!("pi-fs-cache-test-{timestamp}-{counter}"));
		fs::create_dir_all(&path).expect("create temp test directory");
		Self(path)
	}

	pub(super) fn path(&self) -> &Path {
		&self.0
	}
}

impl Drop for TempDirGuard {
	fn drop(&mut self) {
		let _ = fs::remove_dir_all(&self.0);
	}
}

#[cfg(unix)]
pub(super) fn make_fifo(path: &Path) {
	let fifo_path = CString::new(path.as_os_str().as_bytes()).expect("fifo path has no NUL bytes");
	// SAFETY: `fifo_path` is a valid CString (NUL-terminated, no interior NULs),
	// so `as_ptr()` yields a valid C string pointer. `0o600` is a valid mode.
	// The CString is alive for the duration of the call.
	let rc = unsafe { libc::mkfifo(fifo_path.as_ptr(), 0o600) };
	assert_eq!(rc, 0, "create fifo: {}", std::io::Error::last_os_error());
}
