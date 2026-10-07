#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  VM,
  RealFSProvider,
  ensureImageSelector,
} from "@earendil-works/gondolin";

const IMAGE = process.env.IMAGE ?? "claude-code:latest";
const MEMORY = process.env.GOCLAUDE_MEMORY ?? "4G";
const DISK = process.env.GOCLAUDE_DISK ?? "4G";

const home = os.homedir();
const credentialsPath = path.join(home, ".claude", ".credentials.json");
const hostConfigPath = path.join(home, ".claude.json");

let args = process.argv.slice(2);
let workspace = process.cwd();

if (args[0] && fs.existsSync(args[0]) && fs.statSync(args[0]).isDirectory()) {
  workspace = path.resolve(args.shift());
}

if (!fs.existsSync(credentialsPath)) {
  throw new Error(`Claude credentials not found: ${credentialsPath}`);
}

// The guest starts clean: only the OAuth credentials and this minimal config
// are seeded. No host ~/.claude state (history, settings, plugins) is mounted.
function defaultClaudeConfig() {
  const config = {
    hasCompletedOnboarding: true,
    autoUpdates: false,
    projects: {
      "/workspace": {
        hasTrustDialogAccepted: true,
      },
    },
  };

  try {
    const { oauthAccount } = JSON.parse(
      fs.readFileSync(hostConfigPath, "utf8"),
    );
    if (oauthAccount) config.oauthAccount = oauthAccount;
  } catch {
    // No host config: the credentials alone are enough to authenticate.
  }

  return config;
}

const credentials = fs.readFileSync(credentialsPath);

let assetDir;
try {
  ({ assetDir } = await ensureImageSelector(IMAGE));
} catch (cause) {
  throw new Error(
    `Image "${IMAGE}" could not be resolved. Build it first with ` +
      `./build-image.sh (or set IMAGE to an existing image).`,
    { cause },
  );
}

const vm = await VM.create({
  sandbox: {
    imagePath: assetDir,
  },

  memory: MEMORY,

  rootfs: {
    size: DISK,
  },

  sessionLabel: "claude",

  vfs: {
    mounts: {
      "/workspace": new RealFSProvider(workspace),
    },
  },
});

let closePromise;
function shutdown() {
  closePromise ??= vm.close().catch(() => {});
  return closePromise;
}

process.once("SIGINT", () => {
  void shutdown().then(() => process.exit(130));
});
process.once("SIGTERM", () => {
  void shutdown().then(() => process.exit(143));
});

try {
  // Seed the credentials and a default config into the clean guest.
  await vm.exec("mkdir -p /root/.claude");
  await vm.fs.writeFile("/root/.claude/.credentials.json", credentials);
  await vm.fs.writeFile(
    "/root/.claude.json",
    JSON.stringify(defaultClaudeConfig(), null, 2),
  );

  // Give the guest its own node_modules so installs never touch the host copy.
  const setup = await vm.exec(`
    chmod 600 /root/.claude/.credentials.json
    mkdir -p /workspace/node_modules
    mkdir -p /var/lib/goclaude/node_modules

    git config --system --add safe.directory /workspace

    mount --bind \
      /var/lib/goclaude/node_modules \
      /workspace/node_modules
  `);

  if (!setup.ok) {
    throw new Error(
      `sandbox setup failed (exit ${setup.exitCode}):\n${setup.stderr}`,
    );
  }

  const proc = vm.exec(
    ["/bin/sh", "-lc", 'exec claude "$@"', "claude", ...args],
    {
      cwd: "/workspace",
      stdin: true,
      pty: true,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  proc.attach(process.stdin, process.stdout, process.stderr);

  const result = await proc;

  process.exitCode = result.exitCode;

  // Claude may refresh its OAuth token during the session; write it back so the
  // host login stays valid.
  try {
    const updated = await vm.fs.readFile("/root/.claude/.credentials.json");
    if (!updated.equals(credentials)) {
      fs.writeFileSync(credentialsPath, updated, { mode: 0o600 });
    }
  } catch {
    // Non-fatal: leave the host credentials untouched.
  }
} finally {
  await shutdown();
}
