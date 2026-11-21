//! Ends the processes a running child process started, on Windows, through handles: never by a process id that another
//! process may have been given meanwhile. A tree is read from the system's process table, but each process in it is
//! taken only once it is open, and only when the opened process's own parent id is its parent's and it was created no
//! earlier than that parent. An open process keeps its id, so the walk stands on processes it holds.
use napi_derive::napi;

/// Ends the processes that running process `pid` started, and those they started, each through a handle; returns how
/// many it ended. Not `pid` itself. The caller must hold `pid`'s own handle (a child it has not reaped), so that `pid`
/// names that process. A process whose parent ended before the call is not found. Nothing off Windows.
#[napi(js_name = "terminateProcessDescendants")]
pub fn terminate_process_descendants(pid: u32) -> u32 {
	#[cfg(windows)]
	{
		windows::terminate_descendants(pid)
	}
	#[cfg(not(windows))]
	{
		let _ = pid;
		0
	}
}

/// What the walk needs of an open process.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) struct Opened<H> {
	pub(crate) handle: H,
	/// The opened process's own parent id.
	pub(crate) parent: u32,
	/// When the opened process was created, in the system's 100 ns ticks.
	pub(crate) created: u64,
}

/// The processes below `root` (created at `root_created`), from `table` (`(pid, parent pid)` as the system listed
/// them), each opened with `open` and kept only when it is the process the table named as a child: its own parent id
/// is its parent's and it was created no earlier than that parent. The handles of the rejected ones are dropped.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn walk<H>(
	root: u32,
	root_created: u64,
	table: &[(u32, u32)],
	mut open: impl FnMut(u32) -> Option<Opened<H>>,
) -> Vec<H> {
	let mut kept = Vec::new();
	let mut seen = std::collections::HashSet::from([root]);
	let mut parents = vec![(root, root_created)];
	while let Some((parent, parent_created)) = parents.pop() {
		for &(pid, listed_parent) in table {
			if listed_parent != parent || pid == parent || seen.contains(&pid) {
				continue;
			}
			let Some(opened) = open(pid) else { continue };
			if opened.parent != parent || opened.created < parent_created {
				continue;
			}
			seen.insert(pid);
			parents.push((pid, opened.created));
			kept.push(opened.handle);
		}
	}
	kept
}

#[cfg(windows)]
mod windows {
	use super::{Opened, walk};
	use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
	use windows_sys::Wdk::System::Threading::{NtQueryInformationProcess, ProcessBasicInformation};
	use windows_sys::Win32::Foundation::{FILETIME, INVALID_HANDLE_VALUE};
	use windows_sys::Win32::System::Diagnostics::ToolHelp::{
		CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
		TH32CS_SNAPPROCESS,
	};
	use windows_sys::Win32::System::Threading::{
		GetProcessTimes, OpenProcess, PROCESS_BASIC_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
		PROCESS_TERMINATE, TerminateProcess,
	};

	pub(super) fn terminate_descendants(root: u32) -> u32 {
		let Some(root_process) = open(root, PROCESS_QUERY_LIMITED_INFORMATION) else { return 0 };
		let Some(root_created) = created(&root_process) else { return 0 };
		let table = process_table();
		let kept = walk(root, root_created, &table, |pid| {
			let process = open(pid, PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION)?;
			Some(Opened { parent: parent_of(&process)?, created: created(&process)?, handle: process })
		});
		let mut ended = 0;
		for process in &kept {
			if unsafe { TerminateProcess(process.as_raw_handle(), 1) } != 0 {
				ended += 1;
			}
		}
		ended
	}

	fn open(pid: u32, access: u32) -> Option<OwnedHandle> {
		if pid == 0 {
			return None;
		}
		let handle = unsafe { OpenProcess(access, 0, pid) };
		(!handle.is_null()).then(|| unsafe { OwnedHandle::from_raw_handle(handle) })
	}

	fn created(process: &OwnedHandle) -> Option<u64> {
		let empty = || FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
		let (mut created, mut exited, mut kernel, mut user) = (empty(), empty(), empty(), empty());
		let read = unsafe {
			GetProcessTimes(process.as_raw_handle(), &mut created, &mut exited, &mut kernel, &mut user)
		} != 0;
		let ticks = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
		(read && ticks != 0).then_some(ticks)
	}

	fn parent_of(process: &OwnedHandle) -> Option<u32> {
		let mut information: PROCESS_BASIC_INFORMATION = unsafe { std::mem::zeroed() };
		let status = unsafe {
			NtQueryInformationProcess(
				process.as_raw_handle(),
				ProcessBasicInformation,
				(&mut information as *mut PROCESS_BASIC_INFORMATION).cast(),
				std::mem::size_of::<PROCESS_BASIC_INFORMATION>() as u32,
				std::ptr::null_mut(),
			)
		};
		(status >= 0).then(|| information.InheritedFromUniqueProcessId as u32)
	}

	fn process_table() -> Vec<(u32, u32)> {
		let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
		if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
			return Vec::new();
		}
		let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
		let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
		entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
		let mut table = Vec::new();
		let mut more = unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) } != 0;
		while more {
			table.push((entry.th32ProcessID, entry.th32ParentProcessID));
			more = unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) } != 0;
		}
		table
	}
}

#[cfg(test)]
mod tests {
	use super::{Opened, walk};
	use std::collections::HashMap;

	/// A system whose processes are `(pid, own parent, created)`; the table may list stale parents.
	fn system(processes: &[(u32, u32, u64)]) -> HashMap<u32, (u32, u64)> {
		processes.iter().map(|&(pid, parent, created)| (pid, (parent, created))).collect()
	}

	fn kept(
		root: u32,
		root_created: u64,
		table: &[(u32, u32)],
		live: &HashMap<u32, (u32, u64)>,
	) -> Vec<u32> {
		let mut found = walk(root, root_created, table, |pid| {
			live.get(&pid).map(|&(parent, created)| Opened { handle: pid, parent, created })
		});
		found.sort_unstable();
		found
	}

	#[test]
	fn takes_children_and_grandchildren() {
		let live = system(&[(20, 10, 200), (30, 20, 300), (40, 10, 250)]);
		assert_eq!(kept(10, 100, &[(20, 10), (30, 20), (40, 10)], &live), vec![20, 30, 40]);
	}

	#[test]
	fn leaves_an_older_process_whose_listed_parent_id_is_the_roots() {
		// Process 50 was started by an earlier process that had id 10; the root got that id later.
		let live = system(&[(50, 10, 50), (20, 10, 200)]);
		assert_eq!(kept(10, 100, &[(50, 10), (20, 10)], &live), vec![20]);
	}

	#[test]
	fn leaves_a_process_that_took_a_listed_childs_id_after_the_table_was_read() {
		// The table listed 20 under the root; 20 then ended and its id went to an unrelated, newer process.
		let live = system(&[(20, 77, 500)]);
		assert_eq!(kept(10, 100, &[(20, 10)], &live), Vec::<u32>::new());
	}

	#[test]
	fn leaves_what_it_cannot_open_and_does_not_loop() {
		let live = system(&[(20, 10, 200), (10, 20, 300)]);
		assert_eq!(kept(10, 100, &[(20, 10), (10, 20), (30, 10)], &live), vec![20]);
	}
}
