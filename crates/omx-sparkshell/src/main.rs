mod codex_bridge;
mod error;
mod exec;
mod prompt;
#[cfg(test)]
mod test_support;
mod threshold;

use crate::codex_bridge::summarize_output;
use crate::error::SparkshellError;
use crate::exec::{execute_command, CommandOutput};
use crate::threshold::{combined_visible_lines, read_line_threshold};
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;
use std::process;

const DEFAULT_TMUX_TAIL_LINES: usize = 200;
const MIN_TMUX_TAIL_LINES: usize = 100;
const MAX_TMUX_TAIL_LINES: usize = 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
enum SparkShellInput {
    Command(Vec<String>),
    TmuxPane {
        pane_id: String,
        tail_lines: usize,
    },
    TeamPanes {
        panes: Vec<NamedTmuxPane>,
        tail_lines: usize,
        targets: Vec<String>,
        list_only: bool,
        list_format: TeamListFormat,
    },
    TeamManifest {
        path: String,
        tail_lines: usize,
        targets: Vec<String>,
        list_only: bool,
        list_format: TeamListFormat,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NamedTmuxPane {
    label: String,
    pane_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TeamListFormat {
    Lines,
    Json,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args
        .first()
        .is_some_and(|arg| arg == "--help" || arg == "-h")
    {
        println!("{}", usage_text());
        return;
    }
    if let Err(error) = run(args) {
        eprintln!("omx sparkshell: {error}");
        process::exit(error.raw_exit_code());
    }
}

fn run(args: Vec<String>) -> Result<(), SparkshellError> {
    match parse_input(&args)? {
        SparkShellInput::Command(command) => run_single_command(&command, None),
        SparkShellInput::TmuxPane {
            pane_id,
            tail_lines,
        } => {
            let execution_argv = build_tmux_capture_argv(&pane_id, tail_lines);
            run_single_command(&execution_argv, None)
        }
        SparkShellInput::TeamPanes {
            panes,
            tail_lines,
            targets,
            list_only,
            list_format,
        } => {
            let panes = filter_named_tmux_panes(panes, &targets)?;
            if list_only {
                print_team_panes(&panes, list_format)?;
                return Ok(());
            }
            run_team_panes(&panes, tail_lines)
        }
        SparkShellInput::TeamManifest {
            path,
            tail_lines,
            targets,
            list_only,
            list_format,
        } => {
            let panes = parse_team_manifest_panes(Path::new(&path))?;
            let panes = filter_named_tmux_panes(panes, &targets)?;
            if list_only {
                print_team_panes(&panes, list_format)?;
                return Ok(());
            }
            run_team_panes(&panes, tail_lines)
        }
    }
}

fn build_tmux_capture_argv(pane_id: &str, tail_lines: usize) -> Vec<String> {
    vec![
        "tmux".to_string(),
        "capture-pane".to_string(),
        "-t".to_string(),
        pane_id.to_string(),
        "-p".to_string(),
        "-S".to_string(),
        format!("-{tail_lines}"),
    ]
}

fn run_single_command(
    execution_argv: &[String],
    header: Option<&str>,
) -> Result<(), SparkshellError> {
    let output = execute_command(execution_argv)?;
    emit_command_output(execution_argv, &output, header)?;
    process::exit(output.exit_code());
}

fn escape_json_string(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            other => escaped.push(other),
        }
    }
    escaped
}

fn render_team_panes(panes: &[NamedTmuxPane], format: TeamListFormat) -> String {
    match format {
        TeamListFormat::Lines => {
            panes
                .iter()
                .map(|pane| format!("label={} pane_id={}", pane.label, pane.pane_id))
                .collect::<Vec<_>>()
                .join("\n")
                + "\n"
        }
        TeamListFormat::Json => {
            let body = panes
                .iter()
                .map(|pane| {
                    format!(
                        "{{\"label\":\"{}\",\"pane_id\":\"{}\"}}",
                        escape_json_string(&pane.label),
                        escape_json_string(&pane.pane_id)
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("[{body}]\n")
        }
    }
}

fn print_team_panes(
    panes: &[NamedTmuxPane],
    format: TeamListFormat,
) -> Result<(), SparkshellError> {
    let mut stdout = io::stdout().lock();
    stdout.write_all(render_team_panes(panes, format).as_bytes())?;
    stdout.flush()?;
    Ok(())
}

fn run_team_panes(panes: &[NamedTmuxPane], tail_lines: usize) -> Result<(), SparkshellError> {
    let mut exit_code = 0;
    for (index, pane) in panes.iter().enumerate() {
        let execution_argv = build_tmux_capture_argv(&pane.pane_id, tail_lines);
        let output = execute_command(&execution_argv)?;
        let header = format!("team-pane:{} {}", pane.label, pane.pane_id);
        emit_command_output(&execution_argv, &output, Some(&header))?;
        if exit_code == 0 {
            exit_code = output.exit_code();
        }
        if index + 1 < panes.len() {
            let mut stdout = io::stdout().lock();
            stdout.write_all(b"\n")?;
            stdout.flush()?;
        }
    }
    process::exit(exit_code);
}

fn emit_command_output(
    execution_argv: &[String],
    output: &CommandOutput,
    header: Option<&str>,
) -> Result<(), SparkshellError> {
    if let Some(header) = header {
        let mut stdout = io::stdout().lock();
        stdout.write_all(format!("== {header} ==\n").as_bytes())?;
        stdout.flush()?;
    }

    let threshold = read_line_threshold();
    let line_count = combined_visible_lines(&output.stdout, &output.stderr);

    if line_count <= threshold {
        return write_raw_output(&output.stdout, &output.stderr);
    }

    match summarize_output(execution_argv, output) {
        Ok(summary) => {
            let mut stdout = io::stdout().lock();
            stdout.write_all(summary.as_bytes())?;
            if !summary.ends_with('\n') {
                stdout.write_all(b"\n")?;
            }
            stdout.flush()?;
        }
        Err(error) => {
            write_raw_output(&output.stdout, &output.stderr)?;
            eprintln!("omx sparkshell: summary unavailable ({error})");
        }
    }

    Ok(())
}

fn write_raw_output(stdout_bytes: &[u8], stderr_bytes: &[u8]) -> Result<(), SparkshellError> {
    let mut stdout = io::stdout().lock();
    stdout.write_all(stdout_bytes)?;
    stdout.flush()?;

    let mut stderr = io::stderr().lock();
    stderr.write_all(stderr_bytes)?;
    stderr.flush()?;
    Ok(())
}

fn usage_text() -> String {
    format!(
        concat!(
            "usage: omx-sparkshell <command> [args...]\n",
            "   or: omx-sparkshell --tmux-pane <pane-id> [--tail-lines <{min}-{max}>]\n",
            "   or: omx-sparkshell --team-pane <label>=<pane-id> [--team-pane <label>=<pane-id> ...] [--team-pane-file <path>] [--team-target <label> ...] [--list-team-targets] [--tail-lines <{min}-{max}>]\n",
            "   or: omx-sparkshell --team-manifest <path> [--team-target <label> ...] [--list-team-targets] [--tail-lines <{min}-{max}>]\n",
            "\n",
            "Direct command mode executes argv without shell metacharacter parsing.\n",
            "Tmux pane mode captures a larger pane tail and applies the same raw-vs-summary behavior.\n",
            "Team-pane mode captures multiple labeled tmux panes sequentially for native team inspection flows.\n",
            "--team-pane-file reads newline-delimited <label>=<pane-id> entries for manifest-driven native inspection. Use `-` to read from stdin.\n",
            "--team-manifest reads leader/hud/worker pane ids from team config or manifest JSON so native status/launcher paths can inspect panes without Node glue.\n",
            "--team-target narrows manifest/file-driven inspection to specific labels such as leader, hud, or worker-1.\n",
            "--list-team-targets prints available labels and pane ids without invoking tmux capture or summarization.\n"
        ),
        min = MIN_TMUX_TAIL_LINES,
        max = MAX_TMUX_TAIL_LINES,
    )
}

fn parse_named_tmux_pane(raw: &str) -> Result<NamedTmuxPane, SparkshellError> {
    let Some((label, pane_id)) = raw.split_once('=') else {
        return Err(SparkshellError::InvalidArgs(
            "--team-pane requires <label>=<pane-id>".to_string(),
        ));
    };
    let label = label.trim();
    let pane_id = pane_id.trim();
    if label.is_empty() || pane_id.is_empty() || pane_id.starts_with('-') {
        return Err(SparkshellError::InvalidArgs(
            "--team-pane requires <label>=<pane-id>".to_string(),
        ));
    }
    Ok(NamedTmuxPane {
        label: label.to_string(),
        pane_id: pane_id.to_string(),
    })
}

fn parse_json_string_value(text: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let start = text.find(&needle)? + needle.len();
    let after_key = &text[start..];
    let colon = after_key.find(':')?;
    let mut rest = after_key[colon + 1..].trim_start();
    if rest.starts_with("null") {
        return None;
    }
    if !rest.starts_with('"') {
        return None;
    }
    rest = &rest[1..];
    let mut value = String::new();
    let mut escape = false;
    for ch in rest.chars() {
        if escape {
            value.push(match ch {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                '"' => '"',
                '\\' => '\\',
                other => other,
            });
            escape = false;
            continue;
        }
        match ch {
            '\\' => escape = true,
            '"' => return Some(value),
            other => value.push(other),
        }
    }
    None
}

fn find_matching_bracket(text: &str, open_index: usize, open: char, close: char) -> Option<usize> {
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escape = false;
    for (offset, ch) in text[open_index..].char_indices() {
        if in_string {
            if escape {
                escape = false;
            } else if ch == '\\' {
                escape = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
            continue;
        }
        if ch == open {
            depth += 1;
        } else if ch == close {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return Some(open_index + offset);
            }
        }
    }
    None
}

fn extract_json_array<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("\"{key}\"");
    let start = text.find(&needle)? + needle.len();
    let after_key = &text[start..];
    let colon = after_key.find(':')?;
    let rest = after_key[colon + 1..].trim_start();
    let open_rel = rest.find('[')?;
    let open_abs = text.len() - rest.len() + open_rel;
    let close_abs = find_matching_bracket(text, open_abs, '[', ']')?;
    Some(&text[open_abs + 1..close_abs])
}

fn extract_object_slices(text: &str) -> Vec<&str> {
    let mut objects = Vec::new();
    let mut cursor = 0usize;
    while let Some(open_rel) = text[cursor..].find('{') {
        let open_abs = cursor + open_rel;
        let Some(close_abs) = find_matching_bracket(text, open_abs, '{', '}') else {
            break;
        };
        objects.push(&text[open_abs..=close_abs]);
        cursor = close_abs + 1;
    }
    objects
}

fn filter_named_tmux_panes(
    panes: Vec<NamedTmuxPane>,
    targets: &[String],
) -> Result<Vec<NamedTmuxPane>, SparkshellError> {
    if targets.is_empty() {
        return Ok(panes);
    }
    let filtered: Vec<NamedTmuxPane> = panes
        .into_iter()
        .filter(|pane| targets.iter().any(|target| target == &pane.label))
        .collect();
    if filtered.is_empty() {
        return Err(SparkshellError::InvalidArgs(format!(
            "--team-target values [{}] did not match any available pane labels",
            targets.join(", ")
        )));
    }
    Ok(filtered)
}

fn parse_team_manifest_panes(path: &Path) -> Result<Vec<NamedTmuxPane>, SparkshellError> {
    let raw = fs::read_to_string(path).map_err(|error| {
        SparkshellError::InvalidArgs(format!(
            "--team-manifest could not read {}: {}",
            path.display(),
            error
        ))
    })?;

    let mut panes = Vec::new();
    if let Some(pane_id) = parse_json_string_value(&raw, "leader_pane_id") {
        if !pane_id.trim().is_empty() {
            panes.push(NamedTmuxPane {
                label: "leader".to_string(),
                pane_id,
            });
        }
    }
    if let Some(pane_id) = parse_json_string_value(&raw, "hud_pane_id") {
        if !pane_id.trim().is_empty() {
            panes.push(NamedTmuxPane {
                label: "hud".to_string(),
                pane_id,
            });
        }
    }
    if let Some(workers_raw) = extract_json_array(&raw, "workers") {
        for worker_raw in extract_object_slices(workers_raw) {
            let Some(label) = parse_json_string_value(worker_raw, "name") else {
                continue;
            };
            let Some(pane_id) = parse_json_string_value(worker_raw, "pane_id") else {
                continue;
            };
            if pane_id.trim().is_empty() {
                continue;
            }
            panes.push(NamedTmuxPane { label, pane_id });
        }
    }
    if panes.is_empty() {
        return Err(SparkshellError::InvalidArgs(format!(
            "--team-manifest {} did not contain leader/hud/worker pane ids",
            path.display()
        )));
    }
    Ok(panes)
}

fn parse_named_tmux_panes_file(path: &Path) -> Result<Vec<NamedTmuxPane>, SparkshellError> {
    let raw = if path == Path::new("-") {
        let mut buffer = String::new();
        io::stdin().read_to_string(&mut buffer).map_err(|error| {
            SparkshellError::InvalidArgs(format!(
                "--team-pane-file could not read stdin: {}",
                error
            ))
        })?;
        buffer
    } else {
        fs::read_to_string(path).map_err(|error| {
            SparkshellError::InvalidArgs(format!(
                "--team-pane-file could not read {}: {}",
                path.display(),
                error
            ))
        })?
    };
    let mut panes = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        panes.push(parse_named_tmux_pane(trimmed)?);
    }
    if panes.is_empty() {
        return Err(SparkshellError::InvalidArgs(format!(
            "--team-pane-file {} did not contain any <label>=<pane-id> entries",
            path.display()
        )));
    }
    Ok(panes)
}

fn parse_input(args: &[String]) -> Result<SparkShellInput, SparkshellError> {
    if args.is_empty() {
        return Err(SparkshellError::InvalidArgs(usage_text()));
    }

    let mut pane_id: Option<String> = None;
    let mut team_manifest_path: Option<String> = None;
    let mut team_panes: Vec<NamedTmuxPane> = Vec::new();
    let mut team_targets: Vec<String> = Vec::new();
    let mut list_team_targets = false;
    let mut team_list_format = TeamListFormat::Lines;
    let mut tail_lines = DEFAULT_TMUX_TAIL_LINES;
    let mut explicit_tail_lines = false;
    let mut positional = Vec::new();

    let mut index = 0;
    while index < args.len() {
        let token = &args[index];
        if token == "--tmux-pane" {
            let Some(next) = args.get(index + 1) else {
                return Err(SparkshellError::InvalidArgs(
                    "--tmux-pane requires a pane id".to_string(),
                ));
            };
            if next.starts_with('-') {
                return Err(SparkshellError::InvalidArgs(
                    "--tmux-pane requires a pane id".to_string(),
                ));
            }
            pane_id = Some(next.clone());
            index += 2;
            continue;
        }
        if let Some(value) = token.strip_prefix("--tmux-pane=") {
            if value.trim().is_empty() {
                return Err(SparkshellError::InvalidArgs(
                    "--tmux-pane requires a pane id".to_string(),
                ));
            }
            pane_id = Some(value.to_string());
            index += 1;
            continue;
        }
        if token == "--team-pane" {
            let Some(next) = args.get(index + 1) else {
                return Err(SparkshellError::InvalidArgs(
                    "--team-pane requires <label>=<pane-id>".to_string(),
                ));
            };
            team_panes.push(parse_named_tmux_pane(next)?);
            index += 2;
            continue;
        }
        if let Some(value) = token.strip_prefix("--team-pane=") {
            team_panes.push(parse_named_tmux_pane(value)?);
            index += 1;
            continue;
        }
        if token == "--team-pane-file" {
            let Some(next) = args.get(index + 1) else {
                return Err(SparkshellError::InvalidArgs(
                    "--team-pane-file requires a file path".to_string(),
                ));
            };
            team_panes.extend(parse_named_tmux_panes_file(Path::new(next))?);
            index += 2;
            continue;
        }
        if let Some(value) = token.strip_prefix("--team-pane-file=") {
            if value.trim().is_empty() {
                return Err(SparkshellError::InvalidArgs(
                    "--team-pane-file requires a file path".to_string(),
                ));
            }
            team_panes.extend(parse_named_tmux_panes_file(Path::new(value))?);
            index += 1;
            continue;
        }
        if token == "--team-target" {
            let Some(next) = args.get(index + 1) else {
                return Err(SparkshellError::InvalidArgs(
                    "--team-target requires a pane label".to_string(),
                ));
            };
            if next.trim().is_empty() || next.starts_with('-') {
                return Err(SparkshellError::InvalidArgs(
                    "--team-target requires a pane label".to_string(),
                ));
            }
            team_targets.push(next.clone());
            index += 2;
            continue;
        }
        if let Some(value) = token.strip_prefix("--team-target=") {
            if value.trim().is_empty() {
                return Err(SparkshellError::InvalidArgs(
                    "--team-target requires a pane label".to_string(),
                ));
            }
            team_targets.push(value.to_string());
            index += 1;
            continue;
        }
        if token == "--list-team-targets" {
            list_team_targets = true;
            index += 1;
            continue;
        }
        if token == "--team-list-format" {
            let Some(next) = args.get(index + 1) else {
                return Err(SparkshellError::InvalidArgs(
                    "--team-list-format requires `lines` or `json`".to_string(),
                ));
            };
            team_list_format = match next.as_str() {
                "lines" => TeamListFormat::Lines,
                "json" => TeamListFormat::Json,
                _ => {
                    return Err(SparkshellError::InvalidArgs(
                        "--team-list-format requires `lines` or `json`".to_string(),
                    ));
                }
            };
            index += 2;
            continue;
        }
        if let Some(value) = token.strip_prefix("--team-list-format=") {
            team_list_format = match value {
                "lines" => TeamListFormat::Lines,
                "json" => TeamListFormat::Json,
                _ => {
                    return Err(SparkshellError::InvalidArgs(
                        "--team-list-format requires `lines` or `json`".to_string(),
                    ));
                }
            };
            index += 1;
            continue;
        }
        if token == "--team-manifest" {
            let Some(next) = args.get(index + 1) else {
                return Err(SparkshellError::InvalidArgs(
                    "--team-manifest requires a file path".to_string(),
                ));
            };
            team_manifest_path = Some(next.clone());
            index += 2;
            continue;
        }
        if let Some(value) = token.strip_prefix("--team-manifest=") {
            if value.trim().is_empty() {
                return Err(SparkshellError::InvalidArgs(
                    "--team-manifest requires a file path".to_string(),
                ));
            }
            team_manifest_path = Some(value.to_string());
            index += 1;
            continue;
        }
        if token == "--tail-lines" {
            let Some(next) = args.get(index + 1) else {
                return Err(SparkshellError::InvalidArgs(
                    "--tail-lines requires a numeric value".to_string(),
                ));
            };
            tail_lines = parse_tail_lines(next)?;
            explicit_tail_lines = true;
            index += 2;
            continue;
        }
        if let Some(value) = token.strip_prefix("--tail-lines=") {
            tail_lines = parse_tail_lines(value)?;
            explicit_tail_lines = true;
            index += 1;
            continue;
        }

        positional.push(token.clone());
        index += 1;
    }

    if pane_id.is_some() && !team_panes.is_empty() {
        return Err(SparkshellError::InvalidArgs(
            "--tmux-pane cannot be combined with --team-pane".to_string(),
        ));
    }
    if pane_id.is_some() && team_manifest_path.is_some() {
        return Err(SparkshellError::InvalidArgs(
            "--tmux-pane cannot be combined with --team-manifest".to_string(),
        ));
    }
    if !team_panes.is_empty() && team_manifest_path.is_some() {
        return Err(SparkshellError::InvalidArgs(
            "--team-pane cannot be combined with --team-manifest".to_string(),
        ));
    }

    if let Some(pane_id) = pane_id {
        if !positional.is_empty() {
            return Err(SparkshellError::InvalidArgs(
                "tmux pane mode does not accept an additional command".to_string(),
            ));
        }
        return Ok(SparkShellInput::TmuxPane {
            pane_id,
            tail_lines,
        });
    }

    if !team_panes.is_empty() {
        if !positional.is_empty() {
            return Err(SparkshellError::InvalidArgs(
                "team-pane mode does not accept an additional command".to_string(),
            ));
        }
        return Ok(SparkShellInput::TeamPanes {
            panes: team_panes,
            tail_lines,
            targets: team_targets,
            list_only: list_team_targets,
            list_format: team_list_format,
        });
    }

    if let Some(path) = team_manifest_path {
        if !positional.is_empty() {
            return Err(SparkshellError::InvalidArgs(
                "team-manifest mode does not accept an additional command".to_string(),
            ));
        }
        return Ok(SparkShellInput::TeamManifest {
            path,
            tail_lines,
            targets: team_targets,
            list_only: list_team_targets,
            list_format: team_list_format,
        });
    }

    if !team_targets.is_empty() {
        return Err(SparkshellError::InvalidArgs(
            "--team-target requires --team-pane, --team-pane-file, or --team-manifest".to_string(),
        ));
    }
    if list_team_targets {
        return Err(SparkshellError::InvalidArgs(
            "--list-team-targets requires --team-pane, --team-pane-file, or --team-manifest"
                .to_string(),
        ));
    }
    if team_list_format != TeamListFormat::Lines {
        return Err(SparkshellError::InvalidArgs(
            "--team-list-format requires --list-team-targets with --team-pane, --team-pane-file, or --team-manifest"
                .to_string(),
        ));
    }

    if explicit_tail_lines {
        return Err(SparkshellError::InvalidArgs(
            "--tail-lines requires --tmux-pane or --team-pane".to_string(),
        ));
    }

    Ok(SparkShellInput::Command(positional))
}

fn parse_tail_lines(raw: &str) -> Result<usize, SparkshellError> {
    let parsed = raw
        .trim()
        .parse::<usize>()
        .ok()
        .filter(|value| (*value >= MIN_TMUX_TAIL_LINES) && (*value <= MAX_TMUX_TAIL_LINES))
        .ok_or_else(|| {
            SparkshellError::InvalidArgs(format!(
                "--tail-lines must be an integer between {MIN_TMUX_TAIL_LINES} and {MAX_TMUX_TAIL_LINES}"
            ))
        })?;
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::{
        escape_json_string, filter_named_tmux_panes, parse_input, parse_team_manifest_panes,
        render_team_panes, usage_text, NamedTmuxPane, SparkShellInput, TeamListFormat,
    };

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn parses_direct_command_mode() {
        let parsed = parse_input(&strings(&["git", "status"])).expect("parsed");
        assert_eq!(
            parsed,
            SparkShellInput::Command(strings(&["git", "status"]))
        );
    }

    #[test]
    fn parses_tmux_pane_mode_with_default_tail_lines() {
        let parsed = parse_input(&strings(&["--tmux-pane", "%11"])).expect("parsed");
        assert_eq!(
            parsed,
            SparkShellInput::TmuxPane {
                pane_id: "%11".to_string(),
                tail_lines: 200,
            }
        );
    }

    #[test]
    fn parses_tmux_pane_mode_with_explicit_tail_lines() {
        let parsed =
            parse_input(&strings(&["--tmux-pane=%22", "--tail-lines=400"])).expect("parsed");
        assert_eq!(
            parsed,
            SparkShellInput::TmuxPane {
                pane_id: "%22".to_string(),
                tail_lines: 400,
            }
        );
    }

    #[test]
    fn parses_team_panes_mode_with_multiple_targets() {
        let parsed = parse_input(&strings(&[
            "--team-pane",
            "leader=%10",
            "--team-pane=worker-1=%21",
            "--tail-lines",
            "400",
        ]))
        .expect("parsed");
        assert_eq!(
            parsed,
            SparkShellInput::TeamPanes {
                panes: vec![
                    NamedTmuxPane {
                        label: "leader".to_string(),
                        pane_id: "%10".to_string(),
                    },
                    NamedTmuxPane {
                        label: "worker-1".to_string(),
                        pane_id: "%21".to_string(),
                    },
                ],
                tail_lines: 400,
                targets: vec![],
                list_only: false,
                list_format: TeamListFormat::Lines,
            }
        );
    }

    #[test]
    fn parses_team_manifest_mode_with_list_only() {
        let parsed = parse_input(&strings(&[
            "--team-manifest",
            "team/manifest.v2.json",
            "--list-team-targets",
            "--tail-lines",
            "400",
        ]))
        .expect("parsed");
        assert_eq!(
            parsed,
            SparkShellInput::TeamManifest {
                path: "team/manifest.v2.json".to_string(),
                tail_lines: 400,
                targets: vec![],
                list_only: true,
                list_format: TeamListFormat::Lines,
            }
        );
    }

    #[test]
    fn parses_team_manifest_mode_with_json_list_format() {
        let parsed = parse_input(&strings(&[
            "--team-manifest",
            "team/manifest.v2.json",
            "--list-team-targets",
            "--team-list-format=json",
        ]))
        .expect("parsed");
        assert_eq!(
            parsed,
            SparkShellInput::TeamManifest {
                path: "team/manifest.v2.json".to_string(),
                tail_lines: 200,
                targets: vec![],
                list_only: true,
                list_format: TeamListFormat::Json,
            }
        );
    }

    #[test]
    fn parses_team_manifest_mode_with_target_filters() {
        let parsed = parse_input(&strings(&[
            "--team-manifest",
            "team/manifest.v2.json",
            "--team-target",
            "hud",
            "--team-target=worker-1",
            "--tail-lines",
            "400",
        ]))
        .expect("parsed");
        assert_eq!(
            parsed,
            SparkShellInput::TeamManifest {
                path: "team/manifest.v2.json".to_string(),
                tail_lines: 400,
                targets: vec!["hud".to_string(), "worker-1".to_string()],
                list_only: false,
                list_format: TeamListFormat::Lines,
            }
        );
    }

    #[test]
    fn rejects_team_target_without_value() {
        let error = parse_input(&strings(&["--team-target"])).unwrap_err();
        assert_eq!(error.to_string(), "--team-target requires a pane label");
    }

    #[test]
    fn rejects_team_target_without_team_source() {
        let error = parse_input(&strings(&["--team-target", "leader"])).unwrap_err();
        assert_eq!(
            error.to_string(),
            "--team-target requires --team-pane, --team-pane-file, or --team-manifest"
        );
    }

    #[test]
    fn rejects_list_team_targets_without_team_source() {
        let error = parse_input(&strings(&["--list-team-targets"])).unwrap_err();
        assert_eq!(
            error.to_string(),
            "--list-team-targets requires --team-pane, --team-pane-file, or --team-manifest"
        );
    }

    #[test]
    fn rejects_team_list_format_without_list_mode() {
        let error = parse_input(&strings(&["--team-list-format", "json"])).unwrap_err();
        assert_eq!(
            error.to_string(),
            "--team-list-format requires --list-team-targets with --team-pane, --team-pane-file, or --team-manifest"
        );
    }

    #[test]
    fn escapes_json_strings_for_team_list_output() {
        assert_eq!(escape_json_string("a\"b\\c\n"), "a\\\"b\\\\c\\n");
    }

    #[test]
    fn filters_named_tmux_panes_by_target() {
        let filtered = filter_named_tmux_panes(
            vec![
                NamedTmuxPane {
                    label: "leader".to_string(),
                    pane_id: "%10".to_string(),
                },
                NamedTmuxPane {
                    label: "hud".to_string(),
                    pane_id: "%11".to_string(),
                },
                NamedTmuxPane {
                    label: "worker-1".to_string(),
                    pane_id: "%21".to_string(),
                },
            ],
            &["hud".to_string(), "worker-1".to_string()],
        )
        .expect("filtered");
        assert_eq!(
            filtered,
            vec![
                NamedTmuxPane {
                    label: "hud".to_string(),
                    pane_id: "%11".to_string()
                },
                NamedTmuxPane {
                    label: "worker-1".to_string(),
                    pane_id: "%21".to_string()
                },
            ]
        );
    }

    #[test]
    fn render_team_panes_lines_is_stable() {
        let panes = vec![
            NamedTmuxPane {
                label: "leader".to_string(),
                pane_id: "%10".to_string(),
            },
            NamedTmuxPane {
                label: "worker-1".to_string(),
                pane_id: "%21".to_string(),
            },
        ];
        assert_eq!(
            render_team_panes(&panes, TeamListFormat::Lines),
            "label=leader pane_id=%10
label=worker-1 pane_id=%21
"
        );
    }

    #[test]
    fn render_team_panes_json_is_stable() {
        let panes = vec![NamedTmuxPane {
            label: "hud".to_string(),
            pane_id: "%11".to_string(),
        }];
        assert_eq!(
            render_team_panes(&panes, TeamListFormat::Json),
            "[{\"label\":\"hud\",\"pane_id\":\"%11\"}]\n"
        );
    }

    #[test]
    fn parses_team_manifest_mode() {
        let parsed = parse_input(&strings(&[
            "--team-manifest",
            "team/manifest.v2.json",
            "--tail-lines",
            "400",
        ]))
        .expect("parsed");
        assert_eq!(
            parsed,
            SparkShellInput::TeamManifest {
                path: "team/manifest.v2.json".to_string(),
                tail_lines: 400,
                targets: vec![],
                list_only: false,
                list_format: TeamListFormat::Lines,
            }
        );
    }

    #[test]
    fn rejects_team_manifest_without_path() {
        let error = parse_input(&strings(&["--team-manifest"])).unwrap_err();
        assert_eq!(error.to_string(), "--team-manifest requires a file path");
    }

    #[test]
    fn rejects_combined_team_pane_and_team_manifest_modes() {
        let error = parse_input(&strings(&[
            "--team-pane",
            "leader=%10",
            "--team-manifest",
            "team/manifest.v2.json",
        ]))
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "--team-pane cannot be combined with --team-manifest"
        );
    }

    #[test]
    fn parses_team_manifest_panes_from_json() {
        let manifest = r#"{
            "leader_pane_id": "%10",
            "hud_pane_id": "%11",
            "workers": [
                { "name": "worker-1", "pane_id": "%21" },
                { "name": "worker-2", "pane_id": null },
                { "name": "worker-3", "pane_id": "%23" }
            ]
        }"#;
        let dir = std::env::temp_dir().join(format!("omx-team-manifest-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("manifest.v2.json");
        std::fs::write(&path, manifest).expect("write file");
        let panes = parse_team_manifest_panes(&path).expect("panes");
        assert_eq!(
            panes,
            vec![
                NamedTmuxPane {
                    label: "leader".to_string(),
                    pane_id: "%10".to_string()
                },
                NamedTmuxPane {
                    label: "hud".to_string(),
                    pane_id: "%11".to_string()
                },
                NamedTmuxPane {
                    label: "worker-1".to_string(),
                    pane_id: "%21".to_string()
                },
                NamedTmuxPane {
                    label: "worker-3".to_string(),
                    pane_id: "%23".to_string()
                },
            ]
        );
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir(dir);
    }

    #[test]
    fn parses_team_panes_from_file() {
        let dir = std::env::temp_dir().join(format!("omx-team-pane-file-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("panes.txt");
        std::fs::write(&path, "# comment\nleader=%10\nworker-1=%21\n").expect("write file");
        let parsed = parse_input(&strings(&[
            "--team-pane-file",
            path.to_string_lossy().as_ref(),
            "--tail-lines",
            "400",
        ]))
        .expect("parsed");
        assert_eq!(
            parsed,
            SparkShellInput::TeamPanes {
                panes: vec![
                    NamedTmuxPane {
                        label: "leader".to_string(),
                        pane_id: "%10".to_string(),
                    },
                    NamedTmuxPane {
                        label: "worker-1".to_string(),
                        pane_id: "%21".to_string(),
                    },
                ],
                tail_lines: 400,
                targets: vec![],
                list_only: false,
                list_format: TeamListFormat::Lines,
            }
        );
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir(dir);
    }

    #[test]
    fn rejects_team_pane_file_without_path() {
        let error = parse_input(&strings(&["--team-pane-file"])).unwrap_err();
        assert_eq!(error.to_string(), "--team-pane-file requires a file path");
    }

    #[test]
    fn usage_mentions_stdin_for_team_pane_file() {
        assert!(usage_text().contains("Use `-` to read from stdin."));
    }

    #[test]
    fn rejects_tail_lines_without_tmux_pane() {
        let error = parse_input(&strings(&["--tail-lines", "300"])).unwrap_err();
        assert_eq!(
            error.to_string(),
            "--tail-lines requires --tmux-pane or --team-pane"
        );
    }

    #[test]
    fn rejects_default_tail_lines_without_tmux_pane_when_explicit() {
        let error = parse_input(&strings(&["--tail-lines", "200"])).unwrap_err();
        assert_eq!(
            error.to_string(),
            "--tail-lines requires --tmux-pane or --team-pane"
        );
    }

    #[test]
    fn rejects_tmux_pane_mode_with_positional_command() {
        let error = parse_input(&strings(&["--tmux-pane", "%11", "git", "status"])).unwrap_err();
        assert_eq!(
            error.to_string(),
            "tmux pane mode does not accept an additional command"
        );
    }

    #[test]
    fn rejects_team_pane_mode_with_positional_command() {
        let error = parse_input(&strings(&["--team-pane", "worker-1=%17", "git"])).unwrap_err();
        assert_eq!(
            error.to_string(),
            "team-pane mode does not accept an additional command"
        );
    }

    #[test]
    fn rejects_out_of_range_tail_lines() {
        let error =
            parse_input(&strings(&["--tmux-pane", "%11", "--tail-lines", "80"])).unwrap_err();
        assert_eq!(
            error.to_string(),
            "--tail-lines must be an integer between 100 and 1000"
        );
    }

    #[test]
    fn rejects_tail_lines_above_maximum() {
        let error =
            parse_input(&strings(&["--tmux-pane", "%11", "--tail-lines", "1001"])).unwrap_err();
        assert_eq!(
            error.to_string(),
            "--tail-lines must be an integer between 100 and 1000"
        );
    }

    #[test]
    fn tmux_pane_flag_rejects_missing_equals_value() {
        let error = parse_input(&strings(&["--tmux-pane="])).unwrap_err();
        assert_eq!(error.to_string(), "--tmux-pane requires a pane id");
    }

    #[test]
    fn tmux_pane_flag_rejects_dash_prefixed_value() {
        let error = parse_input(&strings(&["--tmux-pane", "--tail-lines"])).unwrap_err();
        assert_eq!(error.to_string(), "--tmux-pane requires a pane id");
    }

    #[test]
    fn rejects_team_pane_without_label_and_pane_id() {
        let error = parse_input(&strings(&["--team-pane", "%17"])).unwrap_err();
        assert_eq!(error.to_string(), "--team-pane requires <label>=<pane-id>");
    }

    #[test]
    fn rejects_combined_tmux_pane_and_team_pane_modes() {
        let error = parse_input(&strings(&[
            "--tmux-pane",
            "%17",
            "--team-pane",
            "worker-1=%21",
        ]))
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "--tmux-pane cannot be combined with --team-pane"
        );
    }

    #[test]
    fn tail_lines_accepts_boundary_values() {
        let min = parse_input(&strings(&["--tmux-pane", "%11", "--tail-lines", "100"]))
            .expect("min parsed");
        let max = parse_input(&strings(&["--tmux-pane", "%11", "--tail-lines", "1000"]))
            .expect("max parsed");
        assert_eq!(
            min,
            SparkShellInput::TmuxPane {
                pane_id: "%11".to_string(),
                tail_lines: 100
            }
        );
        assert_eq!(
            max,
            SparkShellInput::TmuxPane {
                pane_id: "%11".to_string(),
                tail_lines: 1000
            }
        );
    }

    #[test]
    fn rejects_non_numeric_tail_lines() {
        let error =
            parse_input(&strings(&["--tmux-pane", "%11", "--tail-lines", "bogus"])).unwrap_err();
        assert_eq!(
            error.to_string(),
            "--tail-lines must be an integer between 100 and 1000"
        );
    }

    #[test]
    fn rejects_missing_tail_lines_value() {
        let error = parse_input(&strings(&["--tmux-pane", "%11", "--tail-lines"])).unwrap_err();
        assert_eq!(error.to_string(), "--tail-lines requires a numeric value");
    }
}
