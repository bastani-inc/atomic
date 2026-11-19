//! A Windows temporary name reserved for deletion at creation, not looked up again at cleanup.
use std::fs::File;

use napi_derive::napi;

/// Removes a regular file older than `beforeMs` using the handle whose last-write time was checked.
#[napi]
pub fn remove_windows_file_older_than(path: String, before_ms: f64) -> crate::task::Promise<()> {
	crate::task::blocking("old-temporary-file", (), move |_| {
		#[cfg(windows)]
		{
			use std::{
				fs::OpenOptions,
				os::windows::{
					fs::{MetadataExt, OpenOptionsExt},
					io::AsRawHandle,
				},
			};
			use windows_sys::Win32::Storage::FileSystem::{
				DELETE, FILE_ATTRIBUTE_REPARSE_POINT, FILE_DISPOSITION_INFO,
				FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
				FileDispositionInfo, SetFileInformationByHandle,
			};
			// Do not follow a link at the old probe's name or let another opener move this name before disposition.
			let Ok(file) = OpenOptions::new()
				.access_mode(DELETE | FILE_READ_ATTRIBUTES)
				.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
				.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
				.open(path)
			else {
				return Ok(());
			};
			if let Ok(meta) = file.metadata()
				&& meta.is_file()
				&& meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
			{
				// FILETIME counts 100 ns from 1601; JavaScript timestamps count milliseconds from 1970.
				let modified_ms =
					(i128::from(meta.last_write_time()) - 116_444_736_000_000_000) as f64 / 10_000.0;
				if modified_ms < before_ms {
					let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
					unsafe {
						SetFileInformationByHandle(
							file.as_raw_handle(),
							FileDispositionInfo,
							(&raw const disposition).cast(),
							std::mem::size_of_val(&disposition) as u32,
						)
					};
				}
			}
		}
		#[cfg(not(windows))]
		let _ = (path, before_ms);
		Ok(())
	})
}

#[napi]
pub struct WindowsTemporaryFile {
	file: Option<File>,
}

#[napi]
impl WindowsTemporaryFile {
	/// Close the original handle off the event loop. Closing it removes only its own name, not a published hard link.
	#[napi]
	pub fn close(&mut self) -> crate::task::Promise<()> {
		let file = self.file.take();
		crate::task::blocking("temporary-file-close", (), move |_| {
			drop(file);
			Ok(())
		})
	}
}

/// Creates a new file without replacing an existing entry. A null result means the filesystem does not support
/// delete-on-close here. An existing name is reported separately so the caller can choose another one.
#[napi]
pub fn open_windows_temporary_file(
	path: String,
) -> crate::task::Promise<Option<WindowsTemporaryFile>> {
	crate::task::blocking("temporary-file-open", (), move |_| {
		#[cfg(windows)]
		{
			use std::{fs::OpenOptions, io::ErrorKind, os::windows::fs::OpenOptionsExt};
			use windows_sys::Win32::Storage::FileSystem::{
				FILE_FLAG_DELETE_ON_CLOSE, FILE_SHARE_READ, FILE_SHARE_WRITE,
			};
			match OpenOptions::new()
				.write(true)
				.create_new(true)
				.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
				.custom_flags(FILE_FLAG_DELETE_ON_CLOSE)
				.open(path)
			{
				Ok(file) => Ok(Some(WindowsTemporaryFile { file: Some(file) })),
				Err(error) if error.kind() == ErrorKind::AlreadyExists => {
					Err(napi::Error::from_reason("EEXIST"))
				},
				Err(_) => Ok(None),
			}
		}
		#[cfg(not(windows))]
		{
			let _ = path;
			Ok(None)
		}
	})
}
