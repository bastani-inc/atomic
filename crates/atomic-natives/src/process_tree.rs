//! Ends the processes a running child process started, on Windows, through handles: never by a process id that another
//! process may have been given meanwhile. A tree is read from the system's process table, but each process in it is
//! taken only once it is open, and only when the opened process's own parent id is its parent's and it was started
//! after that parent. An open process keeps its id, so the walk stands on processes it holds. Which process started
//! first is the kernel's own count of process starts (the process sequence number), which no clock change moves;
//! where it cannot be read, that process is not taken.
use napi_derive::napi;

/// Ends the processes that running process `pid` started, and those they started, each through a handle; returns how
/// many it ended. Not `pid` itself, and nothing once `pid` has exited, checked again right before the first of them is
/// ended. The caller must hold `pid`'s own handle (a child it has not reaped), so that `pid` names that process. A
/// process whose parent ended before the call is not found. Nothing off Windows, nor where Windows does not give the
/// order in which processes started.
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
	/// Where the opened process's start falls in the order of all process starts since boot.
	pub(crate) started: u64,
}

/// The processes below `root` (whose start is `root_started` in the order of process starts), from `table`
/// (`(pid, parent pid)` as the system listed them), each opened with `open` and kept only when it is the process the
/// table named as a child: its own parent id is its parent's and it started after that parent. The handles of the
/// rejected ones are dropped.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn walk<H>(
	root: u32,
	root_started: u64,
	table: &[(u32, u32)],
	mut open: impl FnMut(u32) -> Option<Opened<H>>,
) -> Vec<H> {
	let mut children: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
	for &(pid, listed_parent) in table {
		if pid != listed_parent {
			children.entry(listed_parent).or_default().push(pid);
		}
	}
	let mut kept = Vec::new();
	let mut seen = std::collections::HashSet::from([root]);
	let mut parents = vec![(root, root_started)];
	while let Some((parent, parent_started)) = parents.pop() {
		for &pid in children.get(&parent).map(Vec::as_slice).unwrap_or_default() {
			if seen.contains(&pid) {
				continue;
			}
			let Some(opened) = open(pid) else { continue };
			if opened.parent != parent || opened.started <= parent_started {
				continue;
			}
			seen.insert(pid);
			parents.push((pid, opened.started));
			kept.push(opened.handle);
		}
	}
	kept
}

/// The `ProcessSequenceNumber` of a `PROCESS_TELEMETRY_ID_INFORMATION` that Windows wrote `written` bytes of into
/// `buffer`: only when both those bytes and the structure's own `HeaderSize` reach past the field, so that a shorter
/// structure of another Windows version never has part of what follows it taken for the number.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn sequence_number(buffer: &[u64], written: u32) -> Option<u64> {
	/// The field's offset in the structure, in 8-byte words, and where it ends, in bytes.
	const WORD: usize = 5;
	const END: u32 = 48;
	// `HeaderSize` is the structure's first 4 bytes, little-endian.
	let header_size = (*buffer.first()? & 0xffff_ffff) as u32;
	let sequence = *buffer.get(WORD)?;
	(written >= END && header_size >= END && sequence != 0).then_some(sequence)
}

#[cfg(windows)]
mod windows {
	use super::{Opened, sequence_number, walk};
	use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
	use windows_sys::Wdk::System::Threading::{
		NtQueryInformationProcess, ProcessBasicInformation, ProcessTelemetryIdInformation,
	};
	use windows_sys::Win32::Foundation::{INVALID_HANDLE_VALUE, WAIT_TIMEOUT};
	use windows_sys::Win32::System::Diagnostics::ToolHelp::{
		CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
		TH32CS_SNAPPROCESS,
	};
	use windows_sys::Win32::System::Threading::{
		OpenProcess, PROCESS_BASIC_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
		PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, TerminateProcess, WaitForSingleObject,
	};

	pub(super) fn terminate_descendants(root: u32) -> u32 {
		let Some(root_process) = open(root, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE)
		else {
			return 0;
		};
		let Some(root_started) = started(&root_process) else { return 0 };
		if !running(&root_process) {
			return 0;
		}
		let table = process_table();
		let kept = walk(root, root_started, &table, |pid| {
			let process = open(pid, PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION)?;
			Some(Opened { parent: parent_of(&process)?, started: started(&process)?, handle: process })
		});
		// A command that ended meanwhile leaves what it started running, as one that ended before.
		if !running(&root_process) {
			return 0;
		}
		let mut ended = 0;
		for process in &kept {
			if unsafe { TerminateProcess(process.as_raw_handle(), 1) } != 0 {
				ended += 1;
			}
		}
		ended
	}

	fn running(process: &OwnedHandle) -> bool {
		unsafe { WaitForSingleObject(process.as_raw_handle(), 0) == WAIT_TIMEOUT }
	}

	fn open(pid: u32, access: u32) -> Option<OwnedHandle> {
		if pid == 0 {
			return None;
		}
		let handle = unsafe { OpenProcess(access, 0, pid) };
		(!handle.is_null()).then(|| unsafe { OwnedHandle::from_raw_handle(handle) })
	}

	/// The process's `ProcessSequenceNumber` from `ProcessTelemetryIdInformation` (Windows 10 and later): its place in
	/// the order of all process starts since boot, which the kernel counts up at each start. The structure's fixed part
	/// is followed by strings of the process (its command line among them), so the buffer grows to what it needs.
	fn started(process: &OwnedHandle) -> Option<u64> {
		let mut words = 512usize;
		for _ in 0..4 {
			let mut buffer = vec![0u64; words];
			let mut needed = 0u32;
			let status = unsafe {
				NtQueryInformationProcess(
					process.as_raw_handle(),
					ProcessTelemetryIdInformation,
					buffer.as_mut_ptr().cast(),
					(words * 8) as u32,
					&mut needed,
				)
			};
			if status >= 0 {
				return sequence_number(&buffer, needed);
			}
			let needed_words = (needed as usize).div_ceil(8);
			if needed_words <= words {
				return None;
			}
			words = needed_words;
		}
		None
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

	/// A system whose processes are `(pid, own parent, place in the order of starts)`; the table may list stale
	/// parents.
	fn system(processes: &[(u32, u32, u64)]) -> HashMap<u32, (u32, u64)> {
		processes.iter().map(|&(pid, parent, started)| (pid, (parent, started))).collect()
	}

	fn kept(
		root: u32,
		root_started: u64,
		table: &[(u32, u32)],
		live: &HashMap<u32, (u32, u64)>,
	) -> Vec<u32> {
		let mut found = walk(root, root_started, table, |pid| {
			live.get(&pid).map(|&(parent, started)| Opened { handle: pid, parent, started })
		});
		found.sort_unstable();
		found
	}

	#[cfg(windows)]
	#[test]
	fn ends_a_ping_that_a_running_cmd_started() {
		// The ping runs 30 seconds at most if nothing ends it.
		let mut cmd = std::process::Command::new("cmd.exe")
			.args(["/d", "/c", "ping -n 30 127.0.0.1 > nul"])
			.spawn()
			.expect("cmd.exe starts");
		let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
		let mut ended = 0;
		while ended == 0 && std::time::Instant::now() < deadline {
			std::thread::sleep(std::time::Duration::from_millis(100));
			ended = super::terminate_process_descendants(cmd.id());
		}
		let _ = cmd.kill();
		let _ = cmd.wait();
		// The ping, and a console host cmd.exe may have started.
		assert!(ended >= 1, "nothing cmd.exe started was ended");
	}

	#[test]
	fn reads_the_sequence_number_only_where_the_structure_reaches_it() {
		let mut structure = [0u64; 12];
		structure[0] = 96;
		structure[5] = 103;
		assert_eq!(super::sequence_number(&structure, 196), Some(103));
		// A header that ends before the field: what is there belongs to what follows the header.
		structure[0] = 40;
		assert_eq!(super::sequence_number(&structure, 196), None);
		structure[0] = 96;
		assert_eq!(super::sequence_number(&structure, 40), None);
		structure[5] = 0;
		assert_eq!(super::sequence_number(&structure, 196), None);
		assert_eq!(super::sequence_number(&[96], 196), None);
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
	fn takes_only_a_process_that_started_after_its_parent() {
		// The walk compares places in the order of starts, never times: a process that did not start after the root is
		// not its child, whatever its listed parent id.
		let live = system(&[(20, 10, 100), (30, 10, 101), (40, 10, 99)]);
		assert_eq!(kept(10, 100, &[(20, 10), (30, 10), (40, 10)], &live), vec![30]);
	}

	#[test]
	fn leaves_what_it_cannot_open_and_does_not_loop() {
		let live = system(&[(20, 10, 200), (10, 20, 300)]);
		assert_eq!(kept(10, 100, &[(20, 10), (10, 20), (30, 10)], &live), vec![20]);
	}
}
