# Privacy

Lattiz is a desktop app with no account and no server of its own, and it sends no analytics. This page lists everything that leaves your computer because of Lattiz, and everything it keeps. It's mirrored in Settings → Data.

## What leaves your computer

| What                               | Where it goes                                                                                                                      | When                                                                  | How to stop it                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------- |
| Your agents' work                  | Each agent's own provider: Anthropic for Claude Code, OpenAI for Codex, Google for Gemini, and so on                               | When you chat with that agent                                         | Don't use that agent                          |
| Release check                      | `api.github.com` (Lattiz's releases). The request carries the app version in its User-Agent, nothing about you.                    | About 10 s after launch, then every 6 hours, in installed copies only | Settings → General → "Check for new versions" |
| Pages you open in the dock browser | The sites you open                                                                                                                 | When you open them                                                    | —                                             |
| Card network access                | The origins you granted to a card                                                                                                  | When that card refreshes                                              | Don't grant them, or remove the card          |
| MCP connections                    | The servers you added                                                                                                              | When an agent uses their tools                                        | Settings → Connections                        |
| Links you click                    | Your browser                                                                                                                       | When you click                                                        | —                                             |
| "Report a problem"                 | Nothing by itself. It copies diagnostics to your clipboard and opens a new GitHub issue in your browser. You decide what to paste. | When you click it                                                     | —                                             |

**Agents and their providers.**

- **Claude Code, Codex and Gemini CLI** run on your machine under your own sign-in, exactly as when you start them in a terminal.
- **Lattiz's own connections:** Lattiz doesn't read, copy or proxy their credentials. Each agent talks to its provider directly.
- **Claude chat view:** with an API key, Lattiz passes the key to Claude Code as `ANTHROPIC_API_KEY`.

## What Lattiz keeps, and where

Everything is in one data folder (Settings → Data → Open):

| Path                                                      | What                                                                                                                                     |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `lattiz.db`                                               | Canvas, projects, chats and their transcripts, notes, flows, scheduled messages, settings                                                |
| `cards/`, `skills/`, `conductor/`, `agents/`, `projects/` | Your cards, skills, Conductor preferences, agent manifests and sandbox projects                                                          |
| `accounts/`                                               | Separate sign-in folders for extra agent accounts (Settings → Agents)                                                                    |
| `run/`                                                    | Short-lived files for running sessions, such as Claude Code's hook settings. They hold local tokens and are deleted when a session ends. |
| `logs/lattiz.log`                                         | Warnings and errors, with home-folder paths, tokens, keys and email addresses removed. Capped at 1 MB plus one older file.               |
| `electron/`                                               | The app's browser profile, including the dock browser's cookies and crash dumps. Crash dumps are never uploaded.                         |

**Secrets.**

- **Where they're kept:** the Anthropic API key and MCP connection values (env and headers) are encrypted with your operating system's keychain (Electron `safeStorage`). Where there's no keychain, Lattiz won't save them.
- **What's left out:** they're never written to the log. Exports leave them out, and they don't appear in "Report a problem".

**Local servers.**

- **What runs:** Lattiz runs one HTTP server on `127.0.0.1` on a random port, for the workspace MCP tools and Claude Code's hooks.
- **Who can use it:** each chat gets its own random token, new every launch. Requests from browsers, and requests to any other host name, are refused.

## Export and removal

- **Export:** Settings → Data → Export writes a copy of the workspace without secrets, agent sign-ins or the browser profile.
- **Removing everything:** quit Lattiz and delete the data folder. Your agents' own data (for example `~/.claude`, `~/.codex`) belongs to those tools and isn't touched by Lattiz.
