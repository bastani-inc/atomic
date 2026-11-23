//! Holds, and then ends, the processes a running child process started, on Windows, through handles: never by a process
//! id that another process may have been given meanwhile. A tree is read from the system's process table, but each process in it is
//! taken only once it is open, and only when the opened process's own parent id is its parent's and it was started
//! after that parent. An open process keeps its id, so the walk stands on processes it holds. Which process started
//! first is the kernel's own count of process starts (the process sequence number), which no clock change moves;
//! where it cannot be read, that process is not taken.
use napi_derive::napi;

/// A running process and the processes below it, each held through a handle of its own, as `holdProcessDescendants`
/// found them: while held, none of their ids can be given to another process.
#[napi]
pub struct HeldProcessDescendants {
	root: Option<Held>,
	held: Vec<Held>,
}

#[cfg(windows)]
type Held = std::os::windows::io::OwnedHandle;
#[cfg(not(windows))]
type Held = ();

#[napi]
impl HeldProcessDescendants {
	/// How many processes below it it holds.
	#[napi(getter)]
	pub fn count(&self) -> u32 {
		self.held.len() as u32
	}

	/// Ends the process they are below, and then them, only if it ended that process: one that exited by itself first
	/// leaves them running. Lets go of all of them; returns whether it ended that process.
	#[napi(js_name = "endAll")]
	pub fn end_all(&mut self) -> bool {
		let ended = match self.root.as_ref() {
			Some(root) => end_root_then_held(root, &self.held, end),
			None => false,
		};
		self.release();
		ended
	}

	/// Ends only the held descendants (leaving the root handle intact) and releases their handles.
	/// Used when the root is the current process itself so verified descendants end before the process exits.
	#[napi(js_name = "endDescendants")]
	pub fn end_descendants(&mut self) -> u32 {
		end_held_only(&mut self.held, end)
	}

	/// Lets go of the processes it holds without ending them.
	#[napi]
	pub fn release(&mut self) {
		self.root = None;
		self.held.clear();
	}
}

/// Ends `root` and then each of `held`, only if `end` ended `root`; returns whether it did. `end` fails for a process
/// that already exited, so a root that exited by itself leaves `held` running.
pub(crate) fn end_root_then_held<H>(root: &H, held: &[H], mut end: impl FnMut(&H) -> bool) -> bool {
	if !end(root) {
		return false;
	}
	for process in held {
		end(process);
	}
	true
}

/// Ends every handle in `held` and drains `held`; returns how many `end` succeeded on.
pub(crate) fn end_held_only<H>(held: &mut Vec<H>, mut end: impl FnMut(&H) -> bool) -> u32 {
	let mut ended = 0u32;
	for process in held.drain(..) {
		if end(&process) {
			ended += 1;
		}
	}
	ended
}

/// Ends `process` through its handle; fails for one that already exited or is exiting by itself.
#[cfg(windows)]
fn end(process: &Held) -> bool {
	use std::os::windows::io::AsRawHandle;
	use windows_sys::Win32::System::Threading::TerminateProcess;
	unsafe { TerminateProcess(process.as_raw_handle(), 1) != 0 }
}
#[cfg(not(windows))]
fn end(_process: &Held) -> bool {
	false
}

/// Holds running process `pid` and the processes it started, and those they started, each through a handle, so that
/// the caller can end `pid` and then them, only if it ended `pid` (`endAll`). `null` once `pid` has exited, off
/// Windows, and where Windows does not give the order in which processes started. The caller must hold `pid`'s own
/// handle (a child whose exit it has not seen), so that `pid` names that process. A process whose parent ended before
/// the call is not found.
#[napi(js_name = "holdProcessDescendants")]
pub fn hold_process_descendants(pid: u32) -> Option<HeldProcessDescendants> {
	#[cfg(windows)]
	{
		windows::hold_descendants(pid)
			.map(|(root, held)| HeldProcessDescendants { root: Some(root), held })
	}
	#[cfg(not(windows))]
	{
		let _ = pid;
		None
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
pub(crate) use windows::hold_below;
#[cfg(all(windows, test))]
pub(crate) use windows::process_table;

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
		GetProcessId, OpenProcess, PROCESS_BASIC_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
		PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, WaitForSingleObject,
	};

	pub(super) fn hold_descendants(root: u32) -> Option<(OwnedHandle, Vec<OwnedHandle>)> {
		let root_process =
			open(root, PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE)?;
		if !running(&root_process) {
			return None;
		}
		let held = hold_below(root, &root_process)?;
		Some((root_process, held))
	}

	/// The processes below process `root`, which `root_process` holds open with at least query rights, each held
	/// through a handle that can end it (see `walk`); `None` where Windows does not give `root`'s place in the order of
	/// process starts.
	pub(crate) fn hold_below(root: u32, root_process: &OwnedHandle) -> Option<Vec<OwnedHandle>> {
		let root_started = started(root_process)?;
		let table = process_table();
		Some(walk(root, root_started, &table, |pid| {
			let process = open(pid, PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION)?;
			Some(Opened { parent: parent_of(&process)?, started: started(&process)?, handle: process })
		}))
	}

	fn running(process: &OwnedHandle) -> bool {
		unsafe { WaitForSingleObject(process.as_raw_handle(), 0) == WAIT_TIMEOUT }
	}

	fn open(pid: u32, access: u32) -> Option<OwnedHandle> {
		if pid == 0 {
			return None;
		}
		let handle = unsafe { OpenProcess(access, 0, pid) };
		if handle.is_null() {
			return None;
		}
		// SAFETY: `handle` is a process handle this function just opened and owns.
		let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
		// Windows OpenProcess masks off the low 2 PID bits (EXHANDLE tag bits), so an unaligned
		// PID such as `real_pid | 1` opens `real_pid`. Reject handles whose kernel PID differs.
		if unsafe { GetProcessId(handle.as_raw_handle()) } != pid {
			return None;
		}
		Some(handle)
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
		(status >= 0).then_some(information.InheritedFromUniqueProcessId as u32)
	}

	/// Every process and the id of the process that started it, as Windows lists them.
	pub(crate) fn process_table() -> Vec<(u32, u32)> {
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
	fn ends_a_running_cmd_and_then_the_ping_it_started() {
		// The ping runs 30 seconds at most if nothing ends it.
		let mut cmd = std::process::Command::new("cmd.exe")
			.args(["/d", "/c", "ping -n 30 127.0.0.1 > nul"])
			.spawn()
			.expect("cmd.exe starts");
		let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
		let mut held = None;
		while held.is_none() && std::time::Instant::now() < deadline {
			std::thread::sleep(std::time::Duration::from_millis(100));
			held = super::hold_process_descendants(cmd.id()).filter(|held| held.count() > 0);
		}
		let mut held = held.expect("nothing cmd.exe started was held");
		assert!(held.end_all(), "cmd.exe was not ended");
		let status = cmd.wait().expect("cmd.exe exits");
		assert_eq!(status.code(), Some(1), "cmd.exe ended with its own status");
		assert_eq!(held.count(), 0, "it lets go once it ended them");
	}

	#[cfg(windows)]
	#[test]
	fn ends_nothing_below_a_process_that_exited_by_itself_while_held() {
		let nanos = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.map(|elapsed| elapsed.as_nanos())
			.unwrap_or_default();
		let dir =
			std::env::temp_dir().join(format!("atomic-process-tree-{}-{nanos}", std::process::id()));
		std::fs::create_dir(&dir).expect("a directory of the test's own");
		let (gate, finish, ready, ack) =
			(dir.join("gate"), dir.join("finish"), dir.join("ready"), dir.join("ack"));
		// What the root leaves running: it says it started, waits for the finish gate, says it still runs, and ends by
		// itself, or after a minute.
		let leftover = dir.join("leftover.ps1");
		std::fs::write(
			&leftover,
			"Set-Content -Path $env:LEFTOVER_READY -Value 'ready'\r\n\
			 $end = (Get-Date).AddSeconds(60)\r\n\
			 while (-not (Test-Path $env:FINISH_GATE) -and (Get-Date) -lt $end) { Start-Sleep -Milliseconds 50 }\r\n\
			 if (Test-Path $env:FINISH_GATE) { Set-Content -Path $env:LEFTOVER_ACK -Value 'alive' }\r\n",
		)
		.expect("the leftover's script");
		// The root starts it, then exits by itself once the gate exists, or after a minute.
		let root_script = dir.join("root.ps1");
		std::fs::write(
			&root_script,
			"Start-Process powershell.exe -WindowStyle Hidden -ArgumentList \
			 '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('\"' + $env:LEFTOVER_SCRIPT + '\"')\r\n\
			 $end = (Get-Date).AddSeconds(60)\r\n\
			 while (-not (Test-Path $env:ROOT_GATE) -and (Get-Date) -lt $end) { Start-Sleep -Milliseconds 50 }\r\n\
			 exit 0\r\n",
		)
		.expect("the root's script");
		let mut root = std::process::Command::new("powershell.exe")
			.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
			.arg(&root_script)
			.env("LEFTOVER_SCRIPT", &leftover)
			.env("ROOT_GATE", &gate)
			.env("FINISH_GATE", &finish)
			.env("LEFTOVER_READY", &ready)
			.env("LEFTOVER_ACK", &ack)
			.spawn()
			.expect("PowerShell starts");
		let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
		let mut held = None;
		// Held only once the leftover runs, so that the held processes include it.
		while held.is_none() && std::time::Instant::now() < deadline {
			std::thread::sleep(std::time::Duration::from_millis(100));
			if ready.exists() {
				held = super::hold_process_descendants(root.id()).filter(|held| held.count() > 0);
			}
		}
		let Some(mut held) = held else {
			std::fs::write(&gate, "").ok();
			std::fs::write(&finish, "").ok();
			panic!("nothing PowerShell started was held");
		};

		std::fs::write(&gate, "").expect("the root's gate opens");
		root.wait().expect("PowerShell exits by itself");
		let ended = held.end_all();
		std::fs::write(&finish, "").expect("the leftover's gate opens");
		let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
		while !ack.exists() && std::time::Instant::now() < deadline {
			std::thread::sleep(std::time::Duration::from_millis(50));
		}
		let left_running = ack.exists();
		let _ = std::fs::remove_dir_all(&dir);

		assert!(!ended, "a PowerShell that exited by itself was taken as ended");
		assert!(left_running, "what a process that exited by itself left running was ended");
	}

	#[cfg(windows)]
	#[test]
	fn holds_nothing_below_a_process_that_exited() {
		let mut cmd = std::process::Command::new("cmd.exe")
			.args(["/d", "/c", "exit 0"])
			.spawn()
			.expect("cmd.exe starts");
		cmd.wait().expect("cmd.exe exits");
		// `cmd` still holds the process's handle, so its id names that process, which has exited.
		assert!(super::hold_process_descendants(cmd.id()).is_none());
	}

	#[cfg(windows)]
	#[test]
	fn rejects_unaligned_pid_that_aliases_a_live_process() {
		let mut cmd = std::process::Command::new("cmd.exe")
			.args(["/d", "/c", "ping -n 30 127.0.0.1 > nul"])
			.spawn()
			.expect("cmd.exe starts");
		let pid = cmd.id();
		for offset in 1..=3 {
			assert!(
				super::hold_process_descendants(pid | offset).is_none(),
				"unaligned pid {} must not open live pid {pid}",
				pid | offset
			);
		}
		let mut held = super::hold_process_descendants(pid).expect("exact live pid is held");
		assert!(held.end_all());
		let _ = cmd.wait();
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
	fn ends_the_root_first_and_what_is_below_it_only_if_it_ended_it() {
		let ended = std::cell::RefCell::new(Vec::new());
		assert!(super::end_root_then_held(&1, &[2, 3], |process| {
			ended.borrow_mut().push(*process);
			true
		}));
		assert_eq!(*ended.borrow(), vec![1, 2, 3]);

		// A root that exited by itself: ending it fails, and what is below it keeps running.
		ended.borrow_mut().clear();
		assert!(!super::end_root_then_held(&1, &[2, 3], |process| {
			ended.borrow_mut().push(*process);
			*process != 1
		}));
		assert_eq!(*ended.borrow(), vec![1]);
	}

	#[test]
	fn ends_descendants_only_and_drains_held() {
		let mut held = vec![2, 3, 4];
		let mut ended = Vec::new();
		assert_eq!(
			super::end_held_only(&mut held, |process| {
				ended.push(*process);
				*process != 3
			}),
			2
		);
		assert_eq!(ended, vec![2, 3, 4]);
		assert!(held.is_empty());
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
