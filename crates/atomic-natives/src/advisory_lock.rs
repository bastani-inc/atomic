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

/// How many refusals in a row that a concurrent removal of the path explains are retried before a refusal counts as
/// a real permission error. On Windows, opening a file while another process removes it is refused until the
/// removal finishes, and the path may hold a new file or no file by the time the refusal is examined.
#[cfg(windows)]
const MAX_DELETE_RACE_RETRIES: u32 = 16;

/// How long a taker waits before it retries a refusal that a concurrent removal explains.
#[cfg(windows)]
const DELETE_RACE_RETRY_INTERVAL: Duration = Duration::from_millis(2);

#[cfg(unix)]
fn lock_matches_path(file: &File, path: &Path) -> bool {
	use std::os::unix::fs::MetadataExt;
	let Ok(held) = file.metadata() else {
		return false;
	};
	let Ok(current) = std::fs::metadata(path) else {
		return false;
	};
	held.dev() == current.dev() && held.ino() == current.ino()
}

#[cfg(windows)]
fn file_id(file: &File) -> Option<(u32, u32, u32)> {
	use std::os::windows::io::AsRawHandle;
	use windows_sys::Win32::Storage::FileSystem::{
		BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
	};
	let mut info = BY_HANDLE_FILE_INFORMATION::default();
	let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) };
	if ok == 0 || info.nNumberOfLinks == 0 {
		return None;
	}
	Some((info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow))
}

#[cfg(windows)]
fn lock_matches_path(file: &File, path: &Path) -> bool {
	use std::os::windows::fs::OpenOptionsExt;
	let Some(held) = file_id(file) else {
		return false;
	};
	let Ok(current) = OpenOptions::new().access_mode(0).open(path) else {
		return false;
	};
	file_id(&current) == Some(held)
}

#[cfg(not(any(unix, windows)))]
fn lock_matches_path(_file: &File, path: &Path) -> bool {
	std::fs::metadata(path).is_ok()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OpenFailure {
	Permanent,
	#[cfg(windows)]
	WaitDeletePending,
	#[cfg(windows)]
	RetryChangedPath,
}

#[cfg(windows)]
fn classify_delete_race(path: &Path, error: &io::Error, delete_races: &mut u32) -> OpenFailure {
	use std::os::windows::ffi::OsStrExt;
	use windows_sys::{
		Wdk::{
			Foundation::OBJECT_ATTRIBUTES,
			Storage::FileSystem::{FILE_BASIC_INFORMATION, RtlDosPathNameToNtPathName_U_WithStatus},
		},
		Win32::{
			Foundation::{
				NTSTATUS, OBJ_CASE_INSENSITIVE, STATUS_DELETE_PENDING, STATUS_OBJECT_NAME_NOT_FOUND,
				STATUS_SUCCESS, UNICODE_STRING,
			},
			System::WindowsProgramming::RtlFreeUnicodeString,
		},
	};

	#[cfg_attr(
		target_arch = "x86",
		link(
			name = "ntdll.dll",
			kind = "raw-dylib",
			modifiers = "+verbatim",
			import_name_type = "undecorated"
		)
	)]
	#[cfg_attr(
		not(target_arch = "x86"),
		link(name = "ntdll.dll", kind = "raw-dylib", modifiers = "+verbatim")
	)]
	unsafe extern "system" {
		#[link_name = "NtQueryAttributesFile"]
		fn nt_query_attributes_file(
			attributes: *const OBJECT_ATTRIBUTES,
			information: *mut FILE_BASIC_INFORMATION,
		) -> NTSTATUS;
	}

	if error.kind() != io::ErrorKind::PermissionDenied {
		return OpenFailure::Permanent;
	}
	let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
	let mut name = UNICODE_STRING::default();
	let converted = unsafe {
		RtlDosPathNameToNtPathName_U_WithStatus(
			wide.as_ptr(),
			&mut name,
			std::ptr::null_mut(),
			std::ptr::null(),
		)
	};
	if converted < 0 {
		return OpenFailure::Permanent;
	}
	let attributes = OBJECT_ATTRIBUTES {
		Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
		ObjectName: &name,
		Attributes: OBJ_CASE_INSENSITIVE,
		..Default::default()
	};
	let mut information = FILE_BASIC_INFORMATION::default();
	let status = unsafe { nt_query_attributes_file(&attributes, &mut information) };
	unsafe { RtlFreeUnicodeString(&mut name) };
	match status {
		STATUS_DELETE_PENDING => {
			*delete_races = 0;
			OpenFailure::WaitDeletePending
		},
		STATUS_OBJECT_NAME_NOT_FOUND | STATUS_SUCCESS if *delete_races < MAX_DELETE_RACE_RETRIES => {
			*delete_races += 1;
			OpenFailure::RetryChangedPath
		},
		_ => OpenFailure::Permanent,
	}
}

#[cfg(not(windows))]
fn classify_delete_race(_path: &Path, _error: &io::Error, _delete_races: &mut u32) -> OpenFailure {
	OpenFailure::Permanent
}

fn try_lock_with(
	path: &Path,
	wait: Duration,
	mut lock: impl FnMut(&File) -> Result<(), TryLockError>,
) -> io::Result<Option<File>> {
	let mut options = OpenOptions::new();
	options.read(true).write(true).create(true).truncate(false);
	#[cfg(unix)]
	{
		use std::os::unix::fs::OpenOptionsExt;
		options.mode(0o600);
	}
	let deadline = Instant::now() + wait;
	let mut file: Option<File> = None;
	let mut delete_races = 0;
	let mut retried_replaced_path = false;
	loop {
		if file.is_none() {
			match options.open(path) {
				Ok(opened) => file = Some(opened),
				Err(error) => match classify_delete_race(path, &error, &mut delete_races) {
					#[cfg(windows)]
					OpenFailure::WaitDeletePending => {},
					#[cfg(windows)]
					OpenFailure::RetryChangedPath => {
						thread::sleep(DELETE_RACE_RETRY_INTERVAL);
						continue;
					},
					OpenFailure::Permanent => return Err(error),
				},
			}
		}
		if let Some(current) = &file {
			match lock(current) {
				Ok(()) if lock_matches_path(current, path) => return Ok(file),
				Ok(()) => {
					file = None;
					if retried_replaced_path && Instant::now() >= deadline {
						return Ok(None);
					}
					retried_replaced_path = true;
					continue;
				},
				Err(TryLockError::WouldBlock) => {},
				#[cfg(windows)]
				Err(TryLockError::Error(error))
					if error.kind() == io::ErrorKind::PermissionDenied
						&& delete_races < MAX_DELETE_RACE_RETRIES
						&& !lock_matches_path(current, path) =>
				{
					delete_races += 1;
					file = None;
					thread::sleep(DELETE_RACE_RETRY_INTERVAL);
					continue;
				},
				Err(TryLockError::Error(error)) => return Err(error),
			}
		}
		let now = Instant::now();
		if now >= deadline {
			return Ok(None);
		}
		thread::sleep(RETRY_INTERVAL.min(deadline - now));
	}
}

/// Takes the exclusive advisory lock of the file at `path`, created when missing, reopened if unlinked while
/// acquiring the lock, and never truncated: tried at once, then again until `wait` has passed. `None` while another
/// open file holds it, a delete-pending file remains at `path` on Windows, or repeated path replacement exhausts
/// `wait`. The lock lasts as long as the returned file is open, and the kernel releases it when its holder dies.
pub fn try_lock_file(path: &Path, wait: Duration) -> io::Result<Option<File>> {
	try_lock_with(path, wait, File::try_lock)
}

/// Takes a shared advisory lock on the file at `path`, created when missing, reopened if unlinked while acquiring the
/// lock, and never truncated: tried at once, then again until `wait` has passed. `None` while an exclusive holder
/// keeps it, a delete-pending file remains at `path` on Windows, or repeated path replacement exhausts `wait`. The
/// lock lasts as long as the returned file is open, and the kernel releases it when its holder dies.
pub fn try_lock_file_shared(path: &Path, wait: Duration) -> io::Result<Option<File>> {
	try_lock_with(path, wait, File::try_lock_shared)
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
	error.kind() == io::ErrorKind::AlreadyExists || is_directory_not_empty(error)
}

#[cfg(unix)]
fn is_directory_not_empty(error: &io::Error) -> bool {
	error.raw_os_error() == Some(libc::ENOTEMPTY)
}

#[cfg(not(unix))]
fn is_directory_not_empty(_error: &io::Error) -> bool {
	false
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
	napi::Error::new(napi::Status::GenericFailure, error.to_string())
}

/// An exclusive or shared advisory lock this process holds on an open file (#5193, #5317), released by
/// {@link AdvisoryLock.release}, when the object is collected, or by the kernel when this process dies.
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

/// Takes the exclusive advisory lock of the file at `path` (#5193, #5317): `flock` on Unix, `LockFileEx` on Windows.
/// The file is created when missing, reopened if unlinked while acquiring the lock, and never truncated or removed.
/// Tried at once, then again until `waitMs` has passed; `null` while another holder keeps it, a delete-pending file
/// remains at `path` on Windows, or repeated path replacement exhausts `waitMs`. Throws when the file cannot be opened
/// or locked.
#[napi(js_name = "tryAdvisoryLock")]
pub fn try_advisory_lock(path: String, wait_ms: u32) -> napi::Result<Option<AdvisoryLock>> {
	let file = try_lock_file(Path::new(&path), Duration::from_millis(u64::from(wait_ms)))
		.map_err(napi_error)?;
	Ok(file.map(|file| AdvisoryLock { file: Some(file) }))
}

/// Asynchronous form of {@link tryAdvisoryLock}: acquires the exclusive advisory lock on a worker thread without
/// blocking the JavaScript event loop.
#[napi(js_name = "tryAdvisoryLockAsync")]
pub async fn try_advisory_lock_async(
	path: String,
	wait_ms: u32,
) -> napi::Result<Option<AdvisoryLock>> {
	let file = napi::tokio::task::spawn_blocking(move || {
		try_lock_file(Path::new(&path), Duration::from_millis(u64::from(wait_ms)))
	})
	.await
	.map_err(|error| napi::Error::new(napi::Status::GenericFailure, error.to_string()))?
	.map_err(napi_error)?;
	Ok(file.map(|file| AdvisoryLock { file: Some(file) }))
}

/// Takes a shared advisory lock on the file at `path` (#5317): `flock` on Unix, `LockFileEx` on Windows. The file is
/// created when missing, reopened if unlinked while acquiring the lock, and never truncated or removed. Tried at once,
/// then again until `waitMs` has passed; `null` while an exclusive holder keeps it, a delete-pending file remains at
/// `path` on Windows, or repeated path replacement exhausts `waitMs`. Throws when the file cannot be opened or locked.
#[napi(js_name = "trySharedAdvisoryLock")]
pub fn try_shared_advisory_lock(path: String, wait_ms: u32) -> napi::Result<Option<AdvisoryLock>> {
	let file = try_lock_file_shared(Path::new(&path), Duration::from_millis(u64::from(wait_ms)))
		.map_err(napi_error)?;
	Ok(file.map(|file| AdvisoryLock { file: Some(file) }))
}

/// Asynchronous form of {@link trySharedAdvisoryLock}: acquires the shared advisory lock on a worker thread without
/// blocking the JavaScript event loop.
#[napi(js_name = "trySharedAdvisoryLockAsync")]
pub async fn try_shared_advisory_lock_async(
	path: String,
	wait_ms: u32,
) -> napi::Result<Option<AdvisoryLock>> {
	let file = napi::tokio::task::spawn_blocking(move || {
		try_lock_file_shared(Path::new(&path), Duration::from_millis(u64::from(wait_ms)))
	})
	.await
	.map_err(|error| napi::Error::new(napi::Status::GenericFailure, error.to_string()))?
	.map_err(napi_error)?;
	Ok(file.map(|file| AdvisoryLock { file: Some(file) }))
}

/// Renames `from` to `to` only while nothing is at `to` (#5193): `false`, with nothing moved, when something is there,
/// so a moved item is put back without ever replacing another. Throws on any other failure.
#[napi(js_name = "renameNoReplace")]
pub fn rename_no_replace_napi(from: String, to: String) -> napi::Result<bool> {
	rename_no_replace(Path::new(&from), Path::new(&to)).map_err(napi_error)
}

/// Asynchronous form of {@link renameNoReplace}: renames `from` to `to` without replacing an existing destination on a
/// worker thread without blocking the JavaScript event loop.
#[napi(js_name = "renameNoReplaceAsync")]
pub async fn rename_no_replace_async(from: String, to: String) -> napi::Result<bool> {
	napi::tokio::task::spawn_blocking(move || rename_no_replace(Path::new(&from), Path::new(&to)))
		.await
		.map_err(|error| napi::Error::new(napi::Status::GenericFailure, error.to_string()))?
		.map_err(napi_error)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn replacement_retries_respect_the_deadline_5317() {
		let stamp =
			std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
		let directory =
			std::env::temp_dir().join(format!("atomic-replaced-lock-{}-{stamp}", std::process::id()));
		std::fs::create_dir_all(&directory).unwrap();
		let path = directory.join("replaced.lock");
		let mut replacements = 0;
		let acquired = try_lock_with(&path, Duration::ZERO, |file| {
			file.try_lock()?;
			std::fs::remove_file(&path).unwrap();
			replacements += 1;
			if replacements > 3 {
				return Err(TryLockError::Error(io::Error::other(
					"replacement retries exceeded the deadline",
				)));
			}
			Ok(())
		});
		std::fs::remove_dir_all(directory).unwrap();
		assert!(acquired.unwrap().is_none(), "a repeatedly replaced path must exhaust its wait");
	}

	#[cfg(not(windows))]
	#[test]
	fn a_refused_lock_on_a_replaced_path_fails_at_once_off_windows_5317() {
		let stamp =
			std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
		let directory =
			std::env::temp_dir().join(format!("atomic-refused-lock-{}-{stamp}", std::process::id()));
		std::fs::create_dir_all(&directory).unwrap();
		let path = directory.join("refused.lock");
		let mut attempts = 0;
		let acquired = try_lock_with(&path, Duration::ZERO, |_file| {
			attempts += 1;
			let _ = std::fs::remove_file(&path);
			Err(TryLockError::Error(io::Error::from(io::ErrorKind::PermissionDenied)))
		});
		std::fs::remove_dir_all(directory).unwrap();
		assert_eq!(
			acquired.unwrap_err().kind(),
			io::ErrorKind::PermissionDenied,
			"the refusal is reported"
		);
		assert_eq!(attempts, 1, "a permission refusal is reported after one attempt");
	}
}
