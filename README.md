# vscode-web → GitHub Pages

Static deployment of the [vscode-web](https://github.com/microsoft/vscode) build as an
installable, offline-capable PWA on GitHub Pages: **<https://sloth-os.github.io/vscode/>**

The site is built from `microsoft/vscode@main` on every push to this repo's `main` branch,
with the patches in [`patches/`](patches/) applied. Everything the site serves is generated
build output — this repo holds only the patches, scripts, and workflow.

## What the patches do

| Patch | Purpose |
| --- | --- |
| `001-web-add-pwa-file-handling.patch` | Adds a workbench contribution that consumes `window.launchQueue` (Web App Launch Handler API), so files opened into the installed PWA by the OS open as real editors (`file:` URIs via `HTMLFileSystemProvider`), and folders open as workspaces. |
| `002-web-build-browser-shell-entry.patch` | Adds the browser-shell entry point (`vs/code/browser/workbench/workbench`) back to the standalone `web` build target — the package's own `workbench.html` references `workbench.js`, which the target no longer emitted. **Required**: without it the package has nothing that reads `vscode-workbench-web-configuration` and boots the workbench. |

## Pipeline

`.github/workflows/deploy.yml` on every push to `main`:

1. Check out `microsoft/vscode` and this repo side by side.
2. Apply `patches/*.patch` (in name order) to the vscode tree.
3. `pnpm install` (vscode's postinstall also installs the separate `build/`, `remote/`, `remote/web/` roots).
4. `pnpm run gulp vscode-web-min` → writes the `vscode-web` package next to the checkout.
5. `scripts/prepare-static.mjs` turns the package into a deployable site (in place):
   - renders `index.html` from the packaged template (config: absolute `callbackRoute`, workspace trust, `embedderIdentifier`)
   - writes `manifest.webmanifest` (installable PWA, `file_handlers` for ~18 file types, icons at the package root)
   - writes `sw.js` — precaches all of `out/` + `extensions/` + icons, cache versioned by content hash, navigations network-first, assets cache-first
   - copies `callback.html` (not part of the package), writes `offline.html`
6. Uploads and deploys via GitHub Pages actions.

Base path: `/vscode` (repo name under `sloth-os.github.io`).

## Local testing

```bash
# after building the package (steps 3–4 above) and preparing it:
node scripts/prepare-static.mjs --base /vscode --vscode-root <vscode-checkout> <vscode-web-package>

# serve it under /vscode/ exactly like Pages does:
mkdir -p /tmp/serve && ln -sfn <vscode-web-package> /tmp/serve/vscode
python3 scripts/serve-local.py /tmp/serve

# functional smoke test (workbench boots, SW activates):
VSCODE_ROOT=<vscode-checkout> node scripts/smoke-test-browser.mjs

# offline smoke test (full precache + workbench boots with network cut):
VSCODE_ROOT=<vscode-checkout> node scripts/smoke-test-offline.mjs
```

`serve-local.py` must be threaded — the SW install fires ~1400 concurrent-ish fetches and
a single-threaded server stalls them until the install gives up.
