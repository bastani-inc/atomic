//! When a process started, so a holder named by its process id is told apart from a later process given the same id
//! (#5141). Windows reuses process ids quickly and has no `/proc` to read a start from.
use napi_derive::napi;

/// When running process `pid` was created, as the decimal count of 100-nanosecond intervals since 1601-01-01 UTC (the
/// Windows process creation time), or `null` where that cannot be read: on other platforms, for a process that is gone
/// or has exited, and for one this process may not query.
#[napi(js_name = "processCreationTime")]
pub fn process_creation_time(pid: u32) -> Option<String> {
	creation_time(pid).map(|ticks| ticks.to_string())
}

#[cfg(windows)]
fn creation_time(pid: u32) -> Option<u64> {
	use windows_sys::Win32::{
		Foundation::{CloseHandle, FILETIME, STILL_ACTIVE},
		System::Threading::{
			GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
		},
	};
	// Process id 0 is the idle process, which OpenProcess refuses; it never holds anything.
	if pid == 0 {
		return None;
	}
	let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
	if handle.is_null() {
		return None;
	}
	let empty = || FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
	let (mut created, mut exited, mut kernel, mut user) = (empty(), empty(), empty(), empty());
	let mut code = 0u32;
	let read =
		unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) } != 0;
	// A process that has exited keeps its id while a handle to it is open, yet holds nothing any more.
	let running =
		unsafe { GetExitCodeProcess(handle, &mut code) } != 0 && code == STILL_ACTIVE as u32;
	unsafe { CloseHandle(handle) };
	let ticks = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
	(read && running && ticks != 0).then_some(ticks)
}

#[cfg(not(windows))]
fn creation_time(_pid: u32) -> Option<u64> {
	None
}

#[cfg(test)]
mod tests {
	use super::process_creation_time;

	#[cfg(windows)]
	#[test]
	fn reads_this_process_and_nothing_for_a_missing_one() {
		let own = process_creation_time(std::process::id()).expect("this process's creation time");
		assert!(own.parse::<u64>().unwrap() > 0);
		assert_eq!(process_creation_time(std::process::id()), Some(own));
		// Windows process ids are multiples of four: this one is never assigned.
		assert_eq!(process_creation_time(4_294_967_293), None);
		assert_eq!(process_creation_time(0), None);
	}

	#[cfg(not(windows))]
	#[test]
	fn reads_nothing_off_windows() {
		assert_eq!(process_creation_time(std::process::id()), None);
	}
}
