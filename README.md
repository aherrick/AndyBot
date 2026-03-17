# AndyBot

AndyBot is a small Telegram bot that lets you pick a local git repo and send repo-specific prompts to Codex.

## What It Does

- Lists git repositories under a configured root folder
- Lets you select one repo per Telegram chat
- Sends free-form messages to Codex with that repo as the working directory (streamed)
- Stores per-repo thread IDs so a chat can resume context
- Can compact an existing thread into a fresh handoff summary
- Writes simple bot activity to `data/`

## Requirements

- Node.js 20+ recommended
- `npm`
- `git` available on your `PATH`
- A Telegram bot token
- A working Codex setup for `@openai/codex-sdk`

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create or update `.env` in the repo root:

```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
CODE_ROOT=C:\code
CODEX_REASONING_EFFORT=medium
```

`CODE_ROOT` should point at the folder that contains the git repos you want the bot to browse. If omitted, it defaults to `C:\code`.

`CODEX_REASONING_EFFORT` controls how much work Codex does per request. Valid values are `minimal`, `low`, `medium`, `high`, and `xhigh`. If omitted or invalid, AndyBot defaults to `medium`.

3. Start the bot:

```bash
npm run start
```

On Windows you can also use:

```bat
start.cmd
```

For development with auto-reload:

```bash
npm run dev
```

## How To Use

In Telegram, send:

- `/start` to see the basic command list
- `repo all` to list the top repos under `CODE_ROOT`
- `repo 1` to select a repo from the last list
- `repo clear` to clear the selected repo
- `repo reset` to clear the saved Codex thread for the selected repo
- `repo compact` to summarize the current thread into a fresh one

After selecting a repo, send any normal message and AndyBot will run that prompt against Codex in the selected repo.

## Data And Logs

The bot writes local state under `data/`:

- `data/state.json` stores selected repos and saved thread IDs per chat
- `data/worklog.jsonl` stores a compact history of bot activity

The `data/` folder is already ignored by `.gitignore`.

## Notes

- Only immediate child folders under `CODE_ROOT` are scanned for git repos.
- If a request fails, check that the selected repo still exists and that `git` and Codex are installed and working.