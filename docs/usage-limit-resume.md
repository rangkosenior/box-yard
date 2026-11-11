# Resume after usage limits

When Claude's 5-hour, weekly or monthly spend limit stops work, Box Yard doesn't leave it failed until someone presses
Retry. It shows the work as waiting for the reset, checks the limit without using model tokens, and resumes the stalled
work by itself once the limit clears. Settings › Coordinator › Resume after usage limits turns it on (default) or off.

## What stops, and how it shows

| Work | While waiting | On resume |
| --- | --- | --- |
| A task | Still `failed` underneath (Retry works, hooks and sub-task reports behave as for any failure), but its pill reads "Waiting for limit" (`Task.limitWait`) and its banner says when the limit resets and that Box Yard resumes it | `retryTask`: the same "carry on" prompt as the Retry button |
| The Coordinator | The turn's messages stay unanswered and no new turn starts (a turn would fail the same way); the chat shows the error once | A turn answers them |
| A Captain | The same, through the open-turn mark a stop leaves (`Captain.resume`) | A turn answers them |

Only turns answering Cody's, a hook's or another agent's messages are kept. Automatic wake-ups (task updates) that hit a
limit are not replayed: their updates were already in the chat.

The yard's updates say it: one `⚠ **Usage limit** paused work: …` when work first pauses, with the reset time, and one
`▶ **Usage limit** cleared: 2 tasks and the Coordinator resumed.` when it resumes. Neither wakes a Captain or the
Coordinator (they read them with their next updates), so the notices spend no tokens either.

## Spotting a limit failure

`parseUsageLimit` (`shared/usageLimit.ts`) reads a failure's text: the kind (`five_hour`, `weekly`, `monthly`,
`unknown`) and the reset time, from `resets 6:20pm (America/Chicago)`, `resets Nov 15, 5pm (America/Chicago)`,
`resets in 2 hours`, or the `|<unix seconds>` stamp. A time of day that has passed is tomorrow's; daylight saving is
followed through the named zone. A rate-limit burst (`rate_limit_error`) isn't a usage limit. Text that gives no reset
time (a monthly spend limit) leaves `resetsAt` null.

## Checking the limit without tokens

`readClaudeUsage` (`server/claudeUsage.ts`) asks `GET https://api.anthropic.com/api/oauth/usage` with
`anthropic-beta: oauth-2025-04-20` and the access token Claude Code keeps in `~/.claude/.credentials.json`
(`CLAUDE_CONFIG_DIR` if set). This is what Claude Code's `/usage` and the Omarchy usage panel
(`omarchy-agent-usage-claude`) read. It costs no model tokens. The token goes only into the request header: it is never
returned, logged or put in an error. A window counts as full at 100% (`limits[]`, or `five_hour`/`seven_day`); a spend
cap counts when it is enabled and reached, and only holds a monthly stall.

The answer can be missing: no login, an expired token (Claude Code renews it whenever it runs; it lasts about eight
hours), a refusal, a rate limit on the endpoint, no network. Then the watch goes by the reset time alone, as it does for
work running on another login (a project's own Claude token, boxes, Codex), which this computer's usage doesn't speak for.

## When it resumes

`UsageLimitWatch` (`server/usageLimitWatch.ts`) keeps what is waiting in the `usage_limit_pause` key (it survives a
restart), and looks at the earliest reset time plus a minute (`BUFFER_MS`):

1. Nothing is asked before a reset time is reached.
2. Then it asks the usage endpoint. Clear: it resumes every waiting item, in the order they stalled; tasks queue, so
   box slot and project limits apply as for any retry.
3. Still full: it looks again when the endpoint says that window resets, else every 15 minutes (30 for a monthly spend
   limit with no reset time), never more than an hour apart, so a raised limit is noticed too.
4. With no answer from the endpoint and no reset time, it tries one resume an hour (a trial). A trial that fails again is
   silent: no new "paused" or "cleared" notice.

Safety: an item resumes at most `MAX_ATTEMPTS` (3) times in 24 hours; after that its limit failure is a plain failure
and waits for Retry. Turning the setting off drops everything waiting (the work stays as it stopped).

Tests: `test/usage-limit.test.ts` (parser, probe, watch), `test/usage-limit-resume.e2e.test.ts` (a task, the
Coordinator and a Captain through the fake CLI, whose `FAKE_CLAUDE_LIMIT_FILE` is a limit that lifts when the file goes).
