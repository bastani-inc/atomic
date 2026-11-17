//! The scheduling priority of the calling thread. A thread that sleeps until it is sent work, such as a SQLite
//! connection's thread, waits on Windows behind every busy thread of its priority once the CPUs are oversubscribed: a
//! whole scheduler quantum per wake-up, tens to hundreds of milliseconds (#5376). Above-normal priority lets it run
//! as soon as it is woken.
use napi_derive::napi;

/// Raises the calling thread, and only it, to above-normal priority on Windows; returns whether it did. Does nothing
/// and returns false on other platforms, where raising a thread's priority needs a privilege a process lacks.
#[napi(js_name = "raiseCurrentThreadPriority")]
pub fn raise_current_thread_priority() -> bool {
	raise()
}

/// The calling thread's priority relative to its process's priority class on Windows (0 is normal, 1 above normal);
/// 0 on other platforms.
#[napi(js_name = "currentThreadPriority")]
pub fn current_thread_priority() -> i32 {
	current()
}

#[cfg(windows)]
fn raise() -> bool {
	use windows_sys::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_ABOVE_NORMAL};
	unsafe { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL) != 0 }
}

#[cfg(not(windows))]
fn raise() -> bool {
	false
}

#[cfg(windows)]
fn current() -> i32 {
	use windows_sys::Win32::System::Threading::{GetCurrentThread, GetThreadPriority};
	unsafe { GetThreadPriority(GetCurrentThread()) }
}

#[cfg(not(windows))]
fn current() -> i32 {
	0
}
