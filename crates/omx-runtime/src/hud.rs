use std::thread;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HudWatchOptions {
    pub once: bool,
    pub interval_ms: u64,
    pub preset: Option<String>,
}

pub fn parse_hud_watch_args(args: &[String]) -> Result<HudWatchOptions, String> {
    let mut once = false;
    let mut interval_ms = 1_000_u64;
    let mut preset: Option<String> = None;
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--once" => {
                once = true;
                index += 1;
            }
            "--interval-ms" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("hud-watch requires a value after --interval-ms".to_string());
                };
                interval_ms = parse_interval_ms(value)?;
                index += 2;
            }
            flag if flag.starts_with("--interval-ms=") => {
                interval_ms = parse_interval_ms(flag.trim_start_matches("--interval-ms="))?;
                index += 1;
            }
            "--preset" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("hud-watch requires a value after --preset".to_string());
                };
                preset = Some(parse_preset(value)?);
                index += 2;
            }
            flag if flag.starts_with("--preset=") => {
                preset = Some(parse_preset(flag.trim_start_matches("--preset="))?);
                index += 1;
            }
            unknown => return Err(format!("unknown hud-watch argument `{unknown}`")),
        }
    }

    Ok(HudWatchOptions {
        once,
        interval_ms,
        preset,
    })
}

pub fn run_hud_watch(args: &[String]) -> Result<(), String> {
    let options = parse_hud_watch_args(args)?;
    let frame = render_frame(options.preset.as_deref());

    if options.once {
        print!("{frame}");
        return Ok(());
    }

    loop {
        print!("{frame}");
        thread::sleep(Duration::from_millis(options.interval_ms));
    }
}

fn render_frame(preset: Option<&str>) -> String {
    let preset_suffix = preset
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!(" preset:{value}"))
        .unwrap_or_default();
    format!("\u{1b}[2J\u{1b}[H[OMX] native-hud{preset_suffix}\n")
}

fn parse_interval_ms(raw: &str) -> Result<u64, String> {
    let parsed = raw
        .trim()
        .parse::<u64>()
        .map_err(|_| format!("invalid --interval-ms value `{raw}`"))?;
    if parsed == 0 {
        return Err("--interval-ms must be greater than 0".to_string());
    }
    Ok(parsed)
}

fn parse_preset(raw: &str) -> Result<String, String> {
    match raw.trim() {
        "minimal" | "focused" | "full" => Ok(raw.trim().to_string()),
        _ => Err(format!("invalid --preset value `{raw}`")),
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_hud_watch_args, run_hud_watch};

    #[test]
    fn parse_hud_watch_accepts_once_and_preset() {
        let options = parse_hud_watch_args(&[
            "--once".into(),
            "--preset".into(),
            "minimal".into(),
            "--interval-ms".into(),
            "250".into(),
        ])
        .expect("expected valid hud-watch args");

        assert!(options.once);
        assert_eq!(options.interval_ms, 250);
        assert_eq!(options.preset.as_deref(), Some("minimal"));
    }

    #[test]
    fn parse_hud_watch_rejects_invalid_preset() {
        let error = parse_hud_watch_args(&["--preset".into(), "bad".into()])
            .expect_err("expected preset error");
        assert!(error.contains("invalid --preset"));
    }

    #[test]
    fn hud_watch_once_runs_without_error() {
        assert!(run_hud_watch(&["--once".into(), "--preset=minimal".into()]).is_ok());
    }
}
