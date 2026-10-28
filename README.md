# goclaude

Run [Claude Code](https://claude.com/product/claude-code) inside a
[gondolin](https://github.com/earendil-works/gondolin) micro-VM.

## Prerequisites

- **Node.js >= 24.22.1**.
- **QEMU** — the default micro-VM backend:
  - Debian/Ubuntu: `sudo apt install qemu-system-x86` (or `qemu-system-arm`)
  - macOS: `brew install qemu`
- **Local dependencies** — install with `npm install`. `build-image.sh` uses
  the local Gondolin CLI so the guest helpers match the runtime dependency
  (`@earendil-works/gondolin` >= 0.14.0); a global CLI is not needed.
- **Claude Code credentials** at `~/.claude/.credentials.json`, created by
  logging in to `claude` on the host.
- **Docker** — only when building.

## Build the sandbox image

```bash
./build-image.sh            # alpine
./build-image.sh --docker   # docker
```

Both accept `IMAGE=<tag>` to control the final gondolin image tag.
Rebuild existing images after upgrading to Gondolin 0.14.0: its VFS executable
permission fix requires updated guest helpers, not just the JavaScript package.

## Run

```bash
npm start -- [options] [workspace] [claude args...]
```

or invoke the entry point directly:

```bash
node ./goclaude.mjs [options] [workspace] [claude args...]
```

After removing goclaude options, if the first argument is an existing directory
it becomes the guest `/workspace`; everything else is forwarded to `claude`.
Use `goclaude --help` for wrapper options, or `goclaude -- --help` for Claude's
help. Arguments after `--` are passed to Claude unchanged.

Environment overrides: `IMAGE`, `GOCLAUDE_MEMORY` (default `4G`),
`GOCLAUDE_DISK` (default `4G`).

### Ephemeral dependencies (including monorepos)

The workspace shares source files with the host, but every directory named
`node_modules`, `.venv` or `.pnpm-store` is shadowed at any depth. Host copies
are hidden and left untouched; installs create fresh, per-instance dependencies:

```text
/workspace/node_modules
/workspace/app/node_modules
/workspace/apps/frontend/node_modules
/workspace/services/api/.venv
/workspace/tools/python/.venv
/workspace/.pnpm-store
```

This also applies to directories created after startup. Normal names such as
`node_modules_backup` are not shadowed. Source edits, manifests and lockfiles
still update the host. Dependencies disappear when the instance exits; nothing
is saved under `.goclaude/deps`. Session history and screenshots still persist.

pnpm is configured through the guest environment to use `/workspace/.pnpm-store`.
Package imports use copying (`pnpm_config_package_import_method=copy` and
`UV_LINK_MODE=copy`) because the shadow provider does not forward hard links.
Legacy `npm_config_*` equivalents are also set for older pnpm versions.
Explicit command-line configuration can override package-manager settings;
keep dependency and store locations within the shadowed paths above (or on the
guest filesystem), not another shared source directory.

The shadow layer uses Gondolin `MemoryProvider`: it consumes **host process
memory**, outside the `GOCLAUDE_MEMORY` guest RAM limit, and is accessed via
FUSE. It is not a native guest disk. Separate instances have independent
dependencies but still share source files, so concurrent source edits can conflict.

### Access selected host ports

Host services are not exposed by default. Allow individual **TCP** ports with
repeatable `--host-port` options (also accepts `--host-port=3000`):

```bash
goclaude --host-port 3000 --host-port 5432
goclaude ./my-project --host-port 3000 --continue
npm start -- --host-port 3000 ./my-project
```

Inside the guest, connect to `host.internal:3000` or `host.internal:5432`.
For example, `curl http://host.internal:3000` reaches the service listening on
**host** `127.0.0.1:3000`, even if it only binds to loopback. Guest `localhost`
still refers to the guest, not the host. Only the selected ports are mapped;
normal internet access is unchanged. No host-side listener is created.

For custom names, different ports, or other upstream addresses, use the same
`--tcp-map GUEST_HOST[:PORT]=UPSTREAM_HOST:PORT` syntax as the Gondolin CLI:

```bash
goclaude --tcp-map db.internal:5432=127.0.0.1:15432
goclaude --tcp-map web.internal:8080=[::1]:3000
```

Both options are repeatable and accept `--option=value`. The last mapping for
the same guest host/port wins. Omitting the guest port in `--tcp-map` matches
any guest destination port for that name; prefer explicit ports for narrower
access. Mappings automatically enable Gondolin's per-host synthetic DNS.
These are guest-to-host/upstream connections, not host-to-guest port publishing.
Only expose services you trust the sandbox to use: mapped TCP traffic bypasses
Gondolin's HTTP filtering and secret substitution.

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

## Tests

`npm test` runs unit tests without starting a VM. To also exercise npm
workspaces, npm, uv and pip inside a rebuilt guest (requires QEMU and guest
internet access to npm/PyPI):

```bash
GOCLAUDE_VM_TEST_IMAGE=claude-code:latest npm test
```

The integration test uses a temporary fixture workspace, not your project or
Claude credentials.

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
- the workspace exposed at `/workspace`, with dependency directories shadowed
  by a fresh in-memory layer (see [Ephemeral dependencies](#ephemeral-dependencies-including-monorepos))
- a persisted session-history directory at `<workspace>/.goclaude`, mounted as
  the guest's `~/.claude/projects` (see [Session history](#session-history))
- a screenshot directory at `<workspace>/.goclaude/screenshots`, mounted at
  `/screenshots` (see [Screenshots](#screenshots))

No host `~/.claude` state (settings, history, plugins, commands) is mounted, so
the sandbox can't read or modify it. If Claude refreshes its OAuth token during
the session, the new credentials are copied back to the host so the host login
stays valid.
