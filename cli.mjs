import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export const usage = `Usage: goclaude [options] [workspace] [claude args...]

Options:
  --host-port PORT   Allow guest host.internal:PORT to reach host 127.0.0.1:PORT
                    (repeat for each selected TCP port)
  --tcp-map SPEC     Gondolin mapping: GUEST_HOST[:PORT]=UPSTREAM_HOST:PORT
                    (repeat for multiple mappings)
  -h, --help         Show this help
  --                Forward all remaining arguments to Claude unchanged

Examples:
  goclaude --host-port 3000 --host-port 5432 ./my-project --continue
  goclaude --tcp-map db.internal:5432=127.0.0.1:5432
  goclaude -- --help
`;

function parsePort(value, option) {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(`${option}: port must be an integer from 1 to 65535`);
  }
  return Number(value);
}

function parseEndpoint(value, requirePort) {
  // IPv6 upstream addresses must use [address]:port notation.
  const match = /^(\[[^\]]+\]|[^\s:=/\[\]*]+)(?::(\d+))?$/.exec(value);
  if (!match || (requirePort && !match[2])) {
    throw new Error("--tcp-map expects GUEST_HOST[:PORT]=UPSTREAM_HOST:PORT");
  }
  let host = match[1].toLowerCase();
  if (host.startsWith("[")) {
    if (net.isIP(host.slice(1, -1)) !== 6) {
      throw new Error("--tcp-map: invalid IPv6 address");
    }
  } else {
    host = host.replace(/\.+$/, "");
    if (!host) throw new Error("--tcp-map: host must not be empty");
  }
  return host + (match[2] ? `:${parsePort(match[2], "--tcp-map")}` : "");
}

export function parseArgs(argv, cwd = process.cwd()) {
  const args = [];
  const tail = [];
  const hosts = new Map();
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      tail.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    const option = arg.split("=", 1)[0];
    if (option !== "--host-port" && option !== "--tcp-map") {
      args.push(arg);
      continue;
    }
    const value = arg.startsWith(`${option}=`)
      ? arg.slice(option.length + 1)
      : argv[++i];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires an argument`);
    }
    if (option === "--host-port") {
      const port = parsePort(value, option);
      hosts.set(`host.internal:${port}`, `127.0.0.1:${port}`);
    } else {
      const parts = value.split("=");
      if (parts.length !== 2) {
        throw new Error("--tcp-map expects GUEST_HOST[:PORT]=UPSTREAM_HOST:PORT");
      }
      hosts.set(parseEndpoint(parts[0].trim(), false), parseEndpoint(parts[1].trim(), true));
    }
  }

  let workspace = cwd;
  if (args[0]) {
    const candidate = path.resolve(cwd, args[0]);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      workspace = candidate;
      args.shift();
    }
  }

  return {
    workspace,
    args: [...args, ...tail],
    help,
    networkOptions: hosts.size > 0 ? {
      dns: { mode: "synthetic", syntheticHostMapping: "per-host" },
      tcp: { hosts: Object.fromEntries(hosts) },
    } : {},
  };
}
