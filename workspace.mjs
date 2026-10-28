import { MemoryProvider, RealFSProvider, ShadowProvider } from "@earendil-works/gondolin";

const dependencyDirectories = new Set(["node_modules", ".venv", ".pnpm-store"]);

// Keep package-manager caches/imports on the ephemeral side of the workspace.
// ShadowProvider does not forward hard links, so import packages by copying.
export const dependencyEnv = Object.freeze({
  pnpm_config_store_dir: "/workspace/.pnpm-store",
  pnpm_config_package_import_method: "copy",
  // Older pnpm versions use npm_config_*; current versions use pnpm_config_*.
  npm_config_store_dir: "/workspace/.pnpm-store",
  npm_config_package_import_method: "copy",
  UV_LINK_MODE: "copy",
});

export function isDependencyPath({ path }) {
  return path.split("/").some(component => dependencyDirectories.has(component));
}

export function createWorkspaceProvider(workspace) {
  return new ShadowProvider(new RealFSProvider(workspace), {
    shouldShadow: isDependencyPath,
    writeMode: "tmpfs",
    // One fresh layer per VM, shared by all nested dependency directories.
    tmpfs: new MemoryProvider(),
  });
}
