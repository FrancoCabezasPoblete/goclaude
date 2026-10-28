import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureImageSelector, VM } from "@earendil-works/gondolin";
import { createWorkspaceProvider, dependencyEnv } from "../workspace.mjs";

// Opt-in: requires QEMU, a guest rebuilt with Gondolin >= 0.14.0, and internet
// access from the guest to install the small npm/PyPI test dependencies.
const image = process.env.GOCLAUDE_VM_TEST_IMAGE;

test("guest package managers work in nested ephemeral dependency directories", {
  skip: !image && "set GOCLAUDE_VM_TEST_IMAGE to run VM integration tests",
  timeout: 300_000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goclaude-vm-workspace-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function file(name, content) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  function json(name, data) {
    file(name, JSON.stringify(data));
  }
  json("package.json", { name: "fixture-root", private: true, dependencies: { semver: "7.7.2" } });
  file("pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n  - 'packages/*'\n");
  json("apps/frontend/package.json", {
    name: "fixture-app", private: true,
    dependencies: { "@fixture/shared": "workspace:*", semver: "7.7.2" },
  });
  json("packages/shared/package.json", { name: "@fixture/shared", version: "1.0.0", main: "index.js" });
  file("packages/shared/index.js", "module.exports = 42;\n");
  json("npm-app/package.json", { name: "fixture-npm-app", private: true, dependencies: { semver: "7.7.2" } });
  const dependencyDirs = [
    "node_modules", "apps/frontend/node_modules", "packages/shared/node_modules",
    "npm-app/node_modules", "services/api/.venv", "tools/python/.venv", ".pnpm-store",
  ];
  for (const dir of dependencyDirs) file(`${dir}/host-marker`, "do not modify");

  const { assetDir } = await ensureImageSelector(image);
  const makeVM = () => VM.create({
    sandbox: { imagePath: assetDir },
    memory: "2G",
    rootfs: { size: "4G" },
    env: dependencyEnv,
    vfs: { mounts: { "/workspace": createWorkspaceProvider(root) } },
  });
  const vm = await makeVM();
  t.after(() => vm.close());
  async function exec(command, cwd = "/workspace") {
    const result = await vm.exec(["/bin/sh", "-lc", `set -eu\n${command}`], { cwd });
    assert.equal(result.ok, true, `${command}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  }

  await t.test("nested chmod reaches the memory layer (requires rebuilt guest)", async () => {
    await exec(`
      test ! -e apps/frontend/node_modules
      mkdir apps/frontend/node_modules
      printf '#!/bin/sh\nprintf executable' > apps/frontend/node_modules/probe
      chmod 755 apps/frontend/node_modules/probe
      test "$(apps/frontend/node_modules/probe)" = executable
      rm -r apps/frontend/node_modules
    `);
  });

  await t.test("pnpm links root and nested packages and imports from its ephemeral store", async () => {
    await exec(`
      pnpm store path | grep -q '^/workspace/\\.pnpm-store/'
      pnpm install --ignore-scripts
      test -d .pnpm-store
      test -L apps/frontend/node_modules/@fixture/shared
      test -d node_modules/.pnpm
      ./node_modules/.bin/semver 1.2.3
    `);
    await exec(`
      node -e 'const a = require("node:assert/strict"); a.equal(require("@fixture/shared"), 42); a.equal(require("semver").valid("1.2.3"), "1.2.3")'
      ./node_modules/.bin/semver 2.3.4
    `, "/workspace/apps/frontend");
    // New package created after VM startup: no initial filesystem scan involved.
    await exec(`
      mkdir -p apps/created-later/node_modules
      printf late > apps/created-later/node_modules/guest-only
    `);
    assert.equal(fs.existsSync(path.join(root, "apps/created-later/node_modules")), false);
  });

  await t.test("npm installs and executes from another nested directory", async () => {
    await exec(`
      npm install --ignore-scripts --no-audit --no-fund
      ./node_modules/.bin/semver 3.4.5
    `, "/workspace/npm-app");
  });

  await t.test("uv and pip install executable scripts into separate nested virtualenvs", async () => {
    await exec(`
      uv venv services/api/.venv
      uv pip install --python services/api/.venv/bin/python cowsay==6.1
      services/api/.venv/bin/python -c 'import cowsay'
      services/api/.venv/bin/cowsay -t uv-ok
      uv venv --seed tools/python/.venv
      tools/python/.venv/bin/python -m pip install --disable-pip-version-check cowsay==6.1
      tools/python/.venv/bin/cowsay -t pip-ok
    `);
  });

  for (const dir of dependencyDirs) {
    assert.deepEqual(fs.readdirSync(path.join(root, dir)), ["host-marker"], dir);
    assert.equal(fs.readFileSync(path.join(root, dir, "host-marker"), "utf8"), "do not modify");
  }
  await vm.close();
  const fresh = await makeVM();
  t.after(() => fresh.close());
  const reset = await fresh.exec(["/bin/sh", "-lc", `
    set -eu
    test ! -e /workspace/node_modules
    test ! -e /workspace/apps/frontend/node_modules
    test ! -e /workspace/services/api/.venv
    test ! -e /workspace/tools/python/.venv
    test ! -e /workspace/.pnpm-store
    test -f /workspace/pnpm-lock.yaml
    test -f /workspace/npm-app/package-lock.json
  `]);
  assert.equal(reset.ok, true, `${reset.stdout}\n${reset.stderr}`);
});
