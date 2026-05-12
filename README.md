# Buzz Fantasy Golf Weekly Prompt

One command refreshes your Buzz usage and builds the prompt to paste into your pick agent.

```powershell
.\weekly.cmd
```

Then paste this file into your agent:

```text
output/weekly-agent-prompt.md
```

That is the normal weekly workflow.

## What It Does

`.\weekly.cmd`:

- logs into Buzz Fantasy Golf using `.env`
- opens league `25119`
- pulls golfer usage for `Shankhopanonymous`
- infers the next tournament from the Buzz schedule
- writes `output/weekly-agent-prompt.md`

The prompt includes your usage limits, the current tournament, and careful instructions to avoid stale data and preserve high-value starts.

## First-Time Setup

Copy `.env.example` to `.env` and fill in your Buzz credentials:

```env
BFG_EMAIL=you@example.com
BFG_PASSWORD=your-password
BFG_LEAGUE_ID=25119
BFG_TEAM_NAME=Shankhopanonymous
```

The `.env` file is ignored by git.

## Outputs

- `output/weekly-agent-prompt.md` - paste this into the pick agent
- `output/agent-context.md` - usage table only
- `output/golfer-usage.json` - structured usage data
- `output/tournament-schedule.json` - Buzz schedule captured during refresh

## Optional Commands

Codex uses its bundled Node at:

```text
C:\Users\marcu\AppData\Local\OpenAI\Codex\bin\node.exe
```

`weekly.cmd` calls that directly, so Node does not need to be on your normal PowerShell `PATH`.

Build the prompt from the latest saved data without logging into Buzz:

```powershell
& "$env:LOCALAPPDATA\OpenAI\Codex\bin\node.exe" src/build-weekly-prompt.js
```

Override the inferred tournament:

```powershell
& "$env:LOCALAPPDATA\OpenAI\Codex\bin\node.exe" src/build-weekly-prompt.js --tournament "PGA Championship" --date "May 14, 2026"
```

Use a specific browser-exported usage file:

```powershell
& "$env:LOCALAPPDATA\OpenAI\Codex\bin\node.exe" src/build-weekly-prompt.js --usage .\buzz-golfer-usage-2026-05-11.json
```

## Fallback

If browser automation breaks because Buzz changes the site:

1. Log into Buzz in your browser.
2. Open `https://buzzfantasygolf.com/leagues/25119/reports`.
3. Paste `tools/buzz-usage-browser.js` into the browser console.
4. Run:

```powershell
& "$env:LOCALAPPDATA\OpenAI\Codex\bin\node.exe" src/build-weekly-prompt.js --usage .\buzz-golfer-usage-YYYY-MM-DD.json
```

## Publish To GitHub

This project can publish itself to GitHub without installing `git` or `gh`.

Add these to `.env`:

```env
GITHUB_TOKEN=your-token
GITHUB_REPO=buzz-fantasy-golf-weekly-prompt
GITHUB_PRIVATE=true
```

Then run:

```powershell
.\publish-github.cmd
```

The publish script uploads only project source files. It does not upload `.env`, `.buzz-session.json`, or `output/`.
