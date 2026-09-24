use std::io;

use napi::{Error, Result};
use napi_derive::napi;
use windows_sys::Win32::{
	Foundation::{
		CloseHandle, ERROR_INVALID_PARAMETER, FILETIME, GetLastError, HANDLE, WAIT_OBJECT_0,
		WAIT_TIMEOUT,
	},
	Storage::FileSystem::SYNCHRONIZE,
	System::Threading::{
		GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
		WaitForSingleObject,
	},
};

#[napi]
pub struct WindowsPostgresProcessGuard {
	handle: Option<HANDLE>,
	status: String,
}

// The handle is owned by this guard and only used through its N-API methods;
// Windows process handles may be queried and closed from any thread.
unsafe impl Send for WindowsPostgresProcessGuard {}

#[napi]
impl WindowsPostgresProcessGuard {
	#[napi(getter)]
	pub fn status(&self) -> String {
		self.status.clone()
	}

	#[napi]
	pub fn exited(&self) -> Result<bool> {
		let handle =
			self.handle.ok_or_else(|| Error::from_reason("Postgres process guard is closed"))?;
		let mut exit_code = 0;
		if unsafe { GetExitCodeProcess(handle, &mut exit_code) } == 0 {
			return Err(last_error("Could not query guarded PostgreSQL process"));
		}
		let wait = unsafe { WaitForSingleObject(handle, 0) };
		match wait {
			WAIT_OBJECT_0 => Ok(true),
			WAIT_TIMEOUT => Ok(false),
			_ => Err(last_error("Could not wait for guarded PostgreSQL process")),
		}
	}

	#[napi]
	pub fn close(&mut self) {
		if let Some(handle) = self.handle.take() {
			unsafe { CloseHandle(handle) };
		}
	}
}

impl Drop for WindowsPostgresProcessGuard {
	fn drop(&mut self) {
		self.close();
	}
}

fn last_error(message: &str) -> Error {
	Error::from_reason(format!("{message}: {}", io::Error::last_os_error()))
}

/// Keep the opened process object alive across pg_ctl's PID-only signal. An open
/// process handle prevents Windows from recycling its PID, even after exit.
#[napi(js_name = "guardWindowsPostgresProcess")]
pub fn guard_windows_postgres_process(
	pid: u32,
	expected_start_time: f64,
) -> Result<WindowsPostgresProcessGuard> {
	let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid) };
	if handle.is_null() {
		if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER {
			return Ok(WindowsPostgresProcessGuard { handle: None, status: "absent".into() });
		}
		return Err(last_error("Could not open PostgreSQL process"));
	}
	let mut guard = WindowsPostgresProcessGuard { handle: Some(handle), status: "mismatch".into() };
	let mut created = FILETIME::default();
	let mut exited = FILETIME::default();
	let mut kernel = FILETIME::default();
	let mut user = FILETIME::default();
	if unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) } == 0 {
		return Err(last_error("Could not query PostgreSQL process creation time"));
	}
	let ticks = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
	let started = ticks / 10_000_000;
	let started = started.saturating_sub(11_644_473_600) as f64;
	if expected_start_time.is_finite()
		&& expected_start_time > 0.0
		&& started > 0.0
		&& started == expected_start_time
	{
		if guard.exited()? {
			guard.close();
			guard.status = "absent".into();
		} else {
			guard.status = "live".into();
		}
	} else {
		guard.close();
	}
	Ok(guard)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn guards_current_process_and_rejects_missing_pid() {
		let started = crate::postgres_process_start_time(std::process::id()).start_time.unwrap();
		let mut guard = guard_windows_postgres_process(std::process::id(), started).unwrap();
		assert_eq!(guard.status(), "live");
		assert!(!guard.exited().unwrap());
		guard.close();
		assert_eq!(
			guard_windows_postgres_process(std::process::id(), started - 1.0).unwrap().status(),
			"mismatch"
		);
		assert_eq!(guard_windows_postgres_process(u32::MAX, started).unwrap().status(), "absent");
	}
}
