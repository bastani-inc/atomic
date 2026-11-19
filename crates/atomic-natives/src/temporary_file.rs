//! Remove a Windows temporary name only through the handle whose identity was checked.
use std::fs::File;

use napi_derive::napi;

#[cfg(windows)]
mod host_fs;

#[cfg(windows)]
fn open_name(path: &str, access: u32, share_delete: bool) -> std::io::Result<File> {
	use std::{fs::OpenOptions, os::windows::fs::OpenOptionsExt};
	use windows_sys::Win32::Storage::FileSystem::{
		FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ,
		FILE_SHARE_WRITE,
	};
	OpenOptions::new()
		.access_mode(access)
		.share_mode(
			FILE_SHARE_READ | FILE_SHARE_WRITE | if share_delete { FILE_SHARE_DELETE } else { 0 },
		)
		.custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
		.open(path)
}

#[cfg(windows)]
fn file_id(file: &File) -> Option<(u64, [u8; 16])> {
	use std::os::windows::io::AsRawHandle;
	use windows_sys::Win32::Storage::FileSystem::{
		FILE_ID_INFO, FileIdInfo, GetFileInformationByHandleEx,
	};
	let mut info = FILE_ID_INFO::default();
	let ok = unsafe {
		GetFileInformationByHandleEx(
			file.as_raw_handle(),
			FileIdInfo,
			(&raw mut info).cast(),
			std::mem::size_of_val(&info) as u32,
		)
	};
	(ok != 0 && info.FileId.Identifier != [0; 16])
		.then_some((info.VolumeSerialNumber, info.FileId.Identifier))
}

#[cfg(windows)]
fn same_file(a: &File, b: &File) -> bool {
	file_id(a).is_some_and(|id| file_id(b) == Some(id))
}

#[cfg(windows)]
fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
	use std::os::windows::fs::MetadataExt;
	// Stats.mtimeMs converts whole seconds and fractional nanoseconds separately.
	let ticks = i128::from(meta.last_write_time()) - 116_444_736_000_000_000;
	ticks.div_euclid(10_000_000) as f64 * 1000.0 + ticks.rem_euclid(10_000_000) as f64 / 10_000.0
}

/// Removes a regular file older than `beforeMs` using the handle whose last-write time was checked.
#[napi]
pub fn remove_windows_file_older_than(path: String, before_ms: f64) -> crate::task::Promise<()> {
	crate::task::blocking("old-temporary-file", (), move |_| {
		#[cfg(windows)]
		{
			use std::os::windows::fs::MetadataExt;
			use windows_sys::Win32::Storage::FileSystem::{
				DELETE, FILE_ATTRIBUTE_REPARSE_POINT, FILE_READ_ATTRIBUTES,
			};
			if let Ok(file) = open_name(&path, DELETE | FILE_READ_ATTRIBUTES, true)
				&& let Ok(meta) = file.metadata()
				&& meta.is_file()
				&& meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
			{
				if mtime_ms(&meta) < before_ms {
					let _ = dispose_by_handle(&file);
				}
			}
		}
		#[cfg(not(windows))]
		let _ = (path, before_ms);
		Ok(())
	})
}

/// Retry a refused temporary-link removal only if both open names still identify the published file.
#[napi]
pub fn remove_windows_hard_link(
	temporary: String,
	published: String,
) -> crate::task::Promise<bool> {
	crate::task::blocking("temporary-hard-link", (), move |_| {
		#[cfg(windows)]
		{
			use windows_sys::Win32::Storage::FileSystem::{DELETE, FILE_READ_ATTRIBUTES};
			let Ok(link) = open_name(&temporary, DELETE | FILE_READ_ATTRIBUTES, true) else {
				return Ok(false);
			};
			let Ok(record) = open_name(&published, FILE_READ_ATTRIBUTES, true) else {
				return Ok(false);
			};
			Ok(same_file(&link, &record) && dispose_name(&link, false).is_ok())
		}
		#[cfg(not(windows))]
		{
			let _ = (temporary, published);
			Ok(false)
		}
	})
}

#[napi]
pub struct WindowsTemporaryFile {
	file: Option<File>,
	// If a scanner refused the reservation, retain the original identity until this reading's cleanup.
	recheck: Option<(String, File)>,
}

#[napi(object, object_from_js = false)]
pub struct WindowsClockReading {
	pub mtime_ms: f64,
	pub created_in_ms: f64,
	pub pending: Option<WindowsTemporaryFile>,
}

#[napi]
impl WindowsTemporaryFile {
	/// Dispose the reserved name, not a file which may since have appeared at the same path.
	#[napi]
	pub fn close(&mut self) -> crate::task::Promise<()> {
		let file = self.file.take();
		let recheck = self.recheck.take();
		crate::task::blocking("temporary-file-close", (), move |_| {
			#[cfg(windows)]
			{
				use windows_sys::Win32::Storage::FileSystem::{DELETE, FILE_READ_ATTRIBUTES};
				if let Some(file) = &file {
					dispose_by_handle(file)
						.map_err(|error| napi::Error::from_reason(error.to_string()))?;
				} else if let Some((path, creator)) = &recheck
					&& let Ok(now) = open_name(path, DELETE | FILE_READ_ATTRIBUTES, true)
					&& same_file(&now, creator)
				{
					dispose_by_handle(&now)
						.map_err(|error| napi::Error::from_reason(error.to_string()))?;
				}
			}
			drop((file, recheck));
			Ok(())
		})
	}
}

/// Create with the host's current mask and reserve the name before sampling, in one filesystem-worker turn.
/// Null means that the host's libuv operations are unavailable; no create has been attempted.
#[napi]
pub fn read_windows_clock_probe(path: String) -> crate::task::Promise<Option<WindowsClockReading>> {
	#[cfg(windows)]
	let started = std::time::Instant::now();
	crate::task::blocking("temporary-clock-probe", (), move |_| {
		#[cfg(windows)]
		{
			let Some(mut created) = host_fs::Creator::open(&path)? else {
				return Ok(None);
			};
			let created_in_ms = started.elapsed().as_secs_f64() * 1000.0;
			let sample = created
				.with_file(|creator| {
					let Some(id) = file_id(creator) else {
						return Some((mtime_ms(&creator.metadata().ok()?), None, true));
					};
					// Acquire the rights actually granted, rather than retrying a create that requests DELETE.
					const MAXIMUM_ALLOWED: u32 = 0x0200_0000;
					let pending = match open_name(&path, MAXIMUM_ALLOWED, false) {
						Ok(file) if file_id(&file) == Some(id) => {
							Some(WindowsTemporaryFile { file: Some(file), recheck: None })
						},
						Ok(_) => None, // A replacement is not ours to unlink.
						Err(_) => creator.try_clone().ok().map(|original| WindowsTemporaryFile {
							file: None,
							recheck: Some((path.clone(), original)),
						}),
					};
					Some((mtime_ms(&creator.metadata().ok()?), pending, false))
				})
				.flatten();
			let Some((mtime_ms, pending, ordinary)) = sample else {
				created.ordinary_unlink();
				return Err(napi::Error::from_reason("Could not sample probe"));
			};
			// A filesystem without stable IDs gets ordinary one-shot unlink, never a later pathname retry.
			if ordinary {
				created.ordinary_unlink();
			}
			Ok(Some(WindowsClockReading { mtime_ms, created_in_ms, pending }))
		}
		#[cfg(not(windows))]
		{
			let _ = path;
			Ok(None)
		}
	})
}

#[cfg(windows)]
fn dispose_by_handle(file: &File) -> std::io::Result<()> {
	dispose_name(file, true)
}

#[cfg(windows)]
fn dispose_name(file: &File, clear_readonly: bool) -> std::io::Result<()> {
	use std::os::windows::io::AsRawHandle;
	use windows_sys::Win32::{
		Foundation::{ERROR_INVALID_FUNCTION, ERROR_INVALID_PARAMETER, ERROR_NOT_SUPPORTED},
		Storage::FileSystem::{
			FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
			FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO, FILE_DISPOSITION_INFO_EX,
			FileDispositionInfo, FileDispositionInfoEx, SetFileInformationByHandle,
		},
	};
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
	if !matches!(
		error.raw_os_error().map(|n| n as u32),
		Some(ERROR_INVALID_FUNCTION | ERROR_INVALID_PARAMETER | ERROR_NOT_SUPPORTED)
	) {
		return Err(error);
	}
	// Older volumes do not implement IGNORE_READONLY. Match ordinary unlink for a probe, but never
	// change the permissions of a published slot just to remove its spare hard link.
	if clear_readonly {
		use std::os::windows::{fs::MetadataExt, io::FromRawHandle};
		use windows_sys::Win32::{
			Foundation::INVALID_HANDLE_VALUE,
			Storage::FileSystem::{
				FILE_ATTRIBUTE_ARCHIVE, FILE_ATTRIBUTE_READONLY, FILE_BASIC_INFO,
				FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
				FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_WRITE_ATTRIBUTES, FileBasicInfo, ReOpenFile,
			},
		};
		let attrs = file.metadata()?.file_attributes();
		if attrs & FILE_ATTRIBUTE_READONLY != 0 {
			let raw = unsafe {
				ReOpenFile(
					file.as_raw_handle(),
					FILE_WRITE_ATTRIBUTES,
					FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
					FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
				)
			};
			if raw == INVALID_HANDLE_VALUE {
				return Err(std::io::Error::last_os_error());
			}
			let writer = unsafe { File::from_raw_handle(raw) };
			let basic = FILE_BASIC_INFO {
				FileAttributes: (attrs & !FILE_ATTRIBUTE_READONLY) | FILE_ATTRIBUTE_ARCHIVE,
				..Default::default()
			};
			if unsafe {
				SetFileInformationByHandle(
					writer.as_raw_handle(),
					FileBasicInfo,
					(&raw const basic).cast(),
					std::mem::size_of_val(&basic) as u32,
				)
			} == 0
			{
				return Err(std::io::Error::last_os_error());
			}
		}
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
