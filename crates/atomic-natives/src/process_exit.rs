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
		(status >= 0).then(|| info.InheritedFromUniqueProcessId as u32)
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
}
