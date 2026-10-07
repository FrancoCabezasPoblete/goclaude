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
- **Docker** — only when building the image with `--docker`.

## Build the sandbox image

```bash
./build-image.sh            # alpine (default, no Docker needed)
./build-image.sh --docker   # build the rootfs with Docker instead
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
`GOCLAUDE_DISK` (default `8G`).

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
  and the `oauthAccount` from the host config if present)
- the workspace bind-mounted at `/workspace`

No host `~/.claude` state (settings, history, plugins, commands) is mounted, so
the sandbox can't read or modify it. If Claude refreshes its OAuth token during
the session, the new credentials are copied back to the host so the host login
stays valid.
