/**
 * pi-powershell-mini — minimal PowerShell ergonomics for the pi coding agent.
 *
 * Four fixes for the built-in `powershell` tool, no tool replacement:
 *
 *   session_start — swap `bash` for the built-in `powershell` tool (unless the
 *                   user explicitly picked tools), then probe the machine for
 *                   PowerShell 7 and Microsoft.Coreutils and warn with a winget
 *                   hint when either is missing. Result cached for 24 h.
 *   tool_call     — prepend a one-line preamble (English messages, no ANSI) and
 *                   apply the configured default timeout when the model omits
 *                   one, remembering that the value was injected.
 *   tool_result   — strip escape sequences, correct the line numbers that pi's
 *                   own preamble shifts, optionally compact error blocks,
 *                   annotate a timeout that the injected default caused, and
 *                   rescue parse errors (which pi otherwise reports as silence).
 *
 *   /psmini [format clean|compact|native] [timeout N|off] [swap on|off]
 *           [culture en-US] [preflight]        — status when called bare
 *
 * Config: ~/.pi/agent/powershell-mini.json, read on every call.
 */
import { getPowerShellConfig, isPowerShellToolResult, isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Tunables ────────────────────────────────────────────────────────────
const AGENT_DIR = join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "powershell-mini.json");
/** pi prepends `[Console]::OutputEncoding=…` as one line; we prepend one more. */
const PI_PREAMBLE_LINES = 1;
const PROBE_TIMEOUT_MS = 20_000;
const STATUS_NOTE = "Command timed out after";

type Format = "clean" | "compact" | "native";

// ── Config ──────────────────────────────────────────────────────────────
interface Preflight {
	/** epoch ms of the probe */
	at: number;
	shell: string;
	major: number;
	/** path to ls.exe when coreutils was found, null otherwise */
	coreutils: string | null;
}

interface PsMiniConfig {
	format?: Format;
	/** injected when the model passes no timeout; 0 disables the injection */
	timeoutSeconds?: number;
	timeoutNote?: boolean;
	swapTools?: boolean;
	/** hours a preflight result stays valid; <= 0 disables the probe */
	preflightHours?: number;
	culture?: string;
	parseRescue?: boolean;
	preflight?: Preflight;
}

const DEFAULTS = {
	format: "clean" as Format,
	timeoutSeconds: 120,
	timeoutNote: true,
	swapTools: true,
	preflightHours: 24,
	culture: "en-US",
	parseRescue: true,
};

async function readConfig(): Promise<PsMiniConfig> {
	try {
		return JSON.parse(await readFile(CONFIG_PATH, "utf8")) as PsMiniConfig;
	} catch {
		return {};
	}
}

async function writeConfig(patch: Partial<PsMiniConfig>): Promise<void> {
	const merged = { ...(await readConfig()), ...patch };
	await mkdir(AGENT_DIR, { recursive: true });
	await writeFile(CONFIG_PATH, JSON.stringify(merged, null, "\t") + "\n", "utf8");
}

const CULTURE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

function cultureOf(config: PsMiniConfig): string {
	const culture = config.culture ?? DEFAULTS.culture;
	return CULTURE_RE.test(culture) ? culture : DEFAULTS.culture;
}

function formatOf(config: PsMiniConfig): Format {
	return config.format === "compact" || config.format === "native" ? config.format : "clean";
}

function timeoutSecondsOf(config: PsMiniConfig): number {
	const value = config.timeoutSeconds;
	if (value === 0) return 0;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULTS.timeoutSeconds;
}

// ── Preamble ────────────────────────────────────────────────────────────
/** One line, so the error-output line offset stays a known constant (2). */
function preambleLine(culture: string): string {
	return `$PSStyle.OutputRendering='PlainText';[System.Threading.Thread]::CurrentThread.CurrentUICulture='${culture}'`;
}

const PREAMBLE_MARKER = "[System.Threading.Thread]::CurrentThread.CurrentUICulture";

/** Split a (mutated) command into the script the model wrote and its offset. */
function splitCommand(command: string, culture: string): { script: string; offset: number } {
	const normalized = command.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	const ours = lines[0]?.includes(PREAMBLE_MARKER) && lines[0].includes(preambleLine(culture)) ? 1 : 0;
	return { script: ours ? lines.slice(1).join("\n") : normalized, offset: PI_PREAMBLE_LINES + ours };
}

// ── Output cleaning ─────────────────────────────────────────────────────
const ANSI_RE = /\u001B\[[0-9;?:]*[ -/]*[@-~]|\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
const NUMBERED = /^(\s*)(\d+)( \|)(?: |$)/;
const NUMBER_TOKEN = /^(\s*)(\d+)( \|)/;
const PLAIN = /^(\s*)\|(?: |$)/;
const DECORATION = /^[~^ ]+$/;

function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

/**
 * Rewrite error blocks. Line numbers in PowerShell's `Line |` frames are absolute
 * positions in the `-Command` string, so both pi's preamble and ours shift them.
 * Numbers are corrected only when the echoed source line matches the model's own
 * script — file and module errors carry their own numbering and must be left alone.
 */
function formatResult(text: string, script: string | undefined, offset: number, format: Format): string {
	const scriptLines = script?.replace(/\r\n/g, "\n").split("\n");
	const lines = text.split("\n");
	const out: string[] = [];

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i]!;
		if (line !== "Line |") {
			out.push(line);
			continue;
		}

		const header = out.length > 0 ? out[out.length - 1]! : "";
		const headerMatch = /^(\S[^:]*):(\s*)(.*)$/.exec(header);
		const name = headerMatch ? headerMatch[1]! : "";
		// `Get-Item: C:\p\x.ps1:2` — a file error. Its numbers belong to the file.
		const suffix = headerMatch ? headerMatch[3]!.trim() : "";

		const body: string[] = [];
		let j = i + 1;
		while (j < lines.length) {
			const candidate = lines[j]!;
			if (NUMBERED.test(candidate) || PLAIN.test(candidate)) {
				body.push(candidate);
				j += 1;
				continue;
			}
			break;
		}
		if (body.length === 0) {
			out.push(line);
			continue;
		}
		i = j - 1;

		let numberedAt = -1;
		let digits = "";
		let source = "";
		const messages: string[] = [];
		for (let k = 0; k < body.length; k += 1) {
			const entry = body[k]!;
			const numbered = NUMBERED.exec(entry);
			if (numbered && numberedAt === -1) {
				numberedAt = k;
				digits = numbered[2]!;
				source = entry.replace(NUMBERED, "").trim();
				continue;
			}
			const plain = PLAIN.exec(entry);
			const payload = plain ? entry.replace(PLAIN, "") : "";
			if (payload && DECORATION.test(payload)) continue;
			if (payload.trim()) messages.push(payload.trim());
		}

		const original = numberedAt >= 0 ? Number(digits) : NaN;
		let corrected: number | undefined;
		if (Number.isFinite(original) && suffix === "" && scriptLines && original - offset >= 1) {
			const expected = scriptLines[original - offset - 1];
			if (expected !== undefined && matchesSource(expected, source)) corrected = original - offset;
		}

		if (format === "compact" && name) {
			out.pop(); // the header line becomes part of the single compact line
			const where = suffix
				? suffix.replace(/^.*[\\/]/, "")
				: corrected !== undefined
					? `line ${corrected}`
					: `pwsh line ${original}`;
			out.push(`${name} @${where}: ${messages.join(" ").trim() || "(error)"}`);
			continue;
		}

		if (format !== "native" && corrected !== undefined && numberedAt >= 0) {
			body[numberedAt] = body[numberedAt]!.replace(
				NUMBER_TOKEN,
				(_match, pad: string, width: string, tail: string) => pad + String(corrected).padStart(width.length) + tail,
			);
		}
		out.push(line, ...body);
	}

	return out.join("\n");
}

/** pwsh truncates long source lines with ` …`, so compare the visible prefix. */
function matchesSource(expected: string, echoed: string): boolean {
	const want = expected.trim();
	const got = echoed.trim().replace(/\s*(?:…|\.\.\.)$/, "").trim();
	return want === got || (got.length > 0 && want.startsWith(got));
}

/** Tell the model that the timeout it never passed was ours. */
function annotateInjectedTimeout(text: string, injected: number): string {
	const pattern = /Command timed out after ([\d.]+) seconds\s*$/;
	return text.replace(pattern, (match, seconds: string) =>
		Number(seconds) === injected
			? `${match} (default timeout applied — none was passed; rerun with an explicit timeout if it needs longer)`
			: match,
	);
}

const STATUS_LINE =
	/\n*(?:Command (?:exited with code -?\d+|timed out after [\d.]+ seconds|aborted|terminated without an exit code))\s*$/;

/** True when the only content left is pi's own status line (plus its empty-output placeholder). */
function isStatusOnly(text: string): boolean {
	const residual = text.replace(STATUS_LINE, "").trim().toLowerCase();
	return residual === "" || residual === "(no output)";
}

// ── Child processes ─────────────────────────────────────────────────────
function runCommand(command: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
	return new Promise((resolve) => {
		execFile(command, args, { encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
			const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? -1 : 0;
			resolve({ code, out: `${stdout ?? ""}${stderr ?? ""}` });
		});
	});
}

/**
 * Parse errors abort the whole `-Command` before anything runs, so they cannot be
 * caught inline; pwsh then prints them to a stream pi never reads, and the model
 * sees "exit 1" with no output. Re-parse the model's script in a separate process
 * (passed as base64 to dodge every quoting rule) and surface the message.
 */
async function rescueParseError(script: string, culture: string): Promise<string | undefined> {
	const { shell, args } = getPowerShellConfig();
	const encoded = Buffer.from(script, "utf8").toString("base64");
	const probe = [
		preambleLine(culture),
		`$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
		"try { [void][scriptblock]::Create($t) } catch { $e = $_.Exception.InnerException; if (-not $e) { $e = $_.Exception }; [Console]::Error.WriteLine($e.Message); exit 1 }",
	].join("\n");
	const { out } = await runCommand(shell, [...args, probe], PROBE_TIMEOUT_MS);
	return out.trim() || undefined;
}

async function preflightNow(culture: string): Promise<Preflight> {
	const { shell, args } = getPowerShellConfig();
	const probe = [
		preambleLine(culture),
		'"$($PSVersionTable.PSVersion.Major)|$((Get-Command ls.exe -ErrorAction Ignore).Source)|$((Get-Command grep.exe -ErrorAction Ignore).Source)"',
	].join("\n");
	const { out } = await runCommand(shell, [...args, probe], PROBE_TIMEOUT_MS);
	const [major, ls, grep] = out.trim().split("|");
	const coreutils = [ls, grep].every((path) => !!path && path.toLowerCase().includes("coreutils"));
	return { at: Date.now(), shell, major: Number(major) || 0, coreutils: coreutils ? ls! : null };
}

function problemsOf(preflight: Preflight): string[] {
	const problems: string[] = [];
	if (preflight.major < 7) {
		problems.push(
			`PowerShell 7 required (found ${preflight.shell}${preflight.major ? ` v${preflight.major}` : ""}) — winget install --id Microsoft.PowerShell`,
		);
	}
	if (!preflight.coreutils) {
		problems.push("Microsoft.Coreutils not found (ls.exe/grep.exe) — winget install --id Microsoft.Coreutils");
	}
	return problems;
}

function ageLabel(at: number): string {
	const minutes = Math.round((Date.now() - at) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 120) return `${minutes} min ago`;
	return `${Math.round(minutes / 60)} h ago`;
}

// ── Extension ───────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
	/** toolCallId → default timeout we injected for it, so the note is truthful. */
	const injected = new Map<string, number>();

	pi.on("session_start", async (_event, ctx) => {
		if (process.platform !== "win32") return;
		injected.clear();
		const config = await readConfig();

		if (config.swapTools ?? DEFAULTS.swapTools) {
			const active = pi.getActiveTools();
			// Leaving `bash` active but adding `powershell` only halves the problem:
			// the model would keep reaching for bash. Respect an explicit `--tools`.
			if (active.includes("bash") && !active.includes("powershell")) {
				pi.setActiveTools([...active.filter((name) => name !== "bash"), "powershell"]);
				ctx.ui.notify("pi-powershell-mini: bash tool replaced by the built-in powershell tool", "info");
			}
		}

		const hours = config.preflightHours ?? DEFAULTS.preflightHours;
		if (hours <= 0) return;
		const cached = config.preflight;
		const fresh = cached !== undefined && Date.now() - cached.at < hours * 3_600_000;
		const preflight = fresh ? cached : await preflightNow(cultureOf(config));
		if (!fresh) await writeConfig({ preflight });
		const problems = problemsOf(preflight);
		if (problems.length > 0) ctx.ui.notify(`pi-powershell-mini: ${problems.join(" · ")}`, "warning");
	});

	pi.on("tool_call", async (event) => {
		if (!isToolCallEventType("powershell", event)) return;
		const config = await readConfig();
		const culture = cultureOf(config);

		const preamble = preambleLine(culture);
		if (!event.input.command.split("\n")[0]?.includes(PREAMBLE_MARKER)) {
			event.input.command = `${preamble}\n${event.input.command}`;
		}

		if (event.input.timeout === undefined || event.input.timeout === null) {
			const seconds = timeoutSecondsOf(config);
			if (seconds > 0) {
				event.input.timeout = seconds;
				injected.set(event.toolCallId, seconds);
			}
		}
	});

	pi.on("tool_result", async (event) => {
		if (!isPowerShellToolResult(event)) return;
		const config = await readConfig();
		const culture = cultureOf(config);
		const format = formatOf(config);
		const injectedSeconds = injected.get(event.toolCallId);
		if (injectedSeconds !== undefined) injected.delete(event.toolCallId);

		const command = typeof event.input.command === "string" ? event.input.command : undefined;
		const { script, offset } = command ? splitCommand(command, culture) : { script: undefined, offset: PI_PREAMBLE_LINES + 1 };

		let lastText = -1;
		event.content.forEach((part, index) => {
			if (part.type === "text") lastText = index;
		});

		const content = event.content.map((part, index) => {
			if (part.type !== "text") return part;
			let text = formatResult(stripAnsi(part.text.replace(/\r\n/g, "\n")), script, offset, format);
			if (index === lastText && injectedSeconds !== undefined && (config.timeoutNote ?? DEFAULTS.timeoutNote)) {
				text = annotateInjectedTimeout(text, injectedSeconds);
			}
			return text === part.text ? part : { ...part, text };
		});

		const joined = content
			.filter((part) => part.type === "text")
			.map((part) => (part as { text: string }).text)
			.join("");
		if ((config.parseRescue ?? DEFAULTS.parseRescue) && event.isError && script && isStatusOnly(joined)) {
			const rescued = await rescueParseError(script, culture);
			if (rescued) {
				const target = lastText >= 0 ? content[lastText] as { type: "text"; text: string } : undefined;
				if (target) content[lastText] = { ...target, text: `${rescued}\n\n${target.text.replace(/^\(no output\)\n+/, "")}` };
				else content.push({ type: "text", text: rescued });
			}
		}

		const changed = content.some((part, index) => part !== event.content[index]);
		if (!changed) return;
		// Keep structured content: programmatic callers get the unformatted text.
		return { content, structuredContent: event.structuredContent };
	});

	pi.registerCommand("psmini", {
		description: "Show or change pi-powershell-mini settings",
		getArgumentCompletions: (prefix) => {
			const words = ["format", "timeout", "swap", "culture", "preflight"];
			const hits = words.filter((word) => word.startsWith(prefix));
			return hits.length > 0 ? hits.map((word) => ({ value: word, label: word })) : null;
		},
		handler: async (args, ctx) => {
			const [key, value] = args.trim().split(/\s+/);
			const config = await readConfig();

			if (!key) {
				const preflight = config.preflight;
				const lines = [
					`format: ${formatOf(config)} · timeout: ${timeoutSecondsOf(config) || "off"}${timeoutSecondsOf(config) ? " s (injected when omitted)" : ""} · swap: ${config.swapTools ?? DEFAULTS.swapTools ? "on" : "off"} · rescue: ${config.parseRescue ?? DEFAULTS.parseRescue ? "on" : "off"} · culture: ${cultureOf(config)}`,
					preflight
						? `preflight: pwsh ${preflight.major || "?"} · coreutils ${preflight.coreutils ? "ok" : "missing"} (${ageLabel(preflight.at)})`
						: "preflight: not run yet",
				];
				const problems = preflight ? problemsOf(preflight) : [];
				ctx.ui.notify(lines.join("\n"), problems.length > 0 ? "warning" : "info");
				return;
			}

			switch (key) {
				case "format": {
					if (value !== "clean" && value !== "compact" && value !== "native") {
						ctx.ui.notify(`format: ${formatOf(config)} (usage: /psmini format clean|compact|native)`, "info");
						return;
					}
					await writeConfig({ format: value });
					ctx.ui.notify(`format set to ${value}`, "info");
					return;
				}
				case "timeout": {
					if (value === "off" || value === "0") {
						await writeConfig({ timeoutSeconds: 0 });
						ctx.ui.notify("default timeout injection disabled", "warning");
						return;
					}
					const seconds = Number(value);
					if (!Number.isFinite(seconds) || seconds <= 0) {
						ctx.ui.notify(`timeout: ${timeoutSecondsOf(config) || "off"} (usage: /psmini timeout 120|off)`, "info");
						return;
					}
					await writeConfig({ timeoutSeconds: Math.floor(seconds) });
					ctx.ui.notify(`default timeout set to ${Math.floor(seconds)} s`, "info");
					return;
				}
				case "swap": {
					if (value !== "on" && value !== "off") {
						ctx.ui.notify(`swap: ${config.swapTools ?? DEFAULTS.swapTools ? "on" : "off"} (usage: /psmini swap on|off)`, "info");
						return;
					}
					await writeConfig({ swapTools: value === "on" });
					ctx.ui.notify(`tool swap ${value} (applies at next session start)`, "info");
					return;
				}
				case "culture": {
					if (!value || !CULTURE_RE.test(value)) {
						ctx.ui.notify(`culture: ${cultureOf(config)} (usage: /psmini culture en-US)`, "info");
						return;
					}
					await writeConfig({ culture: value });
					ctx.ui.notify(`culture set to ${value}`, "info");
					return;
				}
				case "preflight": {
					const preflight = await preflightNow(cultureOf(config));
					await writeConfig({ preflight });
					const problems = problemsOf(preflight);
					ctx.ui.notify(
						`pwsh ${preflight.major || "?"} at ${preflight.shell} · coreutils ${preflight.coreutils ? "ok" : "missing"}${problems.length > 0 ? `\n${problems.join("\n")}` : ""}`,
						problems.length > 0 ? "warning" : "info",
					);
					return;
				}
				default:
					ctx.ui.notify(`unknown option "${key}" (format, timeout, swap, culture, preflight)`, "error");
			}
		},
	});
}
