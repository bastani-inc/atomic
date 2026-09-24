use sysinfo::{Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, System};

#[napi_derive::napi(object)]
pub struct PostgresProcessIdentity {
	pub found: bool,
	pub start_time: Option<f64>,
}

fn process_start_time(pid: u32) -> PostgresProcessIdentity {
	let pid = Pid::from_u32(pid);
	let mut system = System::new();
	system.refresh_processes_specifics(
		ProcessesToUpdate::Some(&[pid]),
		false,
		ProcessRefreshKind::nothing(),
	);
	match system
		.process(pid)
		.filter(|process| !matches!(process.status(), ProcessStatus::Zombie | ProcessStatus::Dead))
	{
		Some(process) => PostgresProcessIdentity {
			found: true,
			start_time: (process.start_time() != 0).then_some(process.start_time() as f64),
		},
		None => PostgresProcessIdentity { found: false, start_time: None },
	}
}

#[napi_derive::napi]
pub fn postgres_process_start_time(pid: u32) -> PostgresProcessIdentity {
	process_start_time(pid)
}

fn signal_verified_postgres_process(
	pid: u32,
	expected_start_time: f64,
	mode: &str,
) -> napi::Result<String> {
	if mode != "fast" && mode != "immediate" {
		return Err(napi::Error::from_reason("Invalid PostgreSQL shutdown mode"));
	}
	let pid = Pid::from_u32(pid);
	let mut system = System::new();
	system.refresh_processes_specifics(
		ProcessesToUpdate::Some(&[pid]),
		false,
		ProcessRefreshKind::nothing(),
	);
	let Some(process) = system
		.process(pid)
		.filter(|process| !matches!(process.status(), ProcessStatus::Zombie | ProcessStatus::Dead))
	else {
		return Ok("absent".into());
	};
	let started = process.start_time() as f64;
	if !expected_start_time.is_finite()
		|| expected_start_time <= 0.0
		|| started <= 0.0
		|| started != expected_start_time
	{
		return Ok("mismatch".into());
	}
	#[cfg(unix)]
	{
		let signal = if mode == "fast" { libc::SIGINT } else { libc::SIGQUIT };
		if unsafe { libc::kill(pid.as_u32() as libc::pid_t, signal) } != 0 {
			return signal_error(std::io::Error::last_os_error());
		}
	}
	Ok("signaled".into())
}

#[cfg(unix)]
fn signal_error(error: std::io::Error) -> napi::Result<String> {
	if error.raw_os_error() == Some(libc::ESRCH) {
		return Ok("absent".into());
	}
	Err(napi::Error::from_reason(format!("Could not signal verified PostgreSQL process: {error}")))
}
#[napi_derive::napi]
pub fn signal_verified_postgres(
	pid: u32,
	expected_start_time: f64,
	mode: String,
) -> napi::Result<String> {
	signal_verified_postgres_process(pid, expected_start_time, &mode)
}

#[cfg(test)]
mod process_start_time_tests {
	use super::process_start_time;

	#[test]
	fn current_process_has_plausible_start_time() {
		let identity = process_start_time(std::process::id());
		assert!(identity.found);
		let started = identity.start_time.unwrap();
		let now =
			std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
				as f64;
		assert!(started > 1_600_000_000.0 && started <= now);
	}

	#[test]
	fn missing_process_has_no_start_time() {
		let identity = process_start_time(u32::MAX);
		assert!(!identity.found);
		assert_eq!(identity.start_time, None);
	}
	#[cfg(unix)]
	#[test]
	fn creation_time_boundary_and_invalid_values() {
		use std::process::{Command, Stdio};
		let mut child = Command::new("sleep").arg("10").stdout(Stdio::null()).spawn().unwrap();
		let started = super::process_start_time(child.id()).start_time.unwrap();
		for expected in
			[started - 2.0, started - 1.0, started + 1.0, f64::NAN, f64::INFINITY, 0.0, -1.0]
		{
			assert_eq!(
				super::signal_verified_postgres_process(child.id(), expected, "fast").unwrap(),
				"mismatch"
			);
			assert!(child.try_wait().unwrap().is_none());
		}
		assert_eq!(
			super::signal_verified_postgres_process(child.id(), started, "fast").unwrap(),
			"signaled"
		);
		assert!(!child.wait().unwrap().success());
	}

	#[cfg(unix)]
	#[test]
	fn signal_mismatch_and_absence_do_not_interrupt_child() {
		use std::process::{Command, Stdio};
		let mut child = Command::new("sleep").arg("10").stdout(Stdio::null()).spawn().unwrap();
		let started = super::process_start_time(child.id()).start_time.unwrap();
		assert_eq!(
			super::signal_verified_postgres_process(child.id(), started - 2.0, "fast").unwrap(),
			"mismatch"
		);
		assert!(child.try_wait().unwrap().is_none());
		assert_eq!(
			super::signal_verified_postgres_process(u32::MAX, started, "fast").unwrap(),
			"absent"
		);
		assert!(child.try_wait().unwrap().is_none());
		child.kill().unwrap();
		child.wait().unwrap();
	}

	#[cfg(unix)]
	#[test]
	fn esrch_signal_race_is_absent_but_permission_errors_are_not() {
		assert_eq!(
			super::signal_error(std::io::Error::from_raw_os_error(libc::ESRCH)).unwrap(),
			"absent"
		);
		assert!(super::signal_error(std::io::Error::from_raw_os_error(libc::EPERM)).is_err());
	}
	#[cfg(unix)]
	#[test]
	fn unreaped_exited_child_is_absent() {
		use std::process::Command;
		let mut child = Command::new("true").spawn().unwrap();
		std::thread::sleep(std::time::Duration::from_millis(100));
		assert!(!super::process_start_time(child.id()).found);
		assert_eq!(
			super::signal_verified_postgres_process(child.id(), 1.0, "fast").unwrap(),
			"absent"
		);
		child.wait().unwrap();
	}
	#[cfg(unix)]
	#[test]
	fn matching_child_receives_fast_signal() {
		use std::process::{Command, Stdio};
		let mut child = Command::new("sleep").arg("10").stdout(Stdio::null()).spawn().unwrap();
		let started = super::process_start_time(child.id()).start_time.unwrap();
		assert_eq!(
			super::signal_verified_postgres_process(child.id(), started, "fast").unwrap(),
			"signaled"
		);
		assert!(!child.wait().unwrap().success());
	}
}

pub mod block;
pub mod fs_cache;
pub mod glob;
mod glob_util;
pub mod grep;
pub mod pty;
pub mod retained_postgres;
pub mod subagent_control;
pub mod task;
pub mod task_supervisor;

#[cfg(windows)]
pub mod windows_postgres_guard;

#[macro_export]
macro_rules! env_uint {
	($( $vis:vis static $name:ident : $type:ty = $env:literal or $default:expr => [$min:expr, $max:expr];)*) => {
		$(
			$vis static $name: std::sync::LazyLock<$type> = std::sync::LazyLock::new(|| {
				std::env::var($env)
					.ok()
					.and_then(|v| std::str::FromStr::from_str(&v).ok())
					.unwrap_or($default)
					.clamp($min, $max)
			});
		)*
	};
	($( $vis:vis static $name:ident : $type:ty = $env:literal or $default:expr;)*) => {
		$(
			$vis static $name: std::sync::LazyLock<$type> = std::sync::LazyLock::new(|| {
				std::env::var($env)
					.ok()
					.and_then(|v| std::str::FromStr::from_str(&v).ok())
					.unwrap_or($default)
			});
		)*
	};
}

pub const fn clamp_u32(value: u64) -> u32 {
	if value > u32::MAX as u64 { u32::MAX } else { value as u32 }
}
