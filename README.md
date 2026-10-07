# goclaude

Run [Claude Code](https://claude.com/product/claude-code) inside a
[gondolin](https://github.com/earendil-works/gondolin) micro-VM.

## Prerequisites

- **Node.js >= 22.19** — required by gondolin.
- **QEMU** — the default micro-VM backend:
  - Debian/Ubuntu: `sudo apt install qemu-system-x86` (or `qemu-system-arm`)
  - macOS: `brew install qemu`
- **gondolin** — provides the `gondolin` CLI used by `build-image.sh` and the
  `@earendil-works/gondolin` module imported by `goclaude.mjs`:
  ```bash
  npm install -g @earendil-works/gondolin   # CLI + module, available everywhere
  ```
  If you prefer a local install instead:
  ```bash
  npm install @earendil-works/gondolin      # module + CLI in ./node_modules/.bin
  export PATH="$PWD/node_modules/.bin:$PATH" # so build-image.sh finds `gondolin`
  ```
- **Claude Code credentials** at `~/.claude/.credentials.json`, created by
  logging in to `claude` on the host.
- **Docker** — only when building.

## Build the sandbox image

```bash
./build-image.sh            # alpine
./build-image.sh --docker   # docker
```

Both accept `IMAGE=<tag>` to control the final gondolin image tag.

## Run

```bash
npm start -- [workspace] [claude args...]
```

or invoke the entry point directly:

```bash
node ./goclaude.mjs [workspace] [claude args...]
```

If the first argument is an existing directory it becomes the guest
`/workspace`; everything else is forwarded to `claude`.

Environment overrides: `IMAGE`, `GOCLAUDE_MEMORY` (default `4G`),
`GOCLAUDE_DISK` (default `4G`).

### Session history

Each workspace persists its Claude Code session transcripts in
`<workspace>/.goclaude`, bind-mounted into the guest as `~/.claude/projects`.
That directory is created (and ignored via a generated `.gitignore`) on first
run, so `--resume` and `--continue` keep working across sandbox restarts:

```bash
goclaude            # start a session
goclaude --continue # resume the most recent session for this workspace
goclaude --resume   # pick a session interactively
```

Only the transcript history is persisted; credentials, settings, plugins and
the host `~/.claude` state remain ephemeral and are never mounted.

### Screenshots

Claude Code pastes images by reading the _host_ clipboard, which the guest
cannot reach, so paste-with-Ctrl+V is not available inside the sandbox. Drop
the image into `<workspace>/.goclaude/screenshots` (exposed read-write inside
the guest at `/screenshots`) and reference it by path in the prompt:

```
> explain the layout in @/screenshots/image.png
```

These are available both in the guest and on the host, so screenshots taken on
the host can simply be saved to `./.goclaude/screenshots` and read natively.
Claude's `Read` tool handles `png`/`jpg`/`webp`, so a path works like a paste.

## zsh alias

Add this to `~/.zshrc` (adjust the path to where you cloned this repo):

```zsh
alias goclaude='node "$HOME/dev/goclaude/goclaude.mjs"'
```

Reload and run it from any project directory — that directory becomes the
sandbox `/workspace`:

```zsh
source ~/.zshrc
cd ~/projects/my-app
goclaude            # start Claude Code in the sandbox
goclaude --resume   # any args are forwarded to claude
```

## What is in the guest

Every run starts clean. The guest gets only:

- your OAuth credentials, copied from `~/.claude/.credentials.json`
- a minimal `~/.claude.json` (`hasCompletedOnboarding`, `autoUpdates: false`,
  the `oauthAccount` from the host config if present, and a trusted
  `/workspace` project entry so the trust dialog is skipped)
- the workspace bind-mounted at `/workspace`
- a persisted session-history directory at `<workspace>/.goclaude`, mounted as
  the guest's `~/.claude/projects` (see [Session history](#session-history))
- a screenshot directory at `<workspace>/.goclaude/screenshots`, mounted at
  `/screenshots` (see [Screenshots](#screenshots))

No host `~/.claude` state (settings, history, plugins, commands) is mounted, so
the sandbox can't read or modify it. If Claude refreshes its OAuth token during
the session, the new credentials are copied back to the host so the host login
stays valid.
