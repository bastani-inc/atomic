//! Input already typed for this process that it has not read yet, so a startup dialog can take standard input only
//! after the startup capture has received everything typed before it.
use napi_derive::napi;

/// How much input waits unread on this process's standard input: bytes on Unix, input events for a Windows console.
/// `null` where the OS cannot say without waiting: for a Windows pipe, whose peek waits behind a read already pending
/// on it, and for a closed handle.
#[napi(js_name = "pendingStdinInput")]
pub fn pending_stdin_input() -> Option<u32> {
	pending()
}

#[cfg(unix)]
fn pending() -> Option<u32> {
	let mut count: libc::c_int = 0;
	let result = unsafe { libc::ioctl(libc::STDIN_FILENO, libc::FIONREAD, &mut count) };
	(result == 0 && count >= 0).then_some(count as u32)
}

#[cfg(windows)]
fn pending() -> Option<u32> {
	use windows_sys::Win32::{
		Foundation::INVALID_HANDLE_VALUE,
		Storage::FileSystem::{FILE_TYPE_CHAR, GetFileType},
		System::Console::{GetNumberOfConsoleInputEvents, GetStdHandle, STD_INPUT_HANDLE},
	};
	let handle = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
	if handle.is_null()
		|| handle == INVALID_HANDLE_VALUE
		|| unsafe { GetFileType(handle) } != FILE_TYPE_CHAR
	{
		return None;
	}
	let mut count = 0u32;
	(unsafe { GetNumberOfConsoleInputEvents(handle, &mut count) } != 0).then_some(count)
}

#[cfg(not(any(unix, windows)))]
fn pending() -> Option<u32> {
	None
}

#[cfg(all(test, unix))]
mod tests {
	use super::pending;

	#[test]
	fn counts_bytes_waiting_in_a_pipe_on_standard_input() {
		let mut fds = [0; 2];
		assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
		let saved = unsafe { libc::dup(libc::STDIN_FILENO) };
		assert!(saved >= 0);
		assert!(unsafe { libc::dup2(fds[0], libc::STDIN_FILENO) } >= 0);
		let empty = pending();
		let written = unsafe { libc::write(fds[1], b"hello".as_ptr().cast(), 5) };
		let full = pending();
		unsafe {
			libc::dup2(saved, libc::STDIN_FILENO);
			libc::close(saved);
			libc::close(fds[0]);
			libc::close(fds[1]);
		}
		assert_eq!(written, 5);
		assert_eq!(empty, Some(0));
		assert_eq!(full, Some(5));
	}
}
