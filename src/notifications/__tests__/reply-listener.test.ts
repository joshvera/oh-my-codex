import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	getReplyListenerStatus,
	isReplyListenerProcess,
	normalizeReplyListenerConfig,
	sanitizeReplyInput,
	shouldUseNativeReplyListenerStart,
	stopReplyListener,
} from "../reply-listener.js";

const stateDir = join(homedir(), ".omx", "state");
const pidFilePath = join(stateDir, "reply-listener.pid");
const stateFilePath = join(stateDir, "reply-listener-state.json");
const runtimeBinEnvName = "OMX_RUNTIME_BIN";
const runtimeNativeEnvName = "OMX_RUNTIME_REPLY_LISTENER_NATIVE";

const originalRuntimeBin = process.env[runtimeBinEnvName];
const originalRuntimeNative = process.env[runtimeNativeEnvName];

function backupFile(filePath: string): string | null {
	return existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
}

function restoreFile(filePath: string, content: string | null): void {
	if (content === null) {
		if (existsSync(filePath)) unlinkSync(filePath);
		return;
	}
	writeFileSync(filePath, content);
}

describe("guarded native reply-listener lifecycle", () => {
	let tmpDir = "";
	let runtimeStubPath = "";
	let pidBackup: string | null = null;
	let stateBackup: string | null = null;

	beforeEach(() => {
		mkdirSync(stateDir, { recursive: true });
		pidBackup = backupFile(pidFilePath);
		stateBackup = backupFile(stateFilePath);

		tmpDir = mkdtempSync(join(tmpdir(), "omx-reply-listener-"));
		runtimeStubPath = join(tmpDir, "omx-runtime");
		writeFileSync(
			runtimeStubPath,
			`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.HOME || '';
const stateDir = path.join(home, '.omx', 'state');
const pidPath = path.join(stateDir, 'reply-listener.pid');
const statePath = path.join(stateDir, 'reply-listener-state.json');
const args = process.argv.slice(2);
if (args[0] !== 'reply-listener') process.exit(2);
if (args[1] === 'status') {
  process.stdout.write(JSON.stringify({
    success: true,
    message: 'Reply listener daemon status',
    state: {
      isRunning: true,
      pid: 4321,
      startedAt: 'native-start',
      lastPollAt: 'native-poll',
      telegramLastUpdateId: null,
      discordLastMessageId: null,
      messagesInjected: 2,
      errors: 0
    }
  }));
  process.exit(0);
}
if (args[1] === 'stop') {
  fs.mkdirSync(stateDir, { recursive: true });
  if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
  fs.writeFileSync(statePath, JSON.stringify({
    isRunning: false,
    pid: null,
    startedAt: 'native-start',
    lastPollAt: 'native-stop',
    telegramLastUpdateId: null,
    discordLastMessageId: null,
    messagesInjected: 2,
    errors: 0
  }));
  process.stdout.write(JSON.stringify({
    success: true,
    message: 'Reply listener daemon stopped (PID 4321)'
  }));
  process.exit(0);
}
process.exit(3);
`,
		);
		chmodSync(runtimeStubPath, 0o755);
		process.env[runtimeNativeEnvName] = "1";
		process.env[runtimeBinEnvName] = runtimeStubPath;
	});

	afterEach(() => {
		restoreFile(pidFilePath, pidBackup);
		restoreFile(stateFilePath, stateBackup);
		delete process.env[runtimeBinEnvName];
		delete process.env[runtimeNativeEnvName];
		if (originalRuntimeBin) process.env[runtimeBinEnvName] = originalRuntimeBin;
		if (originalRuntimeNative)
			process.env[runtimeNativeEnvName] = originalRuntimeNative;
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	});

	it("uses native status command on the guarded path", () => {
		const response = getReplyListenerStatus();
		assert.equal(response.success, true);
		assert.equal(response.message, "Reply listener daemon status");
		assert.equal(response.state?.pid, 4321);
		assert.equal(response.state?.lastPollAt, "native-poll");
	});

	it("uses native stop command on the guarded path", () => {
		writeFileSync(pidFilePath, "4321\n");
		const response = stopReplyListener();
		assert.equal(response.success, true);
		assert.equal(response.message, "Reply listener daemon stopped (PID 4321)");
		assert.equal(response.state?.isRunning, false);
		assert.equal(response.state?.pid, null);
		assert.equal(response.state?.lastPollAt, "native-stop");
	});
});

describe("shouldUseNativeReplyListenerStart", () => {
	it("prefers native when explicitly enabled", () => {
		assert.equal(
			shouldUseNativeReplyListenerStart({
				env: { OMX_RUNTIME_REPLY_LISTENER_NATIVE: "1" },
				resolveRuntimeBinaryPathFn: () => {
					throw new Error("should not resolve");
				},
			}),
			true,
		);
	});

	it("defaults to native when a runtime binary is available", () => {
		assert.equal(
			shouldUseNativeReplyListenerStart({
				env: {},
				resolveRuntimeBinaryPathFn: () => "/tmp/omx-runtime",
			}),
			true,
		);
	});

	it("throws when native runtime cannot be resolved", () => {
		assert.throws(
			() =>
				shouldUseNativeReplyListenerStart({
					env: {},
					resolveRuntimeBinaryPathFn: () => {
						throw new Error("missing");
					},
				}),
			/native reply-listener runtime unavailable/,
		);
	});
});

describe("sanitizeReplyInput", () => {
	it("passes through normal text", () => {
		assert.equal(sanitizeReplyInput("hello world"), "hello world");
	});

	it("strips control characters", () => {
		assert.equal(sanitizeReplyInput("hello\x00world"), "helloworld");
		assert.equal(sanitizeReplyInput("test\x07bell"), "testbell");
		assert.equal(sanitizeReplyInput("test\x1bescseq"), "testescseq");
	});

	it("replaces newlines with spaces", () => {
		assert.equal(sanitizeReplyInput("line1\nline2"), "line1 line2");
		assert.equal(sanitizeReplyInput("line1\r\nline2"), "line1 line2");
	});

	it("escapes backslashes", () => {
		assert.equal(sanitizeReplyInput("path\\to\\file"), "path\\\\to\\\\file");
	});

	it("escapes backticks", () => {
		assert.equal(sanitizeReplyInput("run `cmd`"), "run \\`cmd\\`");
	});

	it("escapes $( command substitution", () => {
		assert.equal(sanitizeReplyInput("$(whoami)"), "\\$(whoami)");
	});

	it("escapes ${ variable expansion", () => {
		assert.equal(sanitizeReplyInput("${HOME}"), "\\${HOME}");
	});

	it("trims whitespace", () => {
		assert.equal(sanitizeReplyInput("  hello  "), "hello");
	});

	it("handles empty string", () => {
		assert.equal(sanitizeReplyInput(""), "");
	});

	it("handles whitespace-only string", () => {
		assert.equal(sanitizeReplyInput("   "), "");
	});

	it("handles combined dangerous patterns", () => {
		const input = "$(rm -rf /) && `evil` ${PATH}\nmore";
		const result = sanitizeReplyInput(input);
		// Should not contain unescaped backticks or newlines
		assert.ok(!result.includes("\n"));
		// $( should be escaped to \$(
		assert.ok(result.includes("\\$("));
		// ${ should be escaped to \${
		assert.ok(result.includes("\\${"));
		// backticks should be escaped
		assert.ok(result.includes("\\`"));
	});

	it("preserves normal special characters", () => {
		assert.equal(sanitizeReplyInput("hello! @user #tag"), "hello! @user #tag");
	});

	it("handles unicode text", () => {
		const result = sanitizeReplyInput("Hello world");
		assert.ok(result.length > 0);
	});
});

describe("isReplyListenerProcess", () => {
	it("returns false for the current process (test runner has no daemon marker)", () => {
		assert.equal(isReplyListenerProcess(process.pid), false);
	});

	it("returns true for a process whose command line contains the daemon marker", (_, done) => {
		const markerDir = mkdtempSync(join(tmpdir(), "omx-reply-listener-marker-"));
		const markerScript = join(markerDir, "reply-listener-marker.js");
		writeFileSync(markerScript, "setInterval(() => {}, 60000);");
		const child = spawn(
			process.execPath,
			[markerScript],
			{ stdio: "ignore" },
		);
		child.once("spawn", () => {
			const pid = child.pid!;
			const result = isReplyListenerProcess(pid);
			child.kill();
			rmSync(markerDir, { recursive: true, force: true });
			assert.equal(result, true);
			done();
		});
		child.once("error", (err) => {
			rmSync(markerDir, { recursive: true, force: true });
			done(err);
		});
	});

	it("returns false for a process whose command line lacks the daemon marker", (_, done) => {
		const child = spawn(
			process.execPath,
			["-e", "setInterval(() => {}, 60000);"],
			{ stdio: "ignore" },
		);
		child.once("spawn", () => {
			const pid = child.pid!;
			const result = isReplyListenerProcess(pid);
			child.kill();
			assert.equal(result, false);
			done();
		});
		child.once("error", (err) => {
			done(err);
		});
	});

	it("returns false for a non-existent PID", () => {
		// PID 0 is never a valid user process
		assert.equal(isReplyListenerProcess(0), false);
	});
});

describe("normalizeReplyListenerConfig", () => {
	it("clamps invalid runtime numeric values and sanitizes authorized users", () => {
		const normalized = normalizeReplyListenerConfig({
			enabled: true,
			pollIntervalMs: 0,
			maxMessageLength: -10,
			rateLimitPerMinute: -1,
			includePrefix: false,
			authorizedDiscordUserIds: ["123", "", "  ", "456"],
			discordEnabled: true,
			discordBotToken: "bot-token",
			discordChannelId: "channel-id",
		});

		assert.equal(normalized.pollIntervalMs, 500);
		assert.equal(normalized.maxMessageLength, 1);
		assert.equal(normalized.rateLimitPerMinute, 1);
		assert.equal(normalized.includePrefix, false);
		assert.deepEqual(normalized.authorizedDiscordUserIds, ["123", "456"]);
	});

	it("infers enabled flags from credentials when omitted", () => {
		const normalized = normalizeReplyListenerConfig({
			enabled: true,
			pollIntervalMs: 3000,
			maxMessageLength: 500,
			rateLimitPerMinute: 10,
			includePrefix: true,
			authorizedDiscordUserIds: [],
			telegramBotToken: "tg-token",
			telegramChatId: "tg-chat",
		});

		assert.equal(normalized.telegramEnabled, true);
		assert.equal(normalized.discordEnabled, false);
	});
});
