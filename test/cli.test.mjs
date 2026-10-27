import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseArgs } from "../cli.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("default networking and Claude arguments are unchanged", () => {
  const result = parseArgs(["--continue", "-p", "hello"], root);
  assert.equal(result.workspace, root);
  assert.deepEqual(result.args, ["--continue", "-p", "hello"]);
  assert.deepEqual(result.networkOptions, {});
  assert.equal(result.help, false);
});

test("selected ports map only explicit endpoints to host loopback", () => {
  const result = parseArgs(["--host-port", "3000", "--host-port=5432"]);
  assert.deepEqual(result.networkOptions, {
    dns: { mode: "synthetic", syntheticHostMapping: "per-host" },
    tcp: {
      hosts: {
        "host.internal:3000": "127.0.0.1:3000",
        "host.internal:5432": "127.0.0.1:5432",
      },
    },
  });
  assert.deepEqual(result.args, []);
});

test("options work before and after the workspace", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "goclaude-cli-"));
  try {
    fs.mkdirSync(path.join(temp, "project"));
    for (const argv of [
      ["--host-port", "3000", "project", "--continue"],
      ["project", "--host-port=3000", "--continue"],
    ]) {
      const result = parseArgs(argv, temp);
      assert.equal(result.workspace, path.join(temp, "project"));
      assert.deepEqual(result.args, ["--continue"]);
      assert.equal(result.networkOptions.tcp.hosts["host.internal:3000"], "127.0.0.1:3000");
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("nonexistent workspace candidate remains a Claude argument", () => {
  const result = parseArgs(["does-not-exist", "--host-port", "3000"], root);
  assert.equal(result.workspace, root);
  assert.deepEqual(result.args, ["does-not-exist"]);
});

test("separator forwards wrapper-looking arguments and directories verbatim", () => {
  const result = parseArgs(["--host-port=3000", "--", root, "--help", "--host-port", "bad", "--"]);
  assert.deepEqual(result.args, [root, "--help", "--host-port", "bad", "--"]);
  assert.equal(result.help, false);
  assert.deepEqual(result.networkOptions.tcp.hosts, { "host.internal:3000": "127.0.0.1:3000" });
});

test("Gondolin-compatible mappings support custom ports, names and IPv6 targets", () => {
  const result = parseArgs([
    "--tcp-map", "db.internal:5432=127.0.0.1:15432",
    "--tcp-map=web.internal:8080=[::1]:3000",
    "--tcp-map", "service.internal=localhost:9000",
  ]);
  assert.deepEqual(result.networkOptions.tcp.hosts, {
    "db.internal:5432": "127.0.0.1:15432",
    "web.internal:8080": "[::1]:3000",
    "service.internal": "localhost:9000",
  });
});

test("duplicate mappings are normalized and last mapping wins", () => {
  const result = parseArgs([
    "--host-port=03000",
    "--host-port=3000",
    "--tcp-map=HOST.INTERNAL.:03000=localhost:9000",
  ]);
  assert.deepEqual(result.networkOptions.tcp.hosts, { "host.internal:3000": "localhost:9000" });
});

test("port boundaries are accepted", () => {
  assert.deepEqual(parseArgs(["--host-port=1", "--host-port=65535"]).networkOptions.tcp.hosts, {
    "host.internal:1": "127.0.0.1:1",
    "host.internal:65535": "127.0.0.1:65535",
  });
});

test("invalid or missing host ports fail early", () => {
  for (const argv of [
    ["--host-port"], ["--host-port="], ["--host-port", "--continue"],
    ...["0", "65536", "-1", "3.5", "abc", "3000,5432", "1e3", " 3000"].map(value => [`--host-port=${value}`]),
  ]) {
    assert.throws(() => parseArgs(argv), /--host-port/);
  }
});

test("invalid or missing TCP mappings fail early", () => {
  for (const argv of [
    ["--tcp-map"], ["--tcp-map="], ["--tcp-map", "--continue"],
    ...[
      "db.internal", "=localhost:3000", "db.internal=", "db.internal=localhost",
      "db.internal:0=localhost:3000", "db.internal=localhost:65536",
      "db.internal=localhost:abc", "*.internal=localhost:3000",
      "db.internal=localhost:3000=extra", "db.internal=[oops]:3000",
      "db.internal=http://localhost:3000", "db.internal=::1:3000",
    ].map(value => [`--tcp-map=${value}`]),
  ]) {
    assert.throws(() => parseArgs(argv), /--tcp-map/);
  }
});

test("help works without credentials or a VM image", () => {
  for (const flag of ["--help", "-h"]) {
    const result = spawnSync(process.execPath, [path.join(root, "goclaude.mjs"), flag], {
      encoding: "utf8",
      env: { ...process.env, IMAGE: "/nonexistent/goclaude-test-image" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: goclaude/);
    assert.match(result.stdout, /--host-port/);
    assert.match(result.stdout, /--tcp-map/);
  }
});

test("entry point reports malformed options before image resolution", () => {
  const result = spawnSync(process.execPath, [path.join(root, "goclaude.mjs"), "--host-port=0"], {
    encoding: "utf8",
    env: { ...process.env, IMAGE: "/nonexistent/goclaude-test-image" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /goclaude: --host-port: port must/);
  assert.doesNotMatch(result.stderr, /Error:|credentials|could not be resolved/);
});
