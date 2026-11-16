//! Operating-system advisory file locks (#5193): a lock taken on an open file that the kernel releases when the file
//! is closed or its holder dies, so no process ever has to judge another's lock stale. `flock` on Unix and
//! `LockFileEx` on Windows, through the standard library's `File::try_lock`.
use std::{
	fs::{File, OpenOptions, TryLockError},
	io,
	path::Path,
	thread,
	time::{Duration, Instant},
};

use napi_derive::napi;

/// How long a waiting taker sleeps between tries of a lock another process holds.
const RETRY_INTERVAL: Duration = Duration::from_millis(5);

/// Takes the exclusive advisory lock of the file at `path`, created when missing and never truncated: tried at once,
/// then again until `wait` has passed. `None` while another open file holds it. The lock lasts as long as the returned
/// file is open, and the kernel releases it when its holder dies.
pub fn try_lock_file(path: &Path, wait: Duration) -> io::Result<Option<File>> {
	let file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path)?;
	let deadline = Instant::now() + wait;
	loop {
		match file.try_lock() {
			Ok(()) => return Ok(Some(file)),
			Err(TryLockError::WouldBlock) => {},
			Err(TryLockError::Error(error)) => return Err(error),
		}
		let now = Instant::now();
		if now >= deadline {
			return Ok(None);
		}
		thread::sleep(RETRY_INTERVAL.min(deadline - now));
	}
}

/// Renames `from` to `to` only while nothing is at `to`: false, with nothing moved, when something is.
pub fn rename_no_replace(from: &Path, to: &Path) -> io::Result<bool> {
	match platform_rename_no_replace(from, to) {
		Ok(()) => Ok(true),
		Err(error) if is_exists_error(&error) => Ok(false),
		Err(error) => Err(error),
	}
}

fn is_exists_error(error: &io::Error) -> bool {
	if error.kind() == io::ErrorKind::AlreadyExists {
		return true;
	}
	#[cfg(unix)]
	{
		error.raw_os_error() == Some(libc::ENOTEMPTY)
	}
	#[cfg(not(unix))]
	{
		false
	}
}

#[cfg(unix)]
fn c_path(path: &Path) -> io::Result<std::ffi::CString> {
	use std::os::unix::ffi::OsStrExt;
	std::ffi::CString::new(path.as_os_str().as_bytes())
		.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains a NUL byte"))
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn platform_rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
	/// `RENAME_NOREPLACE` of `renameat2(2)`, called through `syscall` so glibc and musl builds alike reach it.
	const RENAME_NOREPLACE: libc::c_uint = 1;
	let (from, to) = (c_path(from)?, c_path(to)?);
	let result = unsafe {
		libc::syscall(
			libc::SYS_renameat2,
			libc::AT_FDCWD,
			from.as_ptr(),
			libc::AT_FDCWD,
			to.as_ptr(),
			RENAME_NOREPLACE,
		)
	};
	if result == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

#[cfg(target_vendor = "apple")]
fn platform_rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
	let (from, to) = (c_path(from)?, c_path(to)?);
	let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
	if result == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

#[cfg(windows)]
fn platform_rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
	use std::os::windows::ffi::OsStrExt;

	use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
	let wide = |path: &Path| path.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<u16>>();
	let (from, to) = (wide(from), wide(to));
	// Without MOVEFILE_REPLACE_EXISTING, the move fails when anything is at `to`.
	if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } != 0 {
		Ok(())
	} else {
		Err(io::Error::last_os_error())
	}
}

#[cfg(not(any(target_os = "linux", target_os = "android", target_vendor = "apple", windows)))]
fn platform_rename_no_replace(_from: &Path, _to: &Path) -> io::Result<()> {
	Err(io::Error::new(
		io::ErrorKind::Unsupported,
		"no rename that refuses to replace on this platform",
	))
}

fn napi_error(error: io::Error) -> napi::Error {
	let code =
		error.raw_os_error().map_or_else(|| format!("{:?}", error.kind()), |code| code.to_string());
	napi::Error::new(napi::Status::GenericFailure, format!("{error} (os error {code})"))
}

/// An exclusive advisory lock this process holds on an open file (#5193), released by {@link AdvisoryLock.release},
/// when the object is collected, or by the kernel when this process dies.
#[napi(js_name = "AdvisoryLock")]
pub struct AdvisoryLock {
	file: Option<File>,
}

#[napi]
impl AdvisoryLock {
	/// Releases the lock and closes its file; releasing it again does nothing.
	#[napi]
	pub fn release(&mut self) {
		if let Some(file) = self.file.take() {
			// Closing the file releases the lock in any case.
			let _ = file.unlock();
		}
	}
}

/// Takes the exclusive advisory lock of the file at `path` (#5193): `flock` on Unix, `LockFileEx` on Windows. The
/// file is created when missing and never truncated or removed. Tried at once, then again until `waitMs` has passed;
/// `null` while another holder keeps it. Throws when the file cannot be opened or locked.
#[napi(js_name = "tryAdvisoryLock")]
pub fn try_advisory_lock(path: String, wait_ms: u32) -> napi::Result<Option<AdvisoryLock>> {
	let file = try_lock_file(Path::new(&path), Duration::from_millis(u64::from(wait_ms)))
		.map_err(napi_error)?;
	Ok(file.map(|file| AdvisoryLock { file: Some(file) }))
}

/// Renames `from` to `to` only while nothing is at `to` (#5193): `false`, with nothing moved, when something is there,
/// so a moved item is put back without ever replacing another. Throws on any other failure.
#[napi(js_name = "renameNoReplace")]
pub fn rename_no_replace_napi(from: String, to: String) -> napi::Result<bool> {
	rename_no_replace(Path::new(&from), Path::new(&to)).map_err(napi_error)
}
