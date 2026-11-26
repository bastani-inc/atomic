//! A plain `fsync(2)` of an open file (#6686).
//!
//! On macOS, Node's `FileHandle.sync()` and `FileHandle.datasync()` both run `fcntl(F_FULLFSYNC)`, which also flushes
//! the drive's own write cache and takes milliseconds. SQLite on macOS syncs with plain `fsync(2)` unless
//! `PRAGMA fullfsync` is on, and Bun's `datasync()` does too. The JSONL session store syncs through this so it keeps
//! the same promise as the SQLite store on every runtime: what is acknowledged has reached the drive.

use napi_derive::napi;
use std::io;

/// Syncs the file open at descriptor `fd` with `fsync(2)`, on a worker thread. The caller keeps `fd` open until the
/// returned promise settles. A call interrupted by a signal is made again. Fails on non-Unix platforms.
#[napi(js_name = "fsyncDescriptor")]
pub async fn fsync_descriptor(fd: i32) -> napi::Result<()> {
	#[cfg(unix)]
	{
		napi::tokio::task::spawn_blocking(move || fsync_retrying(fd))
			.await
			.map_err(|error| napi::Error::new(napi::Status::GenericFailure, error.to_string()))?
			.map_err(|error| napi::Error::new(napi::Status::GenericFailure, format!("fsync: {error}")))
	}
	#[cfg(not(unix))]
	{
		let _ = fd;
		Err(napi::Error::new(
			napi::Status::GenericFailure,
			"fsyncDescriptor is only supported on Unix",
		))
	}
}

#[cfg(unix)]
fn fsync_retrying(fd: i32) -> io::Result<()> {
	loop {
		// SAFETY: `fsync` reads only the descriptor, which the caller keeps open until this returns.
		if unsafe { libc::fsync(fd) } == 0 {
			return Ok(());
		}
		let error = io::Error::last_os_error();
		if error.kind() != io::ErrorKind::Interrupted {
			return Err(error);
		}
	}
}

#[cfg(all(test, unix))]
mod tests {
	use std::io::Write;
	use std::os::fd::AsRawFd;

	use super::*;

	#[test]
	fn syncs_an_open_file_and_refuses_a_closed_descriptor_6686() {
		let path = std::env::temp_dir().join(format!("atomic-fsync-{}", std::process::id()));
		let mut file = std::fs::File::create(&path).unwrap();
		file.write_all(b"line\n").unwrap();
		assert!(fsync_retrying(file.as_raw_fd()).is_ok());
		drop(file);
		std::fs::remove_file(&path).unwrap();
		let error = fsync_retrying(-1).unwrap_err();
		assert_eq!(error.raw_os_error(), Some(libc::EBADF));
	}
}
