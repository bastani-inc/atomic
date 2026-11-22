//! When a process started, so a holder named by its process id is told apart from a later process given the same id
//! (#5141), and ending a process only while its id still names the process created then. Windows reuses process ids
//! quickly and has no `/proc` to read a start from.
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

/// Ends running process `pid` if it was created at `created`, as `processCreationTime` reads it, and with
/// `descendants` every process it started, directly or through others, that still runs. Each is ended through a handle
/// opened and checked before anything is ended, so a later process given one of their ids is never ended: the process
/// `pid` names must have been created at `created`, and a descendant must still be the child of the process that
/// started it, by its own parent id, and have started after it, by the kernel's order of process starts rather than by
/// a clock. Returns how many were ended, or `null` where `pid` does not name that process (it is gone, is another
/// process, or this process may not end it), and off Windows.
#[napi(js_name = "terminateProcessCreatedAt")]
pub fn terminate_process_created_at(pid: u32, created: String, descendants: bool) -> Option<u32> {
	terminate(pid, created.parse().ok()?, descendants)
}

/// A handle to running process `pid` that can end it, with when it was created.
#[cfg(windows)]
fn hold(pid: u32) -> Option<(std::os::windows::io::OwnedHandle, u64)> {
	use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
	use windows_sys::Win32::{
		Foundation::{FILETIME, STILL_ACTIVE},
		System::Threading::{
			GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
			PROCESS_TERMINATE,
		},
	};
	if pid == 0 {
		return None;
	}
	let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE, 0, pid) };
	if raw.is_null() {
		return None;
	}
	// SAFETY: `raw` is a process handle this function just opened and owns.
	let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
	let empty = || FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
	let (mut created, mut exited, mut kernel, mut user) = (empty(), empty(), empty(), empty());
	let mut code = 0u32;
	let read = unsafe {
		GetProcessTimes(handle.as_raw_handle(), &mut created, &mut exited, &mut kernel, &mut user)
	} != 0;
	let running = unsafe { GetExitCodeProcess(handle.as_raw_handle(), &mut code) } != 0
		&& code == STILL_ACTIVE as u32;
	let created = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
	(read && running && created != 0).then_some((handle, created))
}

#[cfg(windows)]
fn terminate(pid: u32, created: u64, descendants: bool) -> Option<u32> {
	use std::os::windows::io::AsRawHandle;
	use windows_sys::Win32::System::Threading::TerminateProcess;
	let (root, root_created) = hold(pid)?;
	if root_created != created {
		return None;
	}
	let below = if descendants {
		crate::process_tree::hold_below(pid, &root).unwrap_or_default()
	} else {
		Vec::new()
	};
	let ended = std::iter::once(&root)
		.chain(below.iter())
		.filter(|process| unsafe { TerminateProcess(process.as_raw_handle(), 1) } != 0)
		.count();
	Some(ended as u32)
}

#[cfg(not(windows))]
fn terminate(_pid: u32, _created: u64, _descendants: bool) -> Option<u32> {
	None
}

#[cfg(test)]
mod tests {
	use super::{process_creation_time, terminate_process_created_at};

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

	#[cfg(windows)]
	#[test]
	fn ends_a_process_its_starter_started_a_moment_ago() {
		use std::{process::Command, thread::sleep, time::Duration};
		// A child created within one tick of the system clock before the stop, a few times over.
		for _ in 0..5 {
			let mut parent =
				Command::new("cmd").args(["/d", "/c", "ping -n 60 127.0.0.1 >nul"]).spawn().unwrap();
			let pid = parent.id();
			let created = process_creation_time(pid).expect("the child's creation time");
			// Polled without a pause, so the stop follows the child's start by far less than a tick.
			let deadline = std::time::Instant::now() + Duration::from_secs(10);
			let child = loop {
				let listed = crate::process_tree::process_table();
				if let Some(&(id, _)) = listed.iter().find(|&&(_, started_by)| started_by == pid) {
					break id;
				}
				assert!(std::time::Instant::now() < deadline, "cmd never listed the ping it starts");
				std::thread::yield_now();
			};
			let ended = terminate_process_created_at(pid, created, true);
			assert!(ended.is_some_and(|count| count >= 2), "ended {ended:?}");
			parent.wait().unwrap();
			for _ in 0..200 {
				if process_creation_time(child).is_none() {
					break;
				}
				sleep(Duration::from_millis(10));
			}
			assert_eq!(
				process_creation_time(child),
				None,
				"the process it started a moment ago still runs"
			);
		}
	}

	#[cfg(windows)]
	#[test]
	fn ends_only_the_process_itself_without_its_descendants() {
		use std::{process::Command, thread::sleep, time::Duration};
		// cmd starts ping, which keeps both running for at most 30 seconds.
		let mut parent =
			Command::new("cmd").args(["/d", "/c", "ping -n 30 127.0.0.1 >nul"]).spawn().unwrap();
		let pid = parent.id();
		let created = process_creation_time(pid).expect("the child's creation time");
		let mut child = None;
		for _ in 0..500 {
			child = crate::process_tree::process_table()
				.into_iter()
				.find(|&(_, started_by)| started_by == pid)
				.map(|(id, _)| id)
				.and_then(|id| process_creation_time(id).map(|started| (id, started)));
			if child.is_some() {
				break;
			}
			sleep(Duration::from_millis(10));
		}
		let (child, child_created) = child.expect("the ping cmd started");

		let ended = terminate_process_created_at(pid, created, false);
		parent.wait().unwrap();
		// Still the same process: the one created when it was, not a later one given its id.
		let still_runs = process_creation_time(child).as_deref() == Some(child_created.as_str());
		terminate_process_created_at(child, child_created, false);

		assert_eq!(ended, Some(1), "ended more than the process itself");
		assert!(still_runs, "the process it started was ended without descendants asked for");
	}

	#[cfg(not(windows))]
	#[test]
	fn reads_nothing_off_windows() {
		assert_eq!(process_creation_time(std::process::id()), None);
		assert_eq!(terminate_process_created_at(std::process::id(), "1".into(), false), None);
	}

	#[cfg(windows)]
	#[test]
	fn ends_a_process_and_its_children_only_when_created_then() {
		use std::{process::Command, thread::sleep, time::Duration};
		// cmd starts ping, which keeps both running until they are ended.
		let mut parent =
			Command::new("cmd").args(["/d", "/c", "ping -n 60 127.0.0.1 >nul"]).spawn().unwrap();
		let pid = parent.id();
		let created = process_creation_time(pid).expect("the child's creation time");
		let mut child = None;
		for _ in 0..200 {
			child = crate::process_tree::process_table()
				.into_iter()
				.find(|&(_, started_by)| started_by == pid)
				.map(|(id, _)| id);
			if child.is_some() {
				break;
			}
			sleep(Duration::from_millis(10));
		}
		let child = child.expect("the ping cmd started");
		let other = (created.parse::<u64>().unwrap() + 1).to_string();
		assert_eq!(terminate_process_created_at(pid, other, true), None);
		assert!(process_creation_time(pid).is_some(), "ended under another creation time");

		// cmd and ping, and a console host where cmd had to create a console.
		let ended = terminate_process_created_at(pid, created, true);
		assert!(ended.is_some_and(|count| count >= 2), "ended {ended:?}");
		parent.wait().unwrap();
		for _ in 0..200 {
			if process_creation_time(child).is_none() {
				break;
			}
			sleep(Duration::from_millis(10));
		}
		assert_eq!(process_creation_time(child), None, "the process it started still runs");
	}
}
