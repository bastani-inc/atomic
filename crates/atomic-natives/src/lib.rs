pub mod advisory_lock;
pub mod directory_security;
pub mod fs_cache;
pub mod glob;
mod glob_util;
pub mod grep;
pub mod host_process;
pub mod native_version;
pub mod process_start;
pub mod process_tree;
pub mod pty;
pub mod session_end;
pub mod signal_disposition;
#[cfg(target_os = "linux")]
pub(crate) mod spawn;
pub mod stdin_input;
pub mod subagent_control;
pub mod task;
pub mod task_supervisor;
pub mod temporary_file;

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
