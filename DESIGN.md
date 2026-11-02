# DESIGN — bringback5hourlimit

This mod is a local, self-imposed rolling usage cap. It never changes Anthropic's limits, and it makes **no network calls**. Its inputs are the engine's own `rateLimits` and its turn-usage events.

## Files
```
.claude-plugin/plugin.json       manifest + userConfig (all knobs, with defaults)
.claude-plugin/marketplace.json  one-plugin marketplace (source "./")
hooks/hooks.json                 { "modules": ["./register.tsx"] }
hooks/logic.ts                   PURE: config, strategy, block math, budget, merge, formatting, command parsing
hooks/register.tsx               wiring: events → logic → $.store / UI
types/index.d.ts                 $.state contract (the band's view model)
tests/*.test.ts(x)               claude plugin test
```

## Configuration
Precedence: `/5h set` overrides (in `$.store`) > env var > `/config` (`userConfig`) > default.

| Key | Env | Default | Meaning |
|---|---|---|---|
| `windowHours` | `BB5H_WINDOW_HOURS` | `5` | Length of an emulated block (0.25–168 h). |
| `mode` | `BB5H_MODE` | `auto` | `auto` picks the best strategy at runtime. `official`, `weekly` and `tokens` force one. |
| `officialCapPct` | `BB5H_OFFICIAL_CAP_PCT` | `90` | Cap on Anthropic's own 5h % (strategy 1). |
| `weeklyBudgetPct` | `BB5H_BLOCK_BUDGET_PCT_OF_WEEKLY` | `15` | How much weekly % one block may spend (strategy 2). |
| `tokenBudget` | `BB5H_TOKEN_BUDGET` | `10000000` | Weighted tokens per block (strategy 3). |
| `warnPct` | `BB5H_WARN_PCT` | `80` | Warning threshold, in % of the block budget. |
| `failMode` | `BB5H_FAIL_MODE` | `open` | `open` allows and shows a warning; `closed` refuses. |
| `showBar` | `BB5H_SHOW_BAR` | `true` | The band above the prompt. |
| `timeZone` | `BB5H_TIMEZONE` | `""` (system) | IANA zone for reset times. |

Invalid values fall back to the next layer down and are reported in `/5h status`.

## Measuring usage: the strategy chain
`selectStrategy(mode, limits, now)`. In `auto` it takes the first one available:

1. **official**: `five_hour` is present in the latest fresh `rateLimits` snapshot.
   - used = Anthropic's %, budget = `officialCapPct`, reset = Anthropic's `resetsAt`.
   - The block *is* Anthropic's window, so `windowHours` does not apply.
2. **weekly** (verified Ultra): `seven_day` is present and `five_hour` absent.
   - At block start the mod records `weeklyBase` = the latest weekly %.
   - spent = `weeklyCarried + (weeklyLast − weeklyBase)`.
   - If weekly % drops (the weekly window reset mid-block), the spend so far is carried and the baseline is reset to 0.
   - A drop only counts as a reset when usage fell, the window's reset time moved on by over an hour, and the new window began after the block did. A reset time that moves while usage holds or grows is a schedule change. Any other dip is a stale copy (another Claude Code process still holding an older cached reading) and is ignored.
   - Saved readings never go down inside one window: a lower % for the same reset time loses to the higher one, whichever was written last. A copy of a window that had already ended (an idle process's last-window figures) never replaces a live one.
   - `healBlock` repairs any block that carries spend from a reset that can't have happened (written by an older version or a process still running one), and caps carried spend at 100.
   - If no weekly reading exists at block start, the baseline is taken at the first reading inside the block.
   - Budget = `weeklyBudgetPct`. The default of 15 is roughly 6–7 full blocks a week. It is **not** Anthropic's old ratio.
3. **tokens**: no fresh usage data (offline, API changed, API-key use, or forced).
   - Local sum of `turn.complete.usage` across all sessions in the block. Weighted tokens = `input + output + cache_creation + 0.1·cache_read`.
   - Tokens are always counted, whichever strategy is active, so the fallback has data the moment it is needed.

A snapshot is "fresh" if it was taken within `max(windowHours, 5)` hours. Snapshots come from `session.measure` and `$.session.usage()` in any session. They are stored as `limits` in `$.store`, and the newest wins.

`mode` lets the person budget by tokens instead of percent (`mode=tokens`), and `windowHours` changes the block length (e.g. a 3 h or 8 h block).

### Detection details
- **Whole points.** Anthropic reports `percentUsed` in whole points in practice. The week's position is modelled as `whole point + min(0.95, fraction)`, where the fraction is how far into the point it was at the last step (`stepFrac`) plus `tokensSinceStep / tokensPerPct`. A block's spend is how far that position moved from the block's baseline: `carried + max(0, last + fraction − base)`.
  - **Weekly tracker** (`weeklyTrack` in the store): the last whole point seen and the all-sessions lifetime token total (`total` on each `tok:` counter) when it began. It outlives blocks, so a new block's baseline is `whole + fraction` (e.g. 57.4), not the bare whole number that charged a full point at the first tick.
  - `tokensPerPct` is learned from the tracker's tick-to-tick intervals only (never the first tick after a sighting, which is partial), as the **median of the last 7 samples** (`calibration.recent`): a tick caused by usage elsewhere makes a point look cheap and is outvoted.
  - The default prior is 4M weighted tokens per point.
- **Late baseline.** With no reading under 15 minutes old at block start, the tracker's position is kept as `weeklyPrior`. At the first reading: still on that point, the prior is the baseline and the block's tokens so far count; points later, the baseline is `max(prior, reading − ownTokens/tokensPerPct)`, so the block is charged only what its own tokens explain, never usage elsewhere.
- **Per request.** Tokens are counted at `turn.step` (each model request), not at `turn.complete`.
- **Freshness.** A `session.measure` reading is always fresh. A polled `$.session.usage()` reading is stored only when its figures differ from what's stored.
- **Baselines.** A new block's baseline comes only from a reading under 15 minutes old (`BASELINE_MAX_AGE_MS`).
- **Expired windows.** A window whose `resetsAt` has passed is dropped (`liveLimits`).

## Blocks
- A block starts on the first activity after the previous block expired. Activity is a prompt that will run, an agent spawn, or a turn completing with usage. A block lasts `windowHours`.
- Shared record `block` in `$.store`: `{ startedAt, endsAt, weeklyBase?, weeklyLast?, weeklyCarried }`.
- **Concurrency:**
  - `mergeBlock(a, b, now)` is deterministic: the earliest *active* block wins, and fields at the same start are combined with min/max. Every writer re-reads, merges and writes, so racing sessions converge.
  - Token counters are per session (`tok:<sessionId>` = `{ blockStart, tokens, at }`). Each session writes only its own key, so there are no lost updates. The block total is the sum over keys with the matching `blockStart`.
  - Stale counter keys are removed after 24 h.

## Enforcement
`evaluate()` computes `pct = used / budget × 100`, then a level:

| Level | When |
|---|---|
| `off` | `/5h off` is active until its time. No warnings and no refusals. |
| `unlocked` | `/5h unlock` was used for this block. It lifts the cap once, for the rest of the current block only. |
| `cap` | `pct ≥ 100` |
| `warn` | `pct ≥ warnPct` |
| `ok` | otherwise |

- **Prompts** (`prompt.submit`): at `cap`, `{ drop }` with a message giving the reset time in the local zone and the override commands.
  - Never dropped: slash commands (so `/5h` always works), `isMeta` rows, anything delivered into a running turn (`turnId` set), and origins `task-notification`, `peer-send-message`, `observer`, `observer-activity`, `unclassified`. This avoids agent-usage-guard's "swallowed notifications" failure.
- **Agents** (`agent.spawn`): new agents at `cap` get `{ deny }`. Resumes (`e.resume`, a SendMessage waking a parked subagent) pass: they continue work already running.
- **In-flight work** is never killed and tool calls are never refused.
  - When the cap is reached mid-turn (seen on `session.measure`, `turn.complete` or `tool.call`), the mod appends one hidden user note per loop per block via `$.session.append`: *finish the current step, leave files consistent, start nothing large, summarize what's left*.
- **Warning:**
  - Crossing `warnPct` shows one toast per block.
  - Crossing the cap shows one toast plus a native notification.
  - The band changes colour.
- **The real limit:** the mod does nothing about Anthropic's real limit; Claude Code's own wait and resume handles it.

## Failure mode
- If a forced strategy has no data, or evaluation throws:
  - `open`: allow, and show `⚠ cap not enforcing: <reason>` in the band and a toast.
  - `closed`: refuse with that reason.
- Guards carry `.catch(…)` handlers that apply the same policy, so a crashing hook also obeys `failMode`.
- In `auto`, a missing usage source is not an error: it degrades to `tokens`, and the band says so.

## Commands
- `/5h` or `/5h status`: full status.
- `/5h off`: pause until the current block resets.
- `/5h on`: re-enable, clearing `off` and `unlock`.
- `/5h unlock`: one-time override for the current block.
- `/5h set <key> <value>`: keys `hours | budget | tokens | cap | warn | mode | fail | bar | tz`. `/5h set <number>` sets the active strategy's budget.
- `/5h reset`: clear all `/5h set` overrides.
- `/5h bar on|off`: shortcut for the band.

## UI
Two placements (`barPosition`, `/5h bar above|below`; `/5h bar` toggles):
- **below**: `PromptHint`'s `tail`, at the end of the dim hint line under the input.
  - It takes no row, and the engine's line and pills stay live.
  - The room for it is the row less the indent, the engine's mode indicator (not reported to mods; 26 cells are reserved whenever the hint offers shift+tab), the hint, any other tail and the separator.
  - The tail is drawn dim, so `⚠` / `⛔` mark warn and cap.
- **above** (default): the `AbovePrompt` band with `marginTop={1}`, so there's one blank row above and the engine's one blank row below.

The band itself is a one-line band laid out for the width it has (`bandLayout`, pure). It uses the richest variant that fits:

```
5h limit ███████░░░ 72% used · resets in 2h 13m (3:40 PM) · week 41%   (wide)
5h limit ███████░░░ 72% used · resets in 2h 13m · week 41%               (medium)
5h ████░░ 72% · 2h 13m left · wk 41%                                     (narrow)
5h 72% · 2h 13m                                                           (tiny)
```

- **Colours:** the whole band is dim grey while all is well. At `warn` the % turns yellow, and at the cap the band switches to red text: `5h limit reached · new prompts & agents paused · resets in … · /5h unlock to override`.
- **Wording per state:**
  - idle: `5h limit ready · starts with your next prompt · week 56%`
  - off: `paused until …`
  - unlocked: ` · unlocked`
  - failing: `⚠ 5h limit not active · can't read usage (…)`
- **The measuring strategy is not shown in the band;** it's jargon. `/5h status` explains it in plain words. The band shows only `≈` when the % is a local token estimate.
- **Countdown first, clock second.** The countdown is right whatever the machine's time zone is.
- **Data:** the band reads `BandData` from a `$.state` atom tagged `shape: 'band-2'`. It is refreshed by state writes and a 30 s timer, and writes are skipped unless something visible at minute resolution changed.

## Security
- No HTTP. No `$.session.authorize`. No credentials are read or stored.
- The store holds only timestamps, percentages, token counts and settings.

## Safety ("don't break anything")
- Pass-through hooks always call `next(e)` and never rewrite inputs.
- Every non-guard hook body is wrapped in try/catch, so an error can only skip the mod's own extras.
- Only drop/deny decisions are made, and only at `cap`.
