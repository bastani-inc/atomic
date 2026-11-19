//! A Windows temporary name reserved for deletion at creation, not looked up again at cleanup.
use std::{fs::File, io::Write, sync::Arc};

use napi_derive::napi;

/// Removes a regular file older than `beforeMs` using the handle whose last-write time was checked.
#[napi]
pub fn remove_windows_file_older_than(path: String, before_ms: f64) -> crate::task::Promise<()> {
	crate::task::blocking("old-temporary-file", (), move |_| {
		#[cfg(windows)]
		{
			use std::{
				fs::OpenOptions,
				os::windows::fs::{MetadataExt, OpenOptionsExt},
			};
			use windows_sys::Win32::Storage::FileSystem::{
				DELETE, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
				FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
				FILE_SHARE_WRITE,
			};
			// Preserve unlink's sharing semantics. Check and dispose the same opened file, not its path.
			let Ok(file) = OpenOptions::new()
				.access_mode(DELETE | FILE_READ_ATTRIBUTES)
				.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
				.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
				.open(path)
			else {
				return Ok(());
			};
			if let Ok(meta) = file.metadata()
				&& meta.is_file()
				&& meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
			{
				// Like Stats.mtimeMs, convert whole seconds and fractional nanoseconds separately. Casting
				// epoch-sized FILETIME ticks to double first can round a tick across the cutoff.
				let ticks = i128::from(meta.last_write_time()) - 116_444_736_000_000_000;
				let modified_ms = ticks.div_euclid(10_000_000) as f64 * 1000.0
					+ ticks.rem_euclid(10_000_000) as f64 / 10_000.0;
				if modified_ms < before_ms {
					let _ = dispose_by_handle(&file);
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
	file: Option<Arc<File>>,
}

#[napi]
impl WindowsTemporaryFile {
	/// Write through the handle granted at creation; opening the path again can require different permissions.
	#[napi]
	pub fn write_file(&self, data: String) -> crate::task::Promise<()> {
		let file = self.file.clone();
		crate::task::blocking("temporary-file-write", (), move |_| {
			let mut file =
				file.as_deref().ok_or_else(|| napi::Error::from_reason("File is closed"))?;
			file
				.write_all(data.as_bytes())
				.map_err(|error| napi::Error::from_reason(error.to_string()))
		})
	}

	/// Close the original handle off the event loop. Closing it removes only its own name, not a published hard link.
	#[napi]
	pub fn close(&mut self) -> crate::task::Promise<()> {
		let file = self.file.take();
		crate::task::blocking("temporary-file-close", (), move |_| {
			#[cfg(windows)]
			if let Some(file) = &file {
				dispose_by_handle(file).map_err(|error| napi::Error::from_reason(error.to_string()))?;
			}
			drop(file);
			Ok(())
		})
	}
}

#[cfg(windows)]
fn dispose_by_handle(file: &File) -> std::io::Result<()> {
	use std::os::windows::io::AsRawHandle;
	use windows_sys::Win32::{
		Foundation::{ERROR_INVALID_FUNCTION, ERROR_INVALID_PARAMETER, ERROR_NOT_SUPPORTED},
		Storage::FileSystem::{
			FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
			FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO, FILE_DISPOSITION_INFO_EX,
			FileDispositionInfo, FileDispositionInfoEx, SetFileInformationByHandle,
		},
	};
	// Unlink the name now, even while a compatible reader still has the file open. A legacy delete-pending
	// file cannot be opened, but its name still appears in directory listings until that reader closes.
	let disposition = FILE_DISPOSITION_INFO_EX {
		Flags: FILE_DISPOSITION_FLAG_DELETE
			| FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
			| FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
	};
	if unsafe {
		SetFileInformationByHandle(
			file.as_raw_handle(),
			FileDispositionInfoEx,
			(&raw const disposition).cast(),
			std::mem::size_of_val(&disposition) as u32,
		)
	} != 0
	{
		return Ok(());
	}
	let error = std::io::Error::last_os_error();
	let code = error.raw_os_error().map(|n| n as u32);
	if !matches!(code, Some(ERROR_INVALID_FUNCTION | ERROR_INVALID_PARAMETER | ERROR_NOT_SUPPORTED))
	{
		return Err(error);
	}
	let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
	if unsafe {
		SetFileInformationByHandle(
			file.as_raw_handle(),
			FileDispositionInfo,
			(&raw const disposition).cast(),
			std::mem::size_of_val(&disposition) as u32,
		)
	} != 0
	{
		Ok(())
	} else {
		Err(std::io::Error::last_os_error())
	}
}

/// Opens an exclusive temporary file, pinning its name until close. A clock probe takes the rights granted by its
/// directory and requests deletion only after measuring the clock; a writable record also requests delete access.
/// A failed probe create rejects; only a name collision permits another attempt. A record may fall back if delete access is unavailable.
#[napi]
pub fn open_windows_temporary_file(
	path: String,
	clock_probe: Option<bool>,
) -> crate::task::Promise<Option<WindowsTemporaryFile>> {
	open_temporary(path, clock_probe == Some(true), false, None)
}

/// Create and write a slot in one worker operation, before JavaScript has to run again.
#[napi]
pub fn create_windows_temporary_record(
	path: String,
	data: String,
	read_only: bool,
) -> crate::task::Promise<Option<WindowsTemporaryFile>> {
	open_temporary(path, false, read_only, Some(data))
}

fn open_temporary(
	path: String,
	measuring: bool,
	read_only: bool,
	record: Option<String>,
) -> crate::task::Promise<Option<WindowsTemporaryFile>> {
	crate::task::blocking("temporary-file-open", (), move |_| {
		#[cfg(windows)]
		{
			use std::{fs::OpenOptions, io::ErrorKind, os::windows::fs::OpenOptionsExt};
			use windows_sys::Win32::Storage::FileSystem::{
				DELETE, FILE_ATTRIBUTE_READONLY, FILE_FLAG_BACKUP_SEMANTICS, FILE_GENERIC_WRITE,
				FILE_SHARE_READ, FILE_SHARE_WRITE,
			};
			let mut options = OpenOptions::new();
			options.write(true).create_new(true).share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE);
			if measuring {
				// Acquire whatever rights are granted (including DELETE where allowed). A directory that
				// allows creation but not deletion still supplies its clock in one open. Asking for
				// delete-on-close first would pay a slow delete refusal twice on that filesystem.
				const MAXIMUM_ALLOWED: u32 = 0x0200_0000;
				options.access_mode(MAXIMUM_ALLOWED);
			} else {
				// Reserve delete access, not delete-on-close: that flag keeps the temporary name listed
				// until every reader closes, even after a successful POSIX unlink on this handle.
				options
					.access_mode(FILE_GENERIC_WRITE | DELETE)
					.custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
				if read_only {
					options.attributes(FILE_ATTRIBUTE_READONLY);
				}
			}
			match options.open(path) {
				Ok(mut file) => {
					if let Some(data) = record
						&& let Err(error) = file.write_all(data.as_bytes())
					{
						let _ = dispose_by_handle(&file);
						return Err(napi::Error::from_reason(error.to_string()));
					}
					Ok(Some(WindowsTemporaryFile { file: Some(Arc::new(file)) }))
				},
				Err(error) if error.kind() == ErrorKind::AlreadyExists => {
					Err(napi::Error::from_reason("EEXIST"))
				},
				Err(error) if error.kind() == ErrorKind::NotFound => {
					Err(napi::Error::from_reason("ENOENT"))
				},
				Err(error) if measuring => Err(napi::Error::from_reason(error.to_string())),
				Err(_) => Ok(None),
			}
		}
		#[cfg(not(windows))]
		{
			let _ = (path, measuring, read_only, record);
			Ok(None)
		}
	})
}
