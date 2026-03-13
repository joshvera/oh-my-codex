use std::process::Command;
use std::thread::sleep;
use std::time::Duration;

const TMUX_TEXT_SETTLE_MS: u64 = 120;
const TMUX_SUBMIT_REPEAT_DELAY_MS: u64 = 100;

#[derive(Debug, Clone, PartialEq)]
pub struct PaneAnalysis {
    pub has_codex: bool,
    pub has_rate_limit_message: bool,
    pub is_blocked: bool,
    pub confidence: f32,
}

pub fn build_send_pane_commands(pane_id: &str, text: &str, press_enter: bool) -> Vec<Vec<String>> {
    let safe = text
        .replace(['\n', '\r'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut commands = vec![vec![
        "send-keys".to_string(),
        "-t".to_string(),
        pane_id.to_string(),
        "-l".to_string(),
        "--".to_string(),
        safe,
    ]];

    if press_enter {
        commands.push(vec![
            "send-keys".to_string(),
            "-t".to_string(),
            pane_id.to_string(),
            "C-m".to_string(),
        ]);
        commands.push(vec![
            "send-keys".to_string(),
            "-t".to_string(),
            pane_id.to_string(),
            "C-m".to_string(),
        ]);
    }

    commands
}

pub fn send_to_pane(pane_id: &str, text: &str, press_enter: bool) -> Result<(), String> {
    let commands = build_send_pane_commands(pane_id, text, press_enter);

    for (index, args) in commands.iter().enumerate() {
        let output = Command::new("tmux")
            .args(args)
            .output()
            .map_err(|err| format!("failed to launch tmux: {err}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let detail = stderr.trim();
            let fallback = stdout.trim();
            let message = if !detail.is_empty() {
                detail
            } else if !fallback.is_empty() {
                fallback
            } else {
                "tmux send-keys failed"
            };
            return Err(message.to_string());
        }

        if index + 1 < commands.len() {
            sleep(Duration::from_millis(if index == 0 {
                TMUX_TEXT_SETTLE_MS
            } else {
                TMUX_SUBMIT_REPEAT_DELAY_MS
            }));
        }
    }

    Ok(())
}

pub fn capture_pane(pane_id: &str, tail_lines: usize) -> Result<String, String> {
    let output = Command::new("tmux")
        .args([
            "capture-pane",
            "-t",
            pane_id,
            "-p",
            "-S",
            &format!("-{tail_lines}"),
        ])
        .output()
        .map_err(|err| format!("failed to launch tmux: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = stderr.trim();
        let fallback = stdout.trim();
        let message = if !detail.is_empty() {
            detail
        } else if !fallback.is_empty() {
            fallback
        } else {
            "tmux capture-pane failed"
        };
        return Err(message.to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

pub fn analyze_pane_content(content: &str) -> PaneAnalysis {
    let lower = content.to_ascii_lowercase();

    let has_codex = lower.contains("codex")
        || lower.contains("omx")
        || lower.contains("oh-my-codex")
        || lower.contains("openai");

    let has_rate_limit_message =
        lower.contains("rate limit") || lower.contains("rate-limit") || lower.contains("429");

    let is_blocked =
        lower.contains("waiting") || lower.contains("blocked") || lower.contains("paused");

    let mut confidence = 0.0_f32;
    if has_codex {
        confidence += 0.5;
    }
    if lower.contains('>') || lower.contains('$') {
        confidence += 0.1;
    }
    if lower.contains("agent") || lower.contains("task") {
        confidence += 0.1;
    }
    if !content.trim().is_empty() {
        confidence += 0.1;
    }

    PaneAnalysis {
        has_codex,
        has_rate_limit_message,
        is_blocked,
        confidence: confidence.min(1.0),
    }
}

#[cfg(test)]
mod tests {
    use super::{analyze_pane_content, build_send_pane_commands};

    #[test]
    fn build_send_pane_commands_matches_literal_text_plus_two_submit_pattern() {
        let commands = build_send_pane_commands("%5", "continue", true);
        assert_eq!(
            commands,
            vec![
                vec![
                    "send-keys".to_string(),
                    "-t".to_string(),
                    "%5".to_string(),
                    "-l".to_string(),
                    "--".to_string(),
                    "continue".to_string(),
                ],
                vec![
                    "send-keys".to_string(),
                    "-t".to_string(),
                    "%5".to_string(),
                    "C-m".to_string(),
                ],
                vec![
                    "send-keys".to_string(),
                    "-t".to_string(),
                    "%5".to_string(),
                    "C-m".to_string(),
                ],
            ]
        );
    }

    #[test]
    fn build_send_pane_commands_strips_newlines_from_text() {
        let commands = build_send_pane_commands("%3", "line1\nline2\r\nline3", false);
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0][5], "line1 line2 line3");
    }

    #[test]
    fn analyze_pane_content_detects_codex_like_blocked_content() {
        let analysis = analyze_pane_content("Codex agent waiting on task >");
        assert!(analysis.has_codex);
        assert!(analysis.is_blocked);
        assert!(analysis.confidence >= 0.7);
    }
}
