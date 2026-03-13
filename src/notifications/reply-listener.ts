/**
 * Reply Listener Daemon
 *
 * Background daemon that polls Discord and Telegram for replies to notification messages,
 * sanitizes input, verifies the target pane, and injects reply text via sendToPane().
 *
 * Security considerations:
 * - State/PID/log files use restrictive permissions (0600)
 * - Bot tokens stored in state file, NOT in environment variables
 * - Two-layer input sanitization (sanitizeReplyInput + newline stripping in buildSendPaneArgvs)
 * - Pane verification via analyzePaneContent before every injection
 * - Authorization: only configured user IDs (Discord) / chat ID (Telegram) can inject
 * - Rate limiting to prevent spam/abuse
 */

import { spawn, spawnSync } from "child_process";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";
import { resolveRuntimeBinaryPath } from "../cli/runtime-native.js";
import { isTmuxAvailable } from "./tmux-detector.js";
import type { ReplyConfig } from "./types.js";

const SECURE_FILE_MODE = 0o600;
const MAX_LOG_SIZE_BYTES = 1 * 1024 * 1024;

const DAEMON_ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"USERPROFILE",
	"USER",
	"USERNAME",
	"LOGNAME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TERM",
	"TMUX",
	"TMUX_PANE",
	"TMPDIR",
	"TMP",
	"TEMP",
	"XDG_RUNTIME_DIR",
	"XDG_DATA_HOME",
	"XDG_CONFIG_HOME",
	"SHELL",
	"NODE_ENV",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"http_proxy",
	"https_proxy",
	"NO_PROXY",
	"no_proxy",
	"SystemRoot",
	"SYSTEMROOT",
	"windir",
	"COMSPEC",
	"OMX_RUNTIME_REPLY_LISTENER_NATIVE",
	"OMX_RUNTIME_REPLY_LISTENER_LIVE_SEND",
] as const;

const DEFAULT_STATE_DIR = join(homedir(), ".omx", "state");
const PID_FILE_PATH = join(DEFAULT_STATE_DIR, "reply-listener.pid");
const STATE_FILE_PATH = join(DEFAULT_STATE_DIR, "reply-listener-state.json");
const LOG_FILE_PATH = join(DEFAULT_STATE_DIR, "reply-listener.log");
const MIN_REPLY_POLL_INTERVAL_MS = 500;
const MAX_REPLY_POLL_INTERVAL_MS = 60_000;
const DEFAULT_REPLY_POLL_INTERVAL_MS = 3_000;
const MIN_REPLY_RATE_LIMIT_PER_MINUTE = 1;
const DEFAULT_REPLY_RATE_LIMIT_PER_MINUTE = 10;
const MIN_REPLY_MAX_MESSAGE_LENGTH = 1;
const MAX_REPLY_MAX_MESSAGE_LENGTH = 4_000;
const DEFAULT_REPLY_MAX_MESSAGE_LENGTH = 500;

export interface ReplyListenerState {
	isRunning: boolean;
	pid: number | null;
	startedAt: string | null;
	lastPollAt: string | null;
	telegramLastUpdateId: number | null;
	discordLastMessageId: string | null;
	messagesInjected: number;
	errors: number;
	lastError?: string;
}

export interface ReplyListenerDaemonConfig extends ReplyConfig {
	telegramEnabled?: boolean;
	telegramBotToken?: string;
	telegramChatId?: string;
	discordEnabled?: boolean;
	discordBotToken?: string;
	discordChannelId?: string;
	discordMention?: string;
}

export interface DaemonResponse {
	success: boolean;
	message: string;
	state?: ReplyListenerState;
	error?: string;
}

interface ShouldUseNativeReplyListenerStartOptions {
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	resolveRuntimeBinaryPathFn?: typeof resolveRuntimeBinaryPath;
}

function createMinimalDaemonEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of DAEMON_ENV_ALLOWLIST) {
		if (process.env[key] !== undefined) {
			env[key] = process.env[key];
		}
	}
	return env;
}

export function shouldUseNativeReplyListenerStart(
	options: ShouldUseNativeReplyListenerStartOptions = {},
): boolean {
	const env = options.env ?? process.env;
	if (env.OMX_RUNTIME_REPLY_LISTENER_NATIVE === "1") return true;

	try {
		(options.resolveRuntimeBinaryPathFn ?? resolveRuntimeBinaryPath)({
			cwd: options.cwd ?? process.cwd(),
			env,
		});
		return true;
	} catch {
		throw new Error("native reply-listener runtime unavailable");
	}
}

function ensureStateDir(): void {
	if (!existsSync(DEFAULT_STATE_DIR)) {
		mkdirSync(DEFAULT_STATE_DIR, { recursive: true, mode: 0o700 });
	}
}

function writeSecureFile(filePath: string, content: string): void {
	ensureStateDir();
	writeFileSync(filePath, content, { mode: SECURE_FILE_MODE });
	try {
		chmodSync(filePath, SECURE_FILE_MODE);
	} catch {
		// Ignore permission errors
	}
}

function rotateLogIfNeeded(logPath: string): void {
	try {
		if (!existsSync(logPath)) return;
		const stats = statSync(logPath);
		if (stats.size > MAX_LOG_SIZE_BYTES) {
			const backupPath = `${logPath}.old`;
			if (existsSync(backupPath)) {
				unlinkSync(backupPath);
			}
			renameSync(logPath, backupPath);
		}
	} catch {
		// Ignore rotation errors
	}
}

function log(message: string): void {
	try {
		ensureStateDir();
		rotateLogIfNeeded(LOG_FILE_PATH);
		const timestamp = new Date().toISOString();
		const logLine = `[${timestamp}] ${message}\n`;
		appendFileSync(LOG_FILE_PATH, logLine, { mode: SECURE_FILE_MODE });
	} catch {
		// Ignore log write errors
	}
}

function normalizeInteger(
	value: unknown,
	fallback: number,
	min: number,
	max?: number,
): number {
	const numeric =
		typeof value === "number"
			? Math.trunc(value)
			: typeof value === "string" && value.trim()
				? Number.parseInt(value, 10)
				: Number.NaN;
	if (!Number.isFinite(numeric)) return fallback;
	if (numeric < min) return min;
	if (max !== undefined && numeric > max) return max;
	return numeric;
}

export function normalizeReplyListenerConfig(
	config: ReplyListenerDaemonConfig,
): ReplyListenerDaemonConfig {
	const discordEnabled =
		config.discordEnabled ??
		!!(config.discordBotToken && config.discordChannelId);
	const telegramEnabled =
		config.telegramEnabled ??
		!!(config.telegramBotToken && config.telegramChatId);

	return {
		...config,
		discordEnabled,
		telegramEnabled,
		pollIntervalMs: normalizeInteger(
			config.pollIntervalMs,
			DEFAULT_REPLY_POLL_INTERVAL_MS,
			MIN_REPLY_POLL_INTERVAL_MS,
			MAX_REPLY_POLL_INTERVAL_MS,
		),
		rateLimitPerMinute: normalizeInteger(
			config.rateLimitPerMinute,
			DEFAULT_REPLY_RATE_LIMIT_PER_MINUTE,
			MIN_REPLY_RATE_LIMIT_PER_MINUTE,
		),
		maxMessageLength: normalizeInteger(
			config.maxMessageLength,
			DEFAULT_REPLY_MAX_MESSAGE_LENGTH,
			MIN_REPLY_MAX_MESSAGE_LENGTH,
			MAX_REPLY_MAX_MESSAGE_LENGTH,
		),
		includePrefix: config.includePrefix !== false,
		authorizedDiscordUserIds: Array.isArray(config.authorizedDiscordUserIds)
			? config.authorizedDiscordUserIds.filter(
					(id): id is string => typeof id === "string" && id.trim() !== "",
				)
			: [],
	};
}

function readDaemonState(): ReplyListenerState | null {
	try {
		if (!existsSync(STATE_FILE_PATH)) return null;
		const content = readFileSync(STATE_FILE_PATH, "utf-8");
		return JSON.parse(content) as ReplyListenerState;
	} catch {
		return null;
	}
}

function writeDaemonState(state: ReplyListenerState): void {
	writeSecureFile(STATE_FILE_PATH, JSON.stringify(state, null, 2));
}

function writeDaemonConfig(config: ReplyListenerDaemonConfig): void {
	const configPath = join(DEFAULT_STATE_DIR, "reply-listener-config.json");
	writeSecureFile(configPath, JSON.stringify(config, null, 2));
}

function readPidFile(): number | null {
	try {
		if (!existsSync(PID_FILE_PATH)) return null;
		const content = readFileSync(PID_FILE_PATH, "utf-8");
		const trimmed = content.trim();
		const pid = parseInt(trimmed, 10);
		if (!isNaN(pid)) return pid;

		try {
			const parsed = JSON.parse(trimmed) as { pid?: unknown };
			if (typeof parsed.pid === "number" && Number.isFinite(parsed.pid)) {
				return Math.trunc(parsed.pid);
			}
		} catch {
			// Fall through to null when the pid file is neither a plain integer nor JSON.
		}

		return null;
	} catch {
		return null;
	}
}

function writePidFile(pid: number): void {
	writeSecureFile(PID_FILE_PATH, String(pid));
}

function removePidFile(): void {
	if (existsSync(PID_FILE_PATH)) {
		unlinkSync(PID_FILE_PATH);
	}
}

function invokeNativeReplyListenerCommand(
	args: string[],
): DaemonResponse | null {
	try {
		if (!shouldUseNativeReplyListenerStart()) return null;
	} catch {
		return null;
	}

	try {
		const result = spawnSync(
			resolveRuntimeBinaryPath({ cwd: process.cwd(), env: process.env }),
			["reply-listener", ...args],
			{
				encoding: "utf-8",
				timeout: 5000,
				cwd: process.cwd(),
				env: createMinimalDaemonEnv(),
			},
		);

		if (result.error) {
			return {
				success: false,
				message: `Failed to invoke native reply listener ${args.join(" ")}`,
				error: result.error.message,
			};
		}

		const stdout = (result.stdout ?? "").trim();
		const stderr = (result.stderr ?? "").trim();
		if (result.status !== 0) {
			return {
				success: false,
				message: `Native reply listener ${args.join(" ")} failed`,
				error: stderr || stdout || `exit ${result.status}`,
			};
		}

		if (stdout === "") {
			return {
				success: true,
				message: `Native reply listener ${args.join(" ")} completed`,
			};
		}

		const parsed = JSON.parse(stdout) as Partial<DaemonResponse>;
		return {
			success: parsed.success !== false,
			message:
				typeof parsed.message === "string"
					? parsed.message
					: `Native reply listener ${args.join(" ")} completed`,
			state: parsed.state,
			error: typeof parsed.error === "string" ? parsed.error : undefined,
		};
	} catch (error) {
		return {
			success: false,
			message: `Failed to invoke native reply listener ${args.join(" ")}`,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const REPLY_LISTENER_DAEMON_IDENTITY_MARKERS = ["reply-listener"];

/**
 * Verify that the process with the given PID is our reply listener daemon by
 * inspecting its command line for the daemon identity marker. Returns false if
 * the process cannot be positively identified (safe default).
 */
export function isReplyListenerProcess(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	if (pid === process.pid) return false;

	try {
		if (process.platform === "linux") {
			// NUL-separated argv available without spawning a subprocess
			const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
			return REPLY_LISTENER_DAEMON_IDENTITY_MARKERS.some((marker) =>
				cmdline.includes(marker),
			);
		}
		// macOS and other POSIX systems
		const result = spawnSync("ps", ["-p", String(pid), "-o", "args="], {
			encoding: "utf-8",
			timeout: 3000,
		});
		if (result.status !== 0 || result.error) return false;
		const command = result.stdout ?? "";
		return REPLY_LISTENER_DAEMON_IDENTITY_MARKERS.some((marker) =>
			command.includes(marker),
		);
	} catch {
		return false;
	}
}

export function isDaemonRunning(): boolean {
	const pid = readPidFile();
	if (pid === null) return false;

	if (!isProcessRunning(pid)) {
		removePidFile();
		return false;
	}

	if (!isReplyListenerProcess(pid)) {
		removePidFile();
		return false;
	}

	return true;
}

// ============================================================================
// Input Sanitization
// ============================================================================

export function sanitizeReplyInput(text: string): string {
	return text
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "") // Strip control chars (keep \n, \r, \t)
		.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "") // Strip bidi override characters
		.replace(/\r?\n/g, " ") // Newlines -> spaces
		.replace(/\\/g, "\\\\") // Escape backslashes
		.replace(/`/g, "\\`") // Escape backticks
		.replace(/\$\(/g, "\\$(") // Escape $()
		.replace(/\$\{/g, "\\${") // Escape ${}
		.trim();
}

// ============================================================================
// Daemon Control
// ============================================================================

export function startReplyListener(
	config: ReplyListenerDaemonConfig,
): DaemonResponse {
	if (isDaemonRunning()) {
		const state = readDaemonState();
		return {
			success: true,
			message: "Reply listener daemon is already running",
			state: state ?? undefined,
		};
	}

	if (!isTmuxAvailable()) {
		return {
			success: false,
			message: "tmux not available - reply injection requires tmux",
		};
	}

	const normalizedConfig = normalizeReplyListenerConfig(config);
	if (!normalizedConfig.discordEnabled && !normalizedConfig.telegramEnabled) {
		return {
			success: false,
			message: "No enabled reply listener platforms configured",
		};
	}

	writeDaemonConfig(normalizedConfig);
	ensureStateDir();

	try {
		shouldUseNativeReplyListenerStart();

		const child = spawn(
			resolveRuntimeBinaryPath({ cwd: process.cwd(), env: process.env }),
			["reply-listener"],
			{
				detached: true,
				stdio: "ignore",
				cwd: process.cwd(),
				env: createMinimalDaemonEnv(),
			},
		);

		child.unref();

		const pid = child.pid;
		if (pid) {
			writePidFile(pid);

			const state: ReplyListenerState = {
				isRunning: true,
				pid,
				startedAt: new Date().toISOString(),
				lastPollAt: null,
				telegramLastUpdateId: null,
				discordLastMessageId: null,
				messagesInjected: 0,
				errors: 0,
			};
			writeDaemonState(state);
			log(`Reply listener daemon started with PID ${pid}`);

			return {
				success: true,
				message: `Reply listener daemon started with PID ${pid}`,
				state,
			};
		}

		return {
			success: false,
			message: "Failed to start daemon process",
		};
	} catch (error) {
		return {
			success: false,
			message: "Failed to start daemon",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function stopReplyListener(): DaemonResponse {
	const nativeResponse = invokeNativeReplyListenerCommand(["stop"]);
	if (nativeResponse) {
		const state = readDaemonState();
		return {
			...nativeResponse,
			state: nativeResponse.state ?? state ?? undefined,
		};
	}

	const pid = readPidFile();

	if (pid === null) {
		return {
			success: true,
			message: "Reply listener daemon is not running",
		};
	}

	if (!isProcessRunning(pid)) {
		removePidFile();
		return {
			success: true,
			message:
				"Reply listener daemon was not running (cleaned up stale PID file)",
		};
	}

	if (!isReplyListenerProcess(pid)) {
		removePidFile();
		return {
			success: false,
			message: `Refusing to kill PID ${pid}: process identity does not match the reply listener daemon (stale or reused PID - removed PID file)`,
		};
	}

	try {
		process.kill(pid, "SIGTERM");
		removePidFile();

		const state = readDaemonState();
		if (state) {
			state.isRunning = false;
			state.pid = null;
			writeDaemonState(state);
		}

		log(`Reply listener daemon stopped (PID ${pid})`);

		return {
			success: true,
			message: `Reply listener daemon stopped (PID ${pid})`,
			state: state ?? undefined,
		};
	} catch (error) {
		return {
			success: false,
			message: "Failed to stop daemon",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function getReplyListenerStatus(): DaemonResponse {
	const nativeResponse = invokeNativeReplyListenerCommand(["status"]);
	if (nativeResponse) {
		const state = nativeResponse.state ?? readDaemonState() ?? undefined;
		return {
			...nativeResponse,
			state,
		};
	}

	const state = readDaemonState();
	const running = isDaemonRunning();

	if (!running && !state) {
		return {
			success: true,
			message: "Reply listener daemon has never been started",
		};
	}

	if (!running && state) {
		return {
			success: true,
			message: "Reply listener daemon is not running",
			state: { ...state, isRunning: false, pid: null },
		};
	}

	return {
		success: true,
		message: "Reply listener daemon is running",
		state: state ?? undefined,
	};
}
