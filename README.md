# SillyNovel

A **Writing Workspace** for [SillyTavern](https://github.com/SillyTavern/SillyTavern) — NovelAI-style AI cowriting for long-form prose, alongside SillyTavern's existing roleplay features.

SillyNovel is **not a fork**. It is a UI extension plus a server plugin that mount into a stock, version-pinned SillyTavern container, so upstream updates stay free and this repository contains only its own code.

> **Status: pre-implementation.** The repository scaffold exists; no features are built yet.

## What it does

A dedicated writing screen with plain-text chapters, driven by a **Writing Profile** (narrative voice, genre, POV, tense, style instructions, prose examples, rules) rather than a character card. It reuses SillyTavern's model connections and World Info/lorebooks, and adds these actions:

**Continue · Rewrite selection · Expand · Summarize · Brainstorm**

Generated prose always appears as a **suggestion** — Insert, Replace, Copy, or Discard. It is never auto-appended to your draft.

## How it fits together

| This repo | Mounts into SillyTavern as |
|---|---|
| `extension/` | `public/scripts/extensions/third-party/sillynovel-writing` |
| `plugin/` | `plugins/sillynovel` → serves `/api/plugins/sillynovel` |

`container/run.sh` starts stock SillyTavern with both mounted, publishing the port on `127.0.0.1` only.

## Requirements

- **Apple Container** on macOS (or Docker — the run script is Apple Container-flavoured but the mounts are portable)
- A SillyTavern-supported model provider
- `enableServerPlugins: true` in SillyTavern's config (already set in `container/config.yaml`)

## Running

```bash
# Start the pinned SillyTavern release
./container/run.sh

# Open http://localhost:8000
```

Apple Container is the default runtime. To use a Docker-compatible runtime:

```bash
CONTAINER_RUNTIME=docker ./container/run.sh
```

Persistent SillyTavern state (config, user data, backups) lives in `~/.sillynovel` by default — **outside this repo**, because it contains user data and a `secrets.json` that stores API keys in plaintext. Override with `SILLYNOVEL_STATE`.

### Pinned SillyTavern version

| | |
|---|---|
| Image | `ghcr.io/sillytavern/sillytavern` |
| Tag | `1.18.0` |
| Multi-platform digest | `sha256:7b30a1698b605d01dbd01a20459600c035f0d2c866912b69d7eee98065dcedd3` |
| Linux/arm64 manifest | `sha256:9ce71c3bff843597debf8a1911d6d7587adefb019a37e74572400c0741d2cdec` |

Never run `:latest`. An upstream change can break an extension API or plugin assumption without warning; upgrades are a deliberate, tested step.

## Development

- **Extension** changes (`extension/`) → **browser reload**.
- **Server plugin** changes (`plugin/`) → **container restart** (Node loads plugins at boot).

If a plugin change appears to have no effect, restart the container before debugging anything else.

## Security

Intended for **yourself and trusted friends**, not open public signup — matching SillyTavern's own guidance for multi-user mode. SillyTavern stores API keys as plaintext JSON on the server, and admin accounts can read all users' data. Treat any deployment accordingly, and keep it off the public internet unless it is behind an authenticating proxy.

Never commit `data/`, `config/`, or `secrets.json`.

## License

[AGPL-3.0](LICENSE), matching the SillyTavern ecosystem.

SillyNovel is an independent project and is not affiliated with or endorsed by the SillyTavern project.
