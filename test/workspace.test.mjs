import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkspaceProvider, dependencyEnv, isDependencyPath } from "../workspace.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goclaude-workspace-"));
  const provider = createWorkspaceProvider(root);
  t.after(async () => {
    await provider.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, provider };
}

async function write(provider, file, content) {
  const handle = await provider.open(file, "w");
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}

async function read(provider, file) {
  const handle = await provider.open(file, "r");
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

test("dependency policy matches exact path components at any depth", () => {
  for (const file of [
    "/node_modules", "/app/node_modules/dep/index.js",
    "/apps/frontend/node_modules/.pnpm/dep/node_modules/dep/index.js",
    "/services/api/.venv/bin/python", "/tools/python/.venv",
    "/.pnpm-store/v10/files/pkg", "/app/.pnpm-store",
  ]) {
    assert.equal(isDependencyPath({ path: file }), true, file);
  }
  for (const file of [
    "/", "/app/src/index.js", "/node_modules_backup/dep",
    "/app/.venv-old/python", "/my-node_modules", "/.pnpm-store-backup",
    "/.git/config", "/.env", "/.goclaude/screenshots/image.png",
  ]) {
    assert.equal(isDependencyPath({ path: file }), false, file);
  }
});

test("host environments are hidden and guest mutations never touch them", async t => {
  const { root, provider } = fixture(t);
  for (const dir of ["node_modules", "app/node_modules", "services/api/.venv", "app/.pnpm-store"]) {
    const hostDir = path.join(root, dir);
    fs.mkdirSync(hostDir, { recursive: true });
    fs.writeFileSync(path.join(hostDir, "host-only"), "host");
    fs.chmodSync(path.join(hostDir, "host-only"), 0o644);
    const virtualDir = `/${dir}`;
    const parent = path.posix.dirname(virtualDir);
    const name = path.posix.basename(virtualDir);
    assert.ok(!(await provider.readdir(parent)).includes(name));
    await assert.rejects(provider.stat(virtualDir), { code: "ENOENT" });
    await assert.rejects(read(provider, `${virtualDir}/host-only`), { code: "ENOENT" });

    // Non-recursive mkdir must materialize a parent that exists only on the host.
    await provider.mkdir(virtualDir);
    await write(provider, `${virtualDir}/host-only`, "guest");
    await provider.chmod(`${virtualDir}/host-only`, 0o755);
    assert.equal((await provider.stat(`${virtualDir}/host-only`)).mode & 0o777, 0o755);
    assert.equal(await read(provider, `${virtualDir}/host-only`), "guest");
    assert.ok((await provider.readdir(parent)).includes(name));
    assert.ok((await provider.readdir(parent, { withFileTypes: true }))
      .some(entry => entry.name === name && entry.isDirectory()));
    await provider.rename(`${virtualDir}/host-only`, `${virtualDir}/renamed`);
    await provider.unlink(`${virtualDir}/renamed`);
    await provider.rmdir(virtualDir);
    assert.ok(!(await provider.readdir(parent)).includes(name));
    assert.equal(fs.readFileSync(path.join(hostDir, "host-only"), "utf8"), "host");
    assert.deepEqual(fs.readdirSync(hostDir), ["host-only"]);
    assert.equal(fs.statSync(path.join(hostDir, "host-only")).mode & 0o777, 0o644);
  }
});

test("new monorepo packages are covered without scanning or creating host dependency dirs", async t => {
  const { root, provider } = fixture(t);
  await provider.mkdir("/apps/new-app", { recursive: true });
  await provider.mkdir("/packages/shared", { recursive: true });
  for (const dir of ["/node_modules", "/apps/new-app/node_modules", "/packages/shared/node_modules"]) {
    await provider.mkdir(dir);
    await write(provider, `${dir}/package.json`, dir);
  }
  await provider.mkdir("/apps/new-app/.venv/bin", { recursive: true });
  await provider.mkdir("/apps/new-app/.pnpm-store", { recursive: true });
  await write(provider, "/apps/new-app/index.js", "shared source");
  assert.equal(fs.readFileSync(path.join(root, "apps/new-app/index.js"), "utf8"), "shared source");
  for (const dir of ["node_modules", "apps/new-app/node_modules", "packages/shared/node_modules", "apps/new-app/.venv", "apps/new-app/.pnpm-store"]) {
    assert.equal(fs.existsSync(path.join(root, dir)), false, dir);
  }
  assert.equal(await read(provider, "/apps/new-app/node_modules/package.json"), "/apps/new-app/node_modules");
  assert.equal(await read(provider, "/packages/shared/node_modules/package.json"), "/packages/shared/node_modules");
});

test("relative links within the pnpm virtual store remain usable", async t => {
  const { provider } = fixture(t);
  await provider.mkdir("/app/node_modules/.pnpm/dep@1/node_modules/dep", { recursive: true });
  await write(provider, "/app/node_modules/.pnpm/dep@1/node_modules/dep/index.js", "module.exports = 42");
  await provider.symlink(".pnpm/dep@1/node_modules/dep", "/app/node_modules/dep");
  assert.equal(await provider.readlink("/app/node_modules/dep"), ".pnpm/dep@1/node_modules/dep");
  assert.equal(await read(provider, "/app/node_modules/dep/index.js"), "module.exports = 42");
});

test("concurrent instances have independent dependency layers", async t => {
  const { root, provider } = fixture(t);
  const other = createWorkspaceProvider(root);
  t.after(() => other.close());
  await provider.mkdir("/node_modules");
  await write(provider, "/node_modules/a", "first instance");
  await assert.rejects(other.stat("/node_modules"), { code: "ENOENT" });
  await other.mkdir("/node_modules");
  await write(other, "/node_modules/a", "second instance");
  assert.equal(await read(provider, "/node_modules/a"), "first instance");
  assert.equal(await read(other, "/node_modules/a"), "second instance");
});

test("a fresh provider recreates dependencies while source and history persist", async t => {
  const { root, provider } = fixture(t);
  await provider.mkdir("/app");
  await provider.mkdir("/app/node_modules");
  await write(provider, "/app/node_modules/guest-only", "ephemeral");
  await write(provider, "/app/index.js", "source");
  await provider.mkdir("/.goclaude/screenshots", { recursive: true });
  await write(provider, "/.goclaude/session.jsonl", "history");
  await write(provider, "/.goclaude/screenshots/image.png", "image");
  await provider.close();
  const fresh = createWorkspaceProvider(root);
  t.after(() => fresh.close());
  await assert.rejects(fresh.stat("/app/node_modules"), { code: "ENOENT" });
  assert.equal(await read(fresh, "/app/index.js"), "source");
  assert.equal(await read(fresh, "/.goclaude/session.jsonl"), "history");
  assert.equal(await read(fresh, "/.goclaude/screenshots/image.png"), "image");
});

test("normal source edits, permissions and similar directory names still reach the host", async t => {
  const { root, provider } = fixture(t);
  for (const dir of ["app/src", "node_modules_backup", "app/.venv-old", "my-node_modules"]) {
    await provider.mkdir(`/${dir}`, { recursive: true });
    await write(provider, `/${dir}/file`, "source");
    assert.equal(fs.readFileSync(path.join(root, dir, "file"), "utf8"), "source");
  }
  await provider.chmod("/app/src/file", 0o755);
  assert.equal(fs.statSync(path.join(root, "app/src/file")).mode & 0o777, 0o755);
});

test("renaming across the dependency boundary cannot mutate the host environment", async t => {
  const { root, provider } = fixture(t);
  fs.mkdirSync(path.join(root, "app"));
  fs.writeFileSync(path.join(root, "app/source"), "source");
  await provider.mkdir("/app/node_modules");
  await assert.rejects(provider.rename("/app/source", "/app/node_modules/source"), { errno: os.constants.errno.EXDEV });
  assert.equal(fs.readFileSync(path.join(root, "app/source"), "utf8"), "source");
});

test("pnpm store and package import settings do not need host config changes", () => {
  assert.equal(dependencyEnv.pnpm_config_store_dir, "/workspace/.pnpm-store");
  assert.equal(dependencyEnv.pnpm_config_package_import_method, "copy");
  assert.equal(dependencyEnv.npm_config_store_dir, "/workspace/.pnpm-store");
  assert.equal(dependencyEnv.npm_config_package_import_method, "copy");
  assert.equal(dependencyEnv.UV_LINK_MODE, "copy");
});
