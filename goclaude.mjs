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
const DISK = process.env.GOCLAUDE_DISK ?? "8G";

const home = os.homedir();
const claudeHome = path.join(home, ".claude");
const claudeConfig = path.join(home, ".claude.json");

let args = process.argv.slice(2);
let workspace = process.cwd();

if (args[0] && fs.existsSync(args[0]) && fs.statSync(args[0]).isDirectory()) {
  workspace = path.resolve(args.shift());
}

if (!fs.existsSync(claudeHome)) {
  throw new Error(`Claude home not found: ${claudeHome}`);
}

if (!fs.existsSync(claudeConfig)) {
  throw new Error(`Claude config not found: ${claudeConfig}`);
}

const { assetDir } = await ensureImageSelector(IMAGE);

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
      "/root/.claude": new RealFSProvider(claudeHome),
    },
  },
});

// use vm node_modules (need pnpm|npm install)
await vm.exec(`
  mkdir -p /workspace/node_modules
  mkdir -p /var/lib/goclaude/node_modules

  mount --bind \
    /var/lib/goclaude/node_modules \
    /workspace/node_modules
`);

try {
  await vm.fs.writeFile("/root/.claude.json", fs.readFileSync(claudeConfig));

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
} finally {
  await vm.close();
}
