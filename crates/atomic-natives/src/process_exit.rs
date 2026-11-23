//! Holds a creation-time-verified Windows process handle from spawn so `waitForChildProcess` can read the child's
//! real 32-bit exit code from the kernel (`GetExitCodeProcess`) instead of ever guessing `0` when libuv's `exit`
//! event is delayed or lost.
//!
//! Holding an open handle pins the kernel process object until `close()` (or drop), preventing PID reuse while the
//! wait is active. `WaitForSingleObject(handle, 0) == WAIT_OBJECT_0` detects termination independently of the exit
//! code, so even a child that exits with `259` (`STILL_ACTIVE`) is reported accurately.
use napi_derive::napi;

/// Result of polling a held Windows child process handle.
#[napi(object)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WindowsProcessExitStatus {
	/// True once the kernel has signaled process termination (`WAIT_OBJECT_0`).
	pub exited: bool,
	/// The child's exact 32-bit exit status from `GetExitCodeProcess`, or `None` when still running or unknowable.
	pub exit_code: Option<u32>,
	/// True when the exit status could not be determined (e.g. handle closed, `GetExitCodeProcess` failed, or
	/// creation-time verification failed). Callers must treat this as an unknown exit status, never `0`.
	pub unknown: bool,
}

/// A creation-time- and parent-verified Windows handle to a child process, held until `close()` or drop.
#[napi]
pub struct WindowsProcessExitHandle {
	#[cfg(windows)]
	handle: Option<std::os::windows::io::OwnedHandle>,
	created: u64,
}

#[napi]
impl WindowsProcessExitHandle {
	/// The child's creation time verified when the handle was acquired (decimal 100-ns ticks since 1601-01-01 UTC).
	#[napi(getter, js_name = "creationTime")]
	pub fn creation_time(&self) -> String {
		self.created.to_string()
	}

	/// Non-blocking poll of the held handle.
	///
	/// Returns `{ exited: false, exitCode: undefined, unknown: false }` while the child still runs.
	/// Once signaled (`WAIT_OBJECT_0`), re-verifies the handle's creation time and reads `GetExitCodeProcess`.
	/// If reading or verification fails, returns `{ exited: true, exitCode: undefined, unknown: true }`.
	#[napi(js_name = "pollExit")]
	pub fn poll_exit(&self) -> WindowsProcessExitStatus {
		#[cfg(windows)]
		{
			windows::poll_handle(self.handle.as_ref(), self.created)
		}
		#[cfg(not(windows))]
		{
			WindowsProcessExitStatus { exited: false, exit_code: None, unknown: true }
		}
	}

	/// Closes the underlying OS process handle immediately (idempotent).
	#[napi]
	pub fn close(&mut self) {
		#[cfg(windows)]
		{
			self.handle = None;
		}
	}
}

/// Opens and holds a verified handle to direct child process `pid` on Windows (`PROCESS_QUERY_LIMITED_INFORMATION |
/// PROCESS_SYNCHRONIZE`).
///
/// Verification requires:
/// - `pid != 0` and `OpenProcess` succeeds,
/// - `GetProcessTimes` yields a non-zero creation time (matching `expected_created` if supplied),
/// - `ProcessBasicInformation.InheritedFromUniqueProcessId` equals this process's PID, and
/// - when `ProcessTelemetryIdInformation` is available on both processes, the child's `ProcessSequenceNumber` is
///   strictly greater than this process's.
///
/// Returns `null` off Windows, when the handle cannot be opened, or when any verification check fails.
#[napi(js_name = "holdWindowsProcessExit")]
pub fn hold_windows_process_exit(
	pid: u32,
	expected_created: Option<String>,
) -> Option<WindowsProcessExitHandle> {
	#[cfg(windows)]
	{
		let expected = match expected_created {
			Some(text) => Some(text.parse::<u64>().ok().filter(|&ticks| ticks != 0)?),
			None => None,
		};
		let (handle, created) = windows::open_verified_child(pid, expected)?;
		Some(WindowsProcessExitHandle { handle: Some(handle), created })
	}
	#[cfg(not(windows))]
	{
		let _ = (pid, expected_created);
		None
	}
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
pub(crate) enum WaitPoll {
	Running,
	Signaled,
	Failed,
}

/// Pure status classifier matching the verified exit-status contract: `exit_code: Some(0)` is only ever produced
/// when `wait == WaitPoll::Signaled`, `created_matches == true`, and `read_code == Some(0)`.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
pub(crate) fn classify_poll(
	wait: WaitPoll,
	created_matches: bool,
	read_code: Option<u32>,
) -> WindowsProcessExitStatus {
	match wait {
		WaitPoll::Running => {
			WindowsProcessExitStatus { exited: false, exit_code: None, unknown: false }
		},
		WaitPoll::Failed => {
			WindowsProcessExitStatus { exited: false, exit_code: None, unknown: true }
		},
		WaitPoll::Signaled => {
			if created_matches && let Some(code) = read_code {
				WindowsProcessExitStatus { exited: true, exit_code: Some(code), unknown: false }
			} else {
				WindowsProcessExitStatus { exited: true, exit_code: None, unknown: true }
			}
		},
	}
}

#[cfg(windows)]
mod windows {
	use super::{WaitPoll, WindowsProcessExitStatus, classify_poll};
	use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
	use windows_sys::Wdk::System::Threading::{
		NtQueryInformationProcess, ProcessBasicInformation, ProcessTelemetryIdInformation,
	};
	use windows_sys::Win32::Foundation::{FILETIME, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
	use windows_sys::Win32::System::Threading::{
		GetCurrentProcess, GetExitCodeProcess, GetProcessTimes, OpenProcess,
		PROCESS_BASIC_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
		WaitForSingleObject,
	};

	fn creation_time_of(handle: HANDLE) -> Option<u64> {
		let empty = || FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
		let (mut created, mut exited, mut kernel, mut user) = (empty(), empty(), empty(), empty());
		if unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) } == 0
		{
			return None;
		}
		let ticks = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
		(ticks != 0).then_some(ticks)
	}

	fn parent_of(handle: HANDLE) -> Option<u32> {
		let mut info: PROCESS_BASIC_INFORMATION = unsafe { std::mem::zeroed() };
		let status = unsafe {
			NtQueryInformationProcess(
				handle,
				ProcessBasicInformation,
				(&mut info as *mut PROCESS_BASIC_INFORMATION).cast(),
				std::mem::size_of::<PROCESS_BASIC_INFORMATION>() as u32,
				std::ptr::null_mut(),
			)
		};
		(status >= 0).then_some(info.InheritedFromUniqueProcessId as u32)
	}

	fn sequence_of(handle: HANDLE) -> Option<u64> {
		let mut words = 512usize;
		for _ in 0..4 {
			let mut buffer = vec![0u64; words];
			let mut needed = 0u32;
			let status = unsafe {
				NtQueryInformationProcess(
					handle,
					ProcessTelemetryIdInformation,
					buffer.as_mut_ptr().cast(),
					(words * 8) as u32,
					&mut needed,
				)
			};
			if status >= 0 {
				return crate::process_tree::sequence_number(&buffer, needed);
			}
			let needed_words = (needed as usize).div_ceil(8);
			if needed_words <= words {
				return None;
			}
			words = needed_words;
		}
		None
	}

	pub(super) fn open_verified_child(
		pid: u32,
		expected_created: Option<u64>,
	) -> Option<(OwnedHandle, u64)> {
		if pid == 0 {
			return None;
		}
		let raw =
			unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid) };
		if raw.is_null() {
			return None;
		}
		// SAFETY: `raw` is a valid process handle just opened by `OpenProcess`.
		let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
		let created = creation_time_of(handle.as_raw_handle())?;
		if let Some(expected) = expected_created
			&& created != expected
		{
			return None;
		}
		if parent_of(handle.as_raw_handle())? != std::process::id() {
			return None;
		}
		if let (Some(self_seq), Some(child_seq)) =
			(sequence_of(unsafe { GetCurrentProcess() }), sequence_of(handle.as_raw_handle()))
			&& child_seq <= self_seq
		{
			return None;
		}
		Some((handle, created))
	}

	pub(super) fn poll_handle(
		handle: Option<&OwnedHandle>,
		expected_created: u64,
	) -> WindowsProcessExitStatus {
		let Some(handle) = handle else {
			return WindowsProcessExitStatus { exited: false, exit_code: None, unknown: true };
		};
		let raw = handle.as_raw_handle();
		let wait = match unsafe { WaitForSingleObject(raw, 0) } {
			WAIT_TIMEOUT => WaitPoll::Running,
			WAIT_OBJECT_0 => WaitPoll::Signaled,
			_ => WaitPoll::Failed,
		};
		if wait != WaitPoll::Signaled {
			return classify_poll(wait, true, None);
		}
		let created_matches = creation_time_of(raw) == Some(expected_created);
		let mut code = 0u32;
		let read_code = (unsafe { GetExitCodeProcess(raw, &mut code) } != 0).then_some(code);
		classify_poll(WaitPoll::Signaled, created_matches, read_code)
	}
}

#[cfg(test)]
mod tests {
	use super::{WaitPoll, WindowsProcessExitStatus, classify_poll, hold_windows_process_exit};

	#[test]
	fn classifier_preserves_zero_non_zero_and_still_active_and_never_fabricates_zero() {
		assert_eq!(
			classify_poll(WaitPoll::Running, true, None),
			WindowsProcessExitStatus { exited: false, exit_code: None, unknown: false }
		);
		assert_eq!(
			classify_poll(WaitPoll::Signaled, true, Some(0)),
			WindowsProcessExitStatus { exited: true, exit_code: Some(0), unknown: false }
		);
		assert_eq!(
			classify_poll(WaitPoll::Signaled, true, Some(2)),
			WindowsProcessExitStatus { exited: true, exit_code: Some(2), unknown: false }
		);
		// 259 == Windows STILL_ACTIVE: WaitForSingleObject signaled proves exit.
		assert_eq!(
			classify_poll(WaitPoll::Signaled, true, Some(259)),
			WindowsProcessExitStatus { exited: true, exit_code: Some(259), unknown: false }
		);
		assert_eq!(
			classify_poll(WaitPoll::Signaled, true, None),
			WindowsProcessExitStatus { exited: true, exit_code: None, unknown: true }
		);
		assert_eq!(
			classify_poll(WaitPoll::Signaled, false, Some(0)),
			WindowsProcessExitStatus { exited: true, exit_code: None, unknown: true }
		);
		assert_eq!(
			classify_poll(WaitPoll::Failed, true, Some(0)),
			WindowsProcessExitStatus { exited: false, exit_code: None, unknown: true }
		);
	}

	#[cfg(not(windows))]
	#[test]
	fn returns_none_off_windows() {
		assert!(hold_windows_process_exit(std::process::id(), None).is_none());
	}

	#[cfg(windows)]
	#[test]
	fn holds_verified_child_and_reads_exact_exit_codes_including_zero_nonzero_and_259() {
		use std::{process::Command, thread::sleep, time::Duration};

		// Self, idle pid 0, and non-existent pid must all be rejected.
		assert!(hold_windows_process_exit(0, None).is_none());
		assert!(hold_windows_process_exit(std::process::id(), None).is_none());
		assert!(hold_windows_process_exit(4_294_967_293, None).is_none());

		for expected in [0u32, 1, 2, 259] {
			let mut child =
				Command::new("cmd").args(["/d", "/c", &format!("exit {expected}")]).spawn().unwrap();
			let pid = child.id();
			let mut held = hold_windows_process_exit(pid, None).expect("verified handle to child");
			let created = held.creation_time();
			assert!(created.parse::<u64>().unwrap() > 0);
			// Wrong creation time must be rejected.
			let wrong = (created.parse::<u64>().unwrap() + 1).to_string();
			assert!(hold_windows_process_exit(pid, Some(wrong)).is_none());
			// Matching creation time succeeds.
			let mut matched = hold_windows_process_exit(pid, Some(created)).expect("matching created");

			let status = child.wait().unwrap();
			assert_eq!(status.code(), Some(expected as i32));

			let mut polled = held.poll_exit();
			for _ in 0..100 {
				if polled.exited {
					break;
				}
				sleep(Duration::from_millis(5));
				polled = held.poll_exit();
			}
			assert_eq!(
				polled,
				WindowsProcessExitStatus { exited: true, exit_code: Some(expected), unknown: false }
			);
			assert_eq!(matched.poll_exit(), polled);

			held.close();
			matched.close();
			assert_eq!(
				held.poll_exit(),
				WindowsProcessExitStatus { exited: false, exit_code: None, unknown: true }
			);
		}
	}

	#[cfg(windows)]
	#[test]
	fn rejects_non_direct_child_grandchild_with_greater_sequence_number() {
		use std::{
			process::Command,
			time::{Duration, Instant},
		};

		// `cmd` starts `ping` as its own child, so `ping` is our grandchild:
		// `ProcessSequenceNumber(ping) > ProcessSequenceNumber(self)`, while
		// `InheritedFromUniqueProcessId(ping) == cmd.id() != self_pid`.
		let mut parent =
			Command::new("cmd").args(["/d", "/c", "ping -n 30 127.0.0.1 >nul"]).spawn().unwrap();
		let parent_pid = parent.id();
		let parent_created = crate::process_start::process_creation_time(parent_pid)
			.expect("direct child creation time");

		struct Cleanup {
			pid: u32,
			created: String,
		}
		impl Drop for Cleanup {
			fn drop(&mut self) {
				let _ = crate::process_start::terminate_process_created_at(
					self.pid,
					self.created.clone(),
					true,
				);
			}
		}
		let _guard = Cleanup { pid: parent_pid, created: parent_created };

		let deadline = Instant::now() + Duration::from_secs(10);
		let grandchild_pid = loop {
			let listed = crate::process_tree::process_table();
			if let Some(&(id, _)) = listed.iter().find(|&&(_, started_by)| started_by == parent_pid) {
				break id;
			}
			assert!(Instant::now() < deadline, "cmd never listed the ping grandchild");
			std::thread::yield_now();
		};

		// Positive controls: our direct child IS accepted, and the grandchild IS live and openable.
		let mut parent_held =
			hold_windows_process_exit(parent_pid, None).expect("direct child must be accepted");
		parent_held.close();
		let grandchild_created = crate::process_start::process_creation_time(grandchild_pid)
			.expect("grandchild must be live and queryable");

		// A grandchild has sequence > self_seq, so only the parent-PID check rejects it.
		assert!(
			hold_windows_process_exit(grandchild_pid, None).is_none(),
			"must reject a grandchild that is not our direct child"
		);
		assert!(
			hold_windows_process_exit(grandchild_pid, Some(grandchild_created)).is_none(),
			"must still reject a grandchild even when expected_created matches"
		);

		drop(_guard);
		let _ = parent.wait();
	}

	#[cfg(windows)]
	#[test]
	fn rejects_stale_creation_time_and_pins_exited_child_against_pid_reuse() {
		use std::{process::Command, thread::sleep, time::Duration};

		// Spawn child A (exit 2), record its creation time, let it finish, and release its handle.
		let mut child_a = Command::new("cmd").args(["/d", "/c", "exit 2"]).spawn().unwrap();
		let mut held_a = hold_windows_process_exit(child_a.id(), None).expect("hold child A");
		let created_a = held_a.creation_time();
		assert_eq!(child_a.wait().unwrap().code(), Some(2));
		held_a.close();

		// Wait until a brand-new direct child B has a strictly distinct creation time (Windows
		// FILETIME clock resolution is ~15.6 ms), simulating a later process after PID reuse.
		let mut child_b = loop {
			sleep(Duration::from_millis(20));
			let mut candidate = Command::new("cmd").args(["/d", "/c", "exit 0"]).spawn().unwrap();
			let mut held_b = hold_windows_process_exit(candidate.id(), None).expect("hold child B");
			let created_b = held_b.creation_time();
			if created_b != created_a {
				// Presenting child A's stale creation time against child B must be rejected.
				assert!(
					hold_windows_process_exit(candidate.id(), Some(created_a.clone())).is_none(),
					"stale creation time from an earlier process must be rejected"
				);
				let mut matched_b = hold_windows_process_exit(candidate.id(), Some(created_b))
					.expect("matching creation time on child B must succeed");
				assert_eq!(candidate.wait().unwrap().code(), Some(0));
				assert_eq!(
					matched_b.poll_exit(),
					WindowsProcessExitStatus { exited: true, exit_code: Some(0), unknown: false }
				);
				matched_b.close();
				held_b.close();
				break candidate;
			}
			let _ = candidate.wait();
			held_b.close();
		};
		let _ = child_b.wait();

		// Holding WindowsProcessExitHandle pins the terminated process object and its real exit
		// status even after std::process::Child drops its handle and new processes churn PIDs.
		let mut child_c = Command::new("cmd").args(["/d", "/c", "exit 7"]).spawn().unwrap();
		let mut held_c = hold_windows_process_exit(child_c.id(), None).expect("hold child C");
		assert_eq!(child_c.wait().unwrap().code(), Some(7));
		drop(child_c);

		for _ in 0..10 {
			let status = Command::new("cmd").args(["/d", "/c", "exit 0"]).status().unwrap();
			assert_eq!(status.code(), Some(0));
		}

		assert_eq!(
			held_c.poll_exit(),
			WindowsProcessExitStatus { exited: true, exit_code: Some(7), unknown: false }
		);
		held_c.close();
	}
}
