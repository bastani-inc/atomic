//! Synchronous libuv file I/O on the existing blocking worker. The host, not this DLL's private CRT,
//! applies the current creation mask and owns the descriptor table.
use std::{
	ffi::{CString, c_char, c_void},
	fs::File,
	mem::ManuallyDrop,
	os::windows::io::{FromRawHandle, RawHandle},
	ptr,
	sync::OnceLock,
};
use windows_sys::Win32::{
	Foundation::INVALID_HANDLE_VALUE,
	System::LibraryLoader::{GetModuleHandleW, GetProcAddress},
};

type Req = *mut c_void;
type Loop = *mut c_void;
type Callback = Option<unsafe extern "C" fn(Req)>;
struct HostFs {
	size: usize,
	open: unsafe extern "C" fn(Loop, Req, *const c_char, i32, i32, Callback) -> i32,
	close: unsafe extern "C" fn(Loop, Req, i32, Callback) -> i32,
	unlink: unsafe extern "C" fn(Loop, Req, *const c_char, Callback) -> i32,
	cleanup: unsafe extern "C" fn(Req),
	handle: unsafe extern "C" fn(i32) -> RawHandle,
}

fn host() -> Option<&'static HostFs> {
	static HOST: OnceLock<Option<HostFs>> = OnceLock::new();
	HOST
		.get_or_init(|| unsafe {
			let host = GetModuleHandleW(ptr::null());
			macro_rules! symbol {
				($name:literal,$ty:ty) => {{
					let f = GetProcAddress(host, concat!($name, "\0").as_ptr())?;
					std::mem::transmute::<unsafe extern "system" fn() -> isize, $ty>(f)
				}};
			}
			let request_size = symbol!("uv_req_size", unsafe extern "C" fn(i32) -> usize);
			// UV_FS is the sixth public uv_req_type. Ask the loaded libuv for its opaque request size.
			const UV_FS: i32 = 6;
			let size = request_size(UV_FS);
			if size == 0 || size == usize::MAX {
				return None;
			}
			Some(HostFs {
				size,
				open: symbol!(
					"uv_fs_open",
					unsafe extern "C" fn(Loop, Req, *const c_char, i32, i32, Callback) -> i32
				),
				close: symbol!("uv_fs_close", unsafe extern "C" fn(Loop, Req, i32, Callback) -> i32),
				unlink: symbol!(
					"uv_fs_unlink",
					unsafe extern "C" fn(Loop, Req, *const c_char, Callback) -> i32
				),
				cleanup: symbol!("uv_fs_req_cleanup", unsafe extern "C" fn(Req)),
				handle: symbol!("uv_get_osfhandle", unsafe extern "C" fn(i32) -> RawHandle),
			})
		})
		.as_ref()
}

pub(super) struct Creator {
	host: &'static HostFs,
	request: Vec<usize>,
	path: CString,
	fd: i32,
}

impl Creator {
	pub(super) fn open(path: &str) -> napi::Result<Option<Self>> {
		let Some(host) = host() else {
			return Ok(None);
		};
		let path = CString::new(path).map_err(|_| napi::Error::from_reason("Invalid file name"))?;
		let mut request = vec![0usize; host.size.div_ceil(size_of::<usize>())];
		let req = request.as_mut_ptr().cast();
		// NULL callback selects the documented synchronous operation; no second worker is queued.
		let fd = unsafe {
			(host.open)(
				ptr::null_mut(),
				req,
				path.as_ptr(),
				libc::O_CREAT | libc::O_EXCL | libc::O_WRONLY,
				0o666,
				None,
			)
		};
		unsafe {
			(host.cleanup)(req);
		}
		if fd < 0 {
			const UV_EEXIST: i32 = -4075; // Windows libuv errno, independent of the DLL's CRT errno.
			return Err(napi::Error::from_reason(if fd == UV_EEXIST {
				"EEXIST"
			} else {
				"Probe create failed"
			}));
		}
		Ok(Some(Self { host, request, path, fd }))
	}

	pub(super) fn with_file<T>(&self, f: impl FnOnce(&File) -> T) -> Option<T> {
		let raw = unsafe { (self.host.handle)(self.fd) };
		if raw.is_null() || raw == INVALID_HANDLE_VALUE {
			return None;
		}
		// The runtime owns the handle until this creator drops. Never close it with this DLL's CRT.
		let file = ManuallyDrop::new(unsafe { File::from_raw_handle(raw) });
		Some(f(&file))
	}

	pub(super) fn ordinary_unlink(&mut self) {
		let req = self.request.as_mut_ptr().cast();
		unsafe {
			(self.host.unlink)(ptr::null_mut(), req, self.path.as_ptr(), None);
			(self.host.cleanup)(req);
		}
	}
}

impl Drop for Creator {
	fn drop(&mut self) {
		let req = self.request.as_mut_ptr().cast();
		unsafe {
			(self.host.close)(ptr::null_mut(), req, self.fd, None);
			(self.host.cleanup)(req);
		}
	}
}
