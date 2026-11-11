# vscode-web → GitHub Pages

Static deployment of the [vscode-web](https://github.com/microsoft/vscode) build as an
installable, offline-capable PWA on GitHub Pages: **<https://sloth-os.github.io/vscode/>**

The site is rebuilt from `microsoft/vscode@main` **every Monday at 04:23 UTC**, and on every
push to this repo's `main` branch (or on demand from the Actions tab), with the patches in
[`patches/`](patches/) applied. Everything the site serves is generated build output — this
repo holds only the patches, scripts, and workflow.

## What the patches do

| Patch | Purpose |
| --- | --- |
| `001-web-add-pwa-file-handling.patch` | Adds a workbench contribution that consumes `window.launchQueue` (Web App Launch Handler API), so files opened into the installed PWA by the OS open as real editors (`file:` URIs via `HTMLFileSystemProvider`), and folders open as workspaces. |
| `002-web-build-browser-shell-entry.patch` | Adds the browser-shell entry point (`vs/code/browser/workbench/workbench`) back to the standalone `web` build target — the package's own `workbench.html` references `workbench.js`, which the target no longer emitted. **Required**: without it the package has nothing that reads `vscode-workbench-web-configuration` and boots the workbench. |

## Pipeline

`.github/workflows/deploy.yml` on the weekly schedule (`cron: '23 4 * * 1'`, Monday 04:23 UTC),
on every push to `main`, and on `workflow_dispatch`:

1. Check out `microsoft/vscode` and this repo side by side; record the upstream commit.
2. Apply `patches/*.patch` (in name order) with `git apply --3way`. The pre-image blobs are vendored under [`patches/base/`](patches/base/) (captured at `patches/BASE_SHA`), so benign upstream context drift auto-merges even on the depth-1 checkout; a genuine conflict fails fast with regeneration instructions in the job summary.
3. `pnpm install` (vscode's postinstall also installs the separate `build/`, `remote/`, `remote/web/` roots). pnpm and Node versions come from the checkout itself (`packageManager` field / `.nvmrc`) — never from a stale pin, which upstream's `preinstall.ts` would hard-fail. The patched source is then type-checked, because esbuild never checks types and a semantically drifted patch would otherwise ship as a silently dead contribution.
4. `pnpm run gulp vscode-web-min` → writes the `vscode-web` package next to the checkout.
5. `scripts/prepare-static.mjs` turns the package into a deployable site (in place):
   - prunes the unreachable `out/vs/sessions` payload (~44 MiB the site can never request)
   - renders `index.html` from the packaged template (config: absolute `callbackRoute`, workspace trust, `embedderIdentifier`); any upstream template drift that would silently skip a rewrite throws instead
   - writes `manifest.webmanifest` (installable PWA, `file_handlers` for ~18 file types, icons at the package root)
   - writes `sw.js` — precaches all of `out/` + `extensions/` + `node_modules/` + icons, cache versioned by content hash, navigations network-first, assets cache-first. Installs are resumable with per-URL retries and request persistent storage; updates never `skipWaiting`, so long-lived PWA sessions keep their cache until all old tabs close
   - copies `callback.html` (not part of the package), writes `offline.html`
6. Run `scripts/check-site.sh` (structure, PWA metadata, precache completeness, bundle markers, size gate), then upload and deploy via GitHub Pages actions.
7. After deploying, re-verify the **live** Pages origin (statuses, content types, sampled precache URLs). Scheduled runs finish by committing an empty commit to `main`
   (`chore: weekly build of microsoft/vscode@<sha> [skip ci]`). It records which upstream
   commit the live site was built from, and keeps the cron armed: GitHub disables scheduled
   workflows in a public repo after 60 days with no *repository* activity, and a workflow run
   or Pages deployment does not count as activity. Pull before committing locally.

Base path: `/vscode` (repo name under `sloth-os.github.io`).

## Failure alerting

The workflow runs weekly against a moving `microsoft/vscode@main`, so a patch can
stop applying at any time. When a run fails, the `alert` job opens (or comments on)
an issue labelled `ci-alert` in this repo with a link to the run.

Two caveats:

- Scheduled-run notifications are opt-in personal settings and are routed only to
  whoever created the workflow / last changed its cron syntax — that is why the
  issue alert exists.
- In a public repository, scheduled workflows are automatically disabled after 60
  days without *repository* activity. The weekly keep-alive commit (pipeline step 7)
  prevents that, but if weekly runs ever stop appearing, check Settings > Actions
  and re-enable the workflow.

## Local testing

```bash
# after building the package (steps 3–4 above) and preparing it:
node scripts/prepare-static.mjs --base /vscode --vscode-root <vscode-checkout> <vscode-web-package>

# structural / PWA / precache checks (same script CI runs):
bash scripts/check-site.sh <vscode-web-package> /vscode

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
