# pi-powershell-mini

Minimal PowerShell ergonomics for the [pi coding agent](https://pi.dev) on Windows. Four fixes for the built-in `powershell` tool — no tool replacement, no runtime dependencies.

```
session_start  swap bash → powershell, probe pwsh 7 + Microsoft.Coreutils (cached 24 h)
tool_call      English messages, no ANSI, default timeout when the model omits one
tool_result    strip escapes, fix line numbers, optional compaction, timeout note, parse rescue

/psmini                       status
/psmini format clean|compact|native
/psmini timeout 120|off       default timeout injection
/psmini swap on|off           bash → powershell replacement
/psmini culture en-US
/psmini preflight             re-probe pwsh 7 and coreutils now
```

## Why

The stock tool hands the model whatever pwsh prints: `ConciseView` frames full of ESC sequences, messages in the Windows UI language (Russian here), line numbers shifted by pi's own injected preamble, silent syntax errors, and no timeout unless the model remembers one.

| Problem | Fix |
|---|---|
| Messages in the OS display language | one-line preamble sets `CurrentUICulture` to `en-US` for pwsh's own resource lookups (verified: engine and provider messages switch, `.NET` messages were already English) |
| ANSI escapes in the model's context | `$PSStyle.OutputRendering='PlainText'` plus a defensive strip (native tools can still force color) |
| Wrong line numbers | pwsh reports absolute lines of the `-Command` string, so pi's preamble (+1) and ours (+1) shift them. Numbers are corrected by 2 — only when the echoed source line matches the model's own script, so file/module errors keep their own numbering |
| Silent syntax errors | parse errors abort the whole `-Command` before anything runs and pi reads nothing. On `exit ≠ 0` + empty output the script is re-parsed in a second process (sent as base64) and the English `At line:N char:M` message is surfaced |
| Unbounded calls | when the model omits `timeout`, the configured default is injected. If that default is what fired, the error says so — the model's own call record never shows the injected value |

## Formats

| mode | output |
|---|---|
| `clean` (default) | native `Line \|` layout, ANSI stripped, line numbers corrected |
| `compact` | one line per error: `Get-Item @line 1: A parameter cannot be found …` |
| `native` | escape sequences stripped only; numbers left as pwsh printed them (debugging) |

`clean` keeps the shape models were trained on and removes the noise. `compact` is ~55% smaller per error block — worth trying when context is tight; it drops the echoed source line, which the model already has in its own tool call.

## Timeout note

```
Command timed out after 120 seconds (default timeout applied — none was passed; rerun with an explicit timeout if it needs longer)
```

Injected only when `timeout` is absent, remembered per call id so the wording stays truthful (an explicit `timeout: 120` is never annotated). `0` disables injection.

## Config

`~/.pi/agent/powershell-mini.json`, read on every call, so edits apply without `/reload`.

| key | type | default | meaning |
|---|---|---|---|
| `format` | `clean` \| `compact` \| `native` | `clean` | error-block rendering |
| `timeoutSeconds` | number (`0` = off) | `120` | injected when the model passes no `timeout` |
| `timeoutNote` | boolean | `true` | annotate a timeout the injected default caused |
| `swapTools` | boolean | `true` | replace an active `bash` tool with `powershell` at session start |
| `preflightHours` | number (`<= 0` = off) | `24` | how long a pwsh/coreutils probe stays valid |
| `culture` | BCP-47 tag | `en-US` | `CurrentUICulture` used for pwsh's own messages |
| `parseRescue` | boolean | `true` | re-parse a failed script to surface syntax errors |
| `preflight` | object | — | probe cache, written by the extension (see below) |

Example:

```json
{
  "format": "clean",
  "timeoutSeconds": 120,
  "timeoutNote": true,
  "swapTools": true,
  "preflightHours": 24,
  "culture": "en-US",
  "parseRescue": true
}
```

### Default safety

- **No file is required.** A missing file, or any key missing from it, uses the defaults above. A partial config such as `{"format": "compact"}` changes exactly one thing.
- **Only explicit keys pin a value.** Defaults are computed at read time, so a key you never wrote follows future default changes; a key you wrote keeps your value.
- **`/psmini` writes only the key you name** and merges with the existing JSON, so keys you added by hand survive.
- **Invalid values fall back silently** — `"format": "pretty"`, `"timeoutSeconds": "60"` or `"culture": "english"` degrade to the default instead of erroring. A malformed JSON file is treated as an empty config, so one stray character reverts *everything* to defaults; check with `/psmini` when a setting seems ignored.
- **`timeoutSeconds: 0`** is the explicit off switch, not a fallback.
- **The extension does create this file on first run**, with only the `preflight` probe cache in it — no user setting is ever written unless you ask for it. Set `preflightHours: 0` to stop the probe; the cached block then simply goes stale and unused.

### Preflight cache

```json
{ "preflight": { "at": 1730000000000, "shell": "C:\\…\\pwsh.exe", "major": 7, "coreutils": "C:\\…\\coreutils\\bin\\ls.exe" } }
```

Written at session start when missing or older than `preflightHours`. `/psmini preflight` re-runs it on demand; the probe costs ~235 ms.

## Install

```bash
pi install D:/Home/pi-powershell-mini
```

Once installed, `"defaultTools": ["-bash", "+powershell"]` in `settings.json` is redundant — the extension swaps the tool itself and leaves an explicit `--tools` selection alone. The swap only removes `bash` when `powershell` is not already active.

## Limits

- `!` / `!!` commands use Git Bash and are untouched.
- Wrong by design for commands that print their own `N |` blocks, and for output that pi truncated (a block cut in half loses its header, so the guard skips it).
- Number correction assumes one injected preamble line; if pi ever changes its own prefix, `PI_PREAMBLE_LINES` needs updating.
- Inert on non-Windows.
