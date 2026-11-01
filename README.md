# bringback5hourlimit: bring back the Claude Code 5-hour usage limit

A Claude Code mod that brings back the **rolling 5-hour usage limit** as a **local, self-imposed cap**. It's meant for **Claude Ultra** accounts, which since Oct 30, 2026 only have a weekly limit. It also works on Max, Pro, API keys, and offline.

When your 5-hour budget runs out, new prompts and new subagents are refused until the block resets. The work already running is allowed to finish. This means a runaway agent or a late night can't burn a big share of your weekly limit in one go.

```
5h limit ━━━━━━━━──── 72% used · resets in 2h 13m (3:40 PM) · week 41%
```

The bar fits the space it has. On a narrow terminal it shrinks to `5h ━━━━── 72% · 2h 13m left · wk 41%`, then to `5h 72% · 2h 13m`. It's green normally, yellow near the limit, red once the limit is reached (`5h limit reached · new prompts & agents paused · resets in 1h 2m`), and `≈` marks a local estimate.

## Install

Run these in a terminal:

```sh
claude plugin marketplace add GagnDeep/bringback5hourlimit
claude plugin install bringback5hourlimit@bringback5hourlimit
```

Or run this inside Claude Code:

```
/plugin install bringback5hourlimit --marketplace GagnDeep/bringback5hourlimit
```

It works with the defaults, so there's nothing to set up. You'll need Claude Code **2.1.287 or newer**. It works on Windows, macOS and Linux.

## Commands

| Command | What it does |
|---|---|
| `/5h` or `/5h status` | Shows block %, reset time (in your local time zone), how usage is measured, and your weekly %. |
| `/5h off` | Pauses the cap until the current block resets. |
| `/5h on` | Turns the cap back on and clears `off` and `unlock`. |
| `/5h unlock` | One-time override. It lifts the cap for the rest of this block only. |
| `/5h set <key> <value>` | Changes a setting. Keys: `hours`, `budget`, `tokens`, `cap`, `warn`, `mode`, `fail`, `bar`, `tz`. |
| `/5h set <number>` | Sets the budget for the strategy that's active now, e.g. `/5h set 20` or `/5h set 5m`. |
| `/5h bar on` / `/5h bar off` | Shows or hides the live bar above the prompt. |
| `/5h reset` | Clears every `/5h set` override. |

`/5h` always works, even when you're capped.

## Configuration

Settings are read in this order, and the first one found wins:
1. `/5h set`
2. An environment variable
3. `/config` (look for the plugin's rows there)
4. The default

| Setting | Env var | Default | Meaning |
|---|---|---|---|
| `windowHours` | `BB5H_WINDOW_HOURS` | `5` | How long a block lasts, in hours (0.25–168). For example, 3 or 8. |
| `mode` | `BB5H_MODE` | `auto` | How usage is measured: `auto`, `official`, `weekly` or `tokens` (see below). |
| `weeklyBudgetPct` | `BB5H_BLOCK_BUDGET_PCT_OF_WEEKLY` | `15` | How much of your **weekly** limit one block may use. 15% is about 6–7 full blocks a week. |
| `officialCapPct` | `BB5H_OFFICIAL_CAP_PCT` | `90` | When Anthropic reports a 5-hour %, you're capped at this %. |
| `tokenBudget` | `BB5H_TOKEN_BUDGET` | `10000000` | Tokens allowed per block in `tokens` mode, counted across all sessions. |
| `warnPct` | `BB5H_WARN_PCT` | `80` | Warns you at this % of the block budget. |
| `failMode` | `BB5H_FAIL_MODE` | `open` | What happens if usage can't be measured. `open` allows work and shows a warning. `closed` refuses new work. |
| `showBar` | `BB5H_SHOW_BAR` | `true` | Shows the live bar above the prompt. |
| `timeZone` | `BB5H_TIMEZONE` | system | Time zone for reset times, e.g. `Asia/Kolkata`. |

## How usage is measured

In `auto` mode the mod uses the first of these that's available:

1. **Anthropic's 5-hour window (`official`).** This applies to Max, Pro and unverified Ultra accounts. If Anthropic still reports a 5-hour %, the cap is `officialCapPct` of it, and the reset time is Anthropic's.
2. **Weekly-% delta (`weekly`).** This applies to verified Ultra accounts, which only report a weekly window. When a block starts, the mod records your weekly %. What the block has spent is how much your weekly % has risen since then. When that rise reaches `weeklyBudgetPct`, you're capped. This uses Anthropic's own units, and it handles the weekly reset happening partway through a block.
3. **Local token count (`tokens`).** This is used when there's no usage data, e.g. offline, on API keys, or if the API changes. The mod counts tokens from every turn and subagent on this machine. Cache reads count at 10%.

You can also force one of these with `mode`. For example, `/5h set mode tokens` budgets by tokens instead of by percent.

**How a block works:**
- It starts with your first prompt after the last block expired, and it lasts `windowHours`.
- Every Claude Code session on your machine shares the same block.
- At `warnPct` you get a warning. At the cap, new prompts and subagents are refused, with the reset time shown.
- If you hit the cap partway through a turn, Claude gets one note asking it to finish the current step and wrap up. Nothing is killed in the middle of an edit, and tool calls are never blocked.
- Background-task notifications and slash commands are always let through.

## Limitations

- **This is local only.** The mod can't change Anthropic's limits, and it doesn't try to. It only refuses work on your own machine.
- **The weekly-% budget is an estimate.** Anthropic never published the old ratio between the 5-hour and weekly limits, so the default of 15% of weekly is a judgement call. Change it if it doesn't suit you.
- **It relies on the Claude Code mods API**, which is early access and may change. If the usage data disappears, the mod falls back to counting tokens and says so in the bar.
- **The weekly % only updates when Anthropic reports it**, which happens with each response. Very small budgets (under 3%) will be coarse.
- When you hit Anthropic's **real** limit, Claude Code's own wait-and-resume (since v2.1.234) takes over. The mod doesn't interfere with it.

## Privacy and security

- The mod makes no network calls.
- It never reads, stores or logs OAuth tokens or credentials.
- It reads only the usage figures Claude Code already reports.
- It stores timestamps, percentages, token counts and your settings in the mod's own store file under `~/.claude/plugins/store/`.

## Tested with

Claude Code **2.1.316**, on Linux, with a live account that reports only a weekly window. The checks that passed:
- `tsc`
- `claude plugin validate`
- 56 tests run with `claude plugin test`
- A live smoke test: refused at a tiny budget, then `/5h unlock` worked

## Credits

Built after studying these two projects. No code was copied from either.
- [usage-quota](https://github.com/anantraghunath/claude-code-usage-quota-mod) by Anant Raghunath (MIT): reading usage windows and drawing a band above the prompt.
- [agent-usage-guard](https://github.com/rbartoli/agent-usage-guard) by Riccardo Bartoli (MIT): refusing agents at a threshold, the "finish the current step" note, and its lesson that a guard must never swallow background notifications.

## License

MIT
