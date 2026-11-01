# RESEARCH — bringback5hourlimit

Researched 2026-11-01 against **Claude Code 2.1.316** (`claude --version`; ≥ 2.1.287 required).

**Sources**
- **D** = the engine-written declarations for 2.1.316 (`// Written by Claude Code 2.1.316.`, header line 1). They are the same file the engine lays at `.claude-plugin/types/claude-code/index.d.ts` when it loads the mod. Line numbers below refer to that file.
- **R** = the plugin-authoring reference bundled with 2.1.316.
- **Docs** = code.claude.com/docs/en/plugins/mods/{overview,reference,events,interface,test} pages.
- External repos: cloned and read, never run.

## 1. APIs used

| Need | API (exact) | Source |
|---|---|---|
| Refuse a submitted prompt | `on('prompt.submit', ($, e, next) => …)`. Return `{ drop: string }` **without** calling `next`. A drop after `next` fails the hook and the turn still runs. | D:4255 (doc), `PromptSubmitResult` D:9691; Docs events.md "prompt.submit" |
| Know who sent a prompt | `e.origin: PromptOrigin`, with `kind` ∈ `composer, bridge, sdk, task-notification, scheduled-trigger, peer, plugin, peer-send-message, projects-relay, channel, coordinator, observer, observer-activity, auto-continuation, unclassified`. Also `e.command?` (slash command), `e.isMeta?`, `e.turnId?`. | D:9347, `PromptSubmitInput` D:9613 |
| Add model-only context to a prompt | `next({ ...e, context: [...(e.context ?? []), note] })` | `PromptSubmitInput.context` D:9613ff |
| Refuse an agent/subagent before it starts | `on('agent.spawn', …)` → `{ deny: string }` before `next`. `e.resume?.agentId` is present for a SendMessage resume. `e.workflow` is present for workflow `agent()` calls. | D:4243, `AgentSpawnInput` D:261, `resume` D:387, `AgentSpawnResult` D:422 |
| (Not used) hide agent types | `agent.offer` → `{ isOffered: false }` | D:4231 |
| Guard failure policy | A failed hook is skipped. A guard needs `.catch(($, e, next) => next.called ? next(e) : refusal)` to fail closed. | D:4109/4243/4255 remarks; R "Developing one" |
| Read limit windows (5h, weekly) | `$.session.usage(): Promise<SessionUsage>` → `{ startedAt, context, rateLimits: SessionRateLimit[], cost? }`. The plain call "costs nothing". | D:2921, D:12477 |
| Limit window shape | `SessionRateLimit = { kind: string /* 'five_hour' \| 'seven_day' \| gateway 'spend_limit' */, percentUsed: number /* 0–100, 1 decimal */, resetsAt?: string /* ISO 8601 */ }` | D:12055 |
| Missing window | A window the engine has no reading for is **left out of the array, never zeroed**. `rateLimits` is empty off a subscription or before the first API response. | D:12470-12498, D:11877 |
| Push notification of usage | `on('session.measure', …)`, observe only. `e.rateLimits`, `e.changed: ('context'\|'rateLimits'\|'cost')[]`. Fires after each main-thread turn and when a window moves a whole point, appears or leaves. | D:4582, `SessionMeasureInput` D:11861 |
| Per-turn token usage (main + subagents) | `on('turn.complete', …)`. `e.usage?: TurnUsage = ModelUsage & { model }`. `ModelUsage = { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }`. `e.agentId` is set for subagent turns. `usage` is absent on interrupts and API errors. | D:4638, D:14378, D:14743, D:6635 |
| Telemetry (considered, not used) | `on('telemetry.log', { to: 'collector' \| 'anthropic' }, …)`. Records depend on which streams are on. `turn.complete.usage` covers the same counts without depending on telemetry config. | D:4457, D:13360; R "What a plugin…" |
| Band above the prompt | `on('ui.render', { component: 'AbovePrompt' }, …)` returns a tree from `$.ui.resolve(e)` (`Box`, `Text`), or `next(e)` to draw nothing. Size to `e.props.bodyColumns`. Defer when `e.props.hasSurvey`. | D:4135; R "Drawing: ui.render"; example `band.tsx` |
| Redraw on change | `atom(ref, initial)`, `read($, atom)` while drawing, `update($, atom, fn)` elsewhere. Values are declared in `types/index.d.ts` `interface PluginState`. | R; example `band-state.d.ts` |
| Slash commands | `$.command.register({ name, description, argumentHint?, immediate? })` in `session.start`. The handler is `on('command.run', { command: name }, …)` returning `{ text }`. Names: letters, digits, `_`, `-` ≤ 64, so `5h` is legal. | `CommandSpec` D:1922, D:4407, `CommandRunResult` D:1873 |
| Persistent storage | `$.store.get/set/delete/keys`: the plugin's own JSON file under `~/.claude/plugins/store/`, capped at 4 MiB. It is **shared by every session on the machine**. `get`+`set` is not atomic. Docs advise one key per item and re-reading right before writing. | D:3467; Docs interface.md:757, 865-872 |
| Toasts / status | `$.ui.toast(text, { timeoutMs? })`, `$.ui.status(text \| undefined)` | D:2486, D:2516 |
| Timers | `$.clock.now()`, `$.clock.every(ms, fn)` (start in `session.start`; dropped on reload) | D:3542-3580 |
| Session id | `$.session.id(): Promise<string>` | D:2871 |
| Append a note mid-turn | `$.session.append({ message: { type: 'user', content: [{ type: 'text', text }] }, agentId? })`. The model reads it from the loop's next top. | D:2976; R "session.append" |
| Config | `plugin.json` `userConfig` fields → `register(on, options)`. Stored in `settings.json` `pluginConfigs[<name>].options` and shown as rows in `/config`. String fields with `options` become pickers. | `PluginOptions` D:7921; R "Developing one" |
| Env vars | `$.env.get('LITERAL')`. The name must be a string literal. | D:3726 |
| Tests | `claude plugin test <dir>` runs `*.test.ts`. `import { test, expect, mock } from 'claude-code/testing'` gives `mock.clock/store/env/session`. `test(name, { options }, body)`. A `$` call is stubbed with `on('session.usage', () => ({ value: … }))`. | D:16044ff, `mock` D:16682, `TestOptions` D:17131; Docs test.md:109-114 |

## 2. Verified empirically (this machine, 2.1.316)
- **`$.store` reads through across processes.** Process A's `get` returned `undefined`. Process B then `set` the key, and A's next `get` (6 s later, same process) returned B's value. Concurrent sessions therefore really share state.
- The store file lives at `~/.claude/plugins/store/<plugin>_<hash>.json`.
- `Intl.DateTimeFormat` with `timeZone: 'Asia/Calcutta'` works inside the hooks environment (epoch formatted as `5:30 AM`).
- `{ drop }` from `prompt.submit` works in `claude -p` (stderr: `Prompt dropped by a hook: <reason>`).

## 3. Existing mods studied

**usage-quota** (anantraghunath/claude-code-usage-quota-mod, **MIT**)
- Reads `$.session.usage().rateLimits`, refreshed on `session.measure`, `turn.complete` and timers.
- Also polls `https://api.anthropic.com/api/oauth/usage` through `$.http.fetch` with `auth: (await $.session.authorize()).handle`. This is an opaque handle; the mod never reads credentials. It polls at most once per 2 minutes, coordinated across sessions through the store, with backoff.
- Forecast: the window's own rate blended with the median of past peaks.
- Band: an `AbovePrompt` `ui.render` that defers on `hasSurvey`.
- Treats a missing `five_hour` as 0 % with no reset ("idle").

**agent-usage-guard** (rbartoli/agent-usage-guard, **MIT**)
- Asks from 80 % and refuses from 95 % via `agent.spawn` → `{ deny }`. Gates `SendMessage` resumes too. Its guard fails closed.
- The wind-down note is `prompt.submit` `context`: "Finish the step in progress, start nothing large, and end this turn with a short summary…", sent once per session per window.
- **Why its circuit breaker was removed** (CHANGELOG 1.0.0): after a real limit it held prompts. It made 232 refusals that saved nothing, swallowed 31 background-task notifications, and blocked for 14 minutes after a limit lifted early. Claude Code itself has waited at a limit and resumed at reset since 2.1.234.
- Its hook-based version also ran a Python process per call (110–160 ms).
- Tests drive `$.session.measure(…)` directly and seed `peer:<id>` keys in a Map-backed store.

**No code was copied from either project.** Both are credited in the README.

## 4. Verified-Ultra usage data
- t3code PR #28177: the streamed rate-limit windows on such accounts list **only `seven_day`**; `five_hour` is absent.
- The `/api/oauth/usage` endpoint still returns `five_hour: { utilization: 0, resets_at: <clock> }`, a fake 0 %. An endpoint-based design would wrongly think a 5h window exists.
- **Decision:** read only `$.session.usage()` / `session.measure`, where absence is represented by the window being missing from `rateLimits` (D:12470). No HTTP calls at all.

## 5. Claude Code's own wait at a real limit
- Since 2.1.234 Claude Code waits at a claude.ai limit and continues automatically at reset (`/config` → "Continue automatically at usage limit"). Later fixes: 2.1.271 (workflows pause/resume), 2.1.284, 2.1.314.
- The continuation arrives as a prompt with `origin.kind === 'auto-continuation'`.
- **Decision:** the mod never acts on the real limit. It only enforces its own budget.
  - Notifications (`task-notification`, `observer*`, `unclassified`, `isMeta`) always pass, so nothing is swallowed.
  - Block expiry is computed live from the clock, so the brake lifts the instant the block ends.

## 6. Open questions
1. **Store atomicity.** `$.store` has no compare-and-swap; R and the Docs confirm `get`+`set` races. Mitigations: per-session keys for counters, a deterministic merge for the shared block record (earliest active start wins), and re-reading before every write. Two sessions starting a block in the same millisecond converge on the next read; a lost `/5h` control write is possible only if two sessions issue commands simultaneously.
2. **`turn.complete.usage` and subagents.** D says a turn's usage is "its real requests' token counts". It is not stated whether a parent turn's usage includes its subagents' requests. Assumption: it does not (they are separate loops with their own `turn.complete`), so the token fallback sums every `turn.complete`. If the parent did include them, the fallback would over-count, which errs on the safe side.
3. **Weekly-% resolution.** `percentUsed` has one decimal, but `session.measure` pushes only on whole-point moves. The mod also polls `$.session.usage()` on a 30 s timer, but that figure only changes when some response arrives. A small `BLOCK_BUDGET_PCT_OF_WEEKLY` (< 3) is therefore coarse.
4. **Old 5h/weekly ratio.** Anthropic never published the old ratio between the 5-hour and weekly limits. The default emulated budget (15 % of weekly per block) is a judgement call, not Anthropic's number.
5. **`agent.spawn` on resumes.** The Docs reference page says the hook isn't raised on a SendMessage resume; changelog 2.1.299 says it is (`e.resume`). D (2.1.316) documents `resume`, so the mod treats resumes like new agents.
6. **Verified Ultra in practice: resolved.** In the live smoke test on this machine, `$.session.usage().rateLimits` held **only `seven_day`** (56 %, with `resetsAt`) and no `five_hour` entry, and `auto` selected the weekly-Δ strategy. This confirms the "left out, never zeroed" representation on a real account without a 5-hour window.
