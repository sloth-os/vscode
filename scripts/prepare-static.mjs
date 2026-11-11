#!/usr/bin/env node
/**
 * Prepares the `vscode-web` build output for static hosting on GitHub Pages.
 *
 * The `vscode-web` package (output of `pnpm gulp vscode-web`) is normally
 * served by the vscode web client server, which renders workbench.html with
 * server-side values (see renderWorkbenchTemplate in
 * src/vs/server/node/webClientServer.ts). On GitHub Pages there is no server,
 * so this script, run against the extracted package:
 *
 *  1. Renders `out/vs/code/browser/workbench/workbench.html` into an
 *     `index.html` with all `{{PLACEHOLDER}}` values filled in.
 *  2. Writes a `manifest.webmanifest` with `file_handlers` (PWA file
 *     handling), offline-capable `start_url`, and install metadata.
 *  3. Generates `sw.js`, a service worker that precaches the entire build
 *     for offline use, versioned by content hash.
 *  4. Writes an offline fallback page and copies the OAuth callback page.
 *
 * Usage:
 *   node scripts/prepare-static.mjs [--base /vscode] [--vscode-root <path>] <build-dir>
 *
 *   --base         absolute base path the site is served from. GitHub Pages
 *                  project sites serve from /<repo>/. Required for correct
 *                  resource URLs when hosted under a sub-path; default ''
 *                  (site served from /). This cannot be auto-detected from
 *                  inside static files: the workbench resolves its base URL
 *                  against the origin (new URL(value, location.origin)),
 *                  so a relative base would drop the sub-path.
 *   --vscode-root  path to the vscode source checkout, used to locate
 *                  callback.html (not shipped in the vscode-web package).
 *                  Default: <build-dir>/../vscode.
 *
 * The site is prepared in place: <build-dir> becomes the site root.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// --- arguments -----------------------------------------------------------------

const args = process.argv.slice(2);
let BASE_PATH = '';
let VSCODE_ROOT = null;
const positional = [];
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--base') {
		BASE_PATH = args[++i] ?? '';
		if (BASE_PATH && !BASE_PATH.startsWith('/')) {
			throw new Error('--base must be an absolute path like /vscode');
		}
	} else if (args[i] === '--vscode-root') {
		VSCODE_ROOT = args[++i] ?? null;
	} else {
		positional.push(args[i]);
	}
}
if (positional.length !== 1) {
	throw new Error('Expected exactly one <build-dir> argument (the vscode-web package directory)');
}
const BUILD_DIR = path.resolve(positional[0]);
// Normalize: '/vscode/' -> '/vscode', '/' -> ''
BASE_PATH = BASE_PATH === '/' ? '' : BASE_PATH.replace(/\/+$/, '');

// --- helpers --------------------------------------------------------------------

async function exists(p) {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

async function walk(dir, filter = () => true, acc = []) {
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await walk(full, filter, acc);
		} else if (entry.isFile() && filter(full)) {
			acc.push(full);
		}
	}
	return acc;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * Same encoding as htmlAttributeEncodeValue in src/vs/base/common/strings.ts,
 * which renderWorkbenchTemplate applies to every placeholder value. The web
 * configuration is JSON containing `"` characters, so it must be entity-
 * encoded to survive inside a double-quoted HTML attribute.
 */
function htmlAttributeEncodeValue(value) {
	return value.replace(/[<>"'&]/g, (ch) => {
		switch (ch) {
			case '<': return '&lt;';
			case '>': return '&gt;';
			case '"': return '&quot;';
			case '\'': return '&apos;';
			case '&': return '&amp;';
		}
		return ch;
	});
}

// --- 1. index.html --------------------------------------------------------------

async function renderIndex() {
	const templatePath = path.join(BUILD_DIR, 'out/vs/code/browser/workbench/workbench.html');
	const template = await fs.readFile(templatePath, 'utf8');

	// The web configuration the server would normally inject. There is no
	// remote authority: the workbench runs entirely in the browser with no
	// connection to any vscode server (no remote extension host, no virtual
	// file system — local storage and the in-browser extension host only).
	//
	// callbackRoute: LocalStorageURLCallbackProvider does
	//   URI.parse(location.href).with({ path: callbackRoute })
	// which REPLACES the whole location path, so this must be an absolute
	// server path including the Pages base path.
	const webConfiguration = {
		callbackRoute: `${BASE_PATH}/callback.html`,
		enableWorkspaceTrust: true,
		productConfiguration: {
			embedderIdentifier: 'github-pages-static',
		},
	};

	// WORKBENCH_WEB_BASE_URL must be an absolute path (like upstream's
	// `/static` route). The template computes
	//   new URL(<value>, window.location.origin)
	// and a relative value would resolve against the origin, dropping the
	// Pages sub-path. '' is correct for a site served from /.
	const baseUrl = BASE_PATH;

	const values = {
		WORKBENCH_WEB_CONFIGURATION: JSON.stringify(webConfiguration),
		WORKBENCH_AUTH_SESSION: '',
		WORKBENCH_WEB_BASE_URL: baseUrl,
		WORKBENCH_NLS_URL: '',
		WORKBENCH_NLS_FALLBACK_URL: `${baseUrl}/out/nls.messages.js`,
		WORKBENCH_SCRIPT_NONCE: '',
	};

	// Same substitution as renderWorkbenchTemplate: attribute-encode every
	// value (unknown placeholders are an error rather than left verbatim).
	let html = template.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
		if (!(key in values)) {
			throw new Error(`Unknown placeholder ${match} in workbench.html`);
		}
		return htmlAttributeEncodeValue(values[key]);
	});

	// Register the service worker for offline support. Runs on window load
	// so it never competes with workbench startup for bandwidth.
	const swRegistration = `\t<script>
\t\tif ('serviceWorker' in navigator) {
\t\t\twindow.addEventListener('load', () => {
\t\t\t\tnavigator.serviceWorker.register('${baseUrl}/sw.js');
\t\t\t});
\t\t}
\t</script>`;

	html = html.replace('<body aria-label="">', `<body aria-label="">\n${swRegistration}`);

	// Swap the stock manifest (start_url '/', no file handlers, served with
	// crossorigin=use-credentials for the server's cookie flow) for the
	// static-hosting variant written by this script.
	html = html.replace(
		/<link rel="manifest" href="[^"]*" crossorigin="use-credentials" \/>/,
		`<link rel="manifest" href="${baseUrl}/manifest.webmanifest" />`
	);

	await fs.writeFile(path.join(BUILD_DIR, 'index.html'), html);
	console.log('[static] wrote index.html');

	// The OAuth callback page is not part of the vscode-web package (the web
	// client server serves it from the source tree), so copy it in.
	const callbackDst = path.join(BUILD_DIR, 'callback.html');
	if (await exists(callbackDst)) {
		console.log('[static] callback.html already present');
		return;
	}
	const vscodeRoot = VSCODE_ROOT ? path.resolve(VSCODE_ROOT) : path.resolve(BUILD_DIR, '../vscode');
	const callbackSrc = path.join(vscodeRoot, 'src/vs/code/browser/workbench/callback.html');
	if (await exists(callbackSrc)) {
		await fs.copyFile(callbackSrc, callbackDst);
		console.log('[static] copied callback.html');
	} else {
		console.warn('[static] warning: callback.html not found (looked in ' + vscodeRoot + ') — OAuth flows will 404');
	}
}

// --- 2. manifest.webmanifest ------------------------------------------------------

async function writeManifest() {
	// The stock manifest (resources/server/manifest.json) has start_url '/'
	// and no file handlers. Write a static-hosting variant. URLs inside the
	// manifest resolve against the manifest URL (site root), so './' works
	// under any base path.
	const manifest = {
		name: 'Code - OSS on the Web',
		short_name: 'Code - OSS',
		id: `${BASE_PATH}/`,
		start_url: './',
		scope: './',
		lang: 'en-US',
		display: 'standalone',
		display_override: ['window-controls-overlay'],
		background_color: '#1f1f1f',
		theme_color: '#1f1f1f',
		icons: [
			{ src: './resources/server/code-192.png', type: 'image/png', sizes: '192x192', purpose: 'any' },
			{ src: './resources/server/code-512.png', type: 'image/png', sizes: '512x512', purpose: 'any' },
			{ src: './resources/server/code-512.png', type: 'image/png', sizes: '512x512', purpose: 'maskable' },
		],
		// PWA file handling: let the OS offer Code - OSS in the "Open with"
		// dialog for these file types. Launches are consumed via
		// window.launchQueue by the webPwaFileHandling contribution (see the
		// patch this repo applies to vscode).
		file_handlers: [
			{
				name: 'Code - OSS',
				action: './',
				accept: {
					'text/plain': ['.txt', '.md', '.markdown', '.log', '.csv', '.tsv'],
					'text/markdown': ['.md', '.markdown'],
					'application/json': ['.json', '.jsonc'],
					'text/javascript': ['.js', '.mjs', '.cjs', '.jsx'],
					'text/typescript': ['.ts', '.tsx', '.mts', '.cts'],
					'text/html': ['.html', '.htm'],
					'text/css': ['.css', '.scss', '.less'],
					'application/xml': ['.xml', '.svg'],
					'application/yaml': ['.yaml', '.yml'],
					'text/x-python': ['.py'],
					'text/x-go': ['.go'],
					'text/x-rust': ['.rs'],
					'text/x-c': ['.c', '.h'],
					'text/x-c++src': ['.cpp', '.cc', '.cxx', '.hpp'],
					'text/x-java': ['.java'],
					'text/x-csharp': ['.cs'],
					'text/x-ruby': ['.rb'],
					'text/x-shellscript': ['.sh', '.bash', '.zsh'],
				},
			},
		],
	};

	await fs.writeFile(path.join(BUILD_DIR, 'manifest.webmanifest'), JSON.stringify(manifest, null, '\t'));
	console.log('[static] wrote manifest.webmanifest with file_handlers');
}

// --- 3. offline.html --------------------------------------------------------------

async function writeOfflinePage() {
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Code - OSS</title>
<style>
body {
	margin: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	min-height: 100vh;
	font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
	background: #1f1f1f;
	color: #cccccc;
}
.card { text-align: center; padding: 24px; max-width: 40rem; }
h1 { font-size: 16px; font-weight: 600; margin: 0 0 8px; }
p { font-size: 13px; line-height: 1.5; margin: 0 0 16px; }
button {
	background: #0078d4; color: #fff; border: none; padding: 6px 14px;
	font-size: 13px; border-radius: 2px; cursor: pointer;
}
</style>
</head>
<body>
<div class="card">
<h1>You are offline</h1>
<p>The workbench could not be loaded from the network. If this app has been
installed and visited before, the editor should still start — try
reloading. Otherwise, reconnect to the network and try again.</p>
<button onclick="location.reload()">Reload</button>
</div>
</body>
</html>
`;
	await fs.writeFile(path.join(BUILD_DIR, 'offline.html'), html);
	console.log('[static] wrote offline.html');
}

// --- 4. sw.js ----------------------------------------------------------------------

async function writeServiceWorker() {
	// The workbench loads hundreds of chunked files at runtime; precaching
	// all of them is the only way to guarantee the editor boots offline. The
	// vscode-web build is tens of MB, which fits fine in a Cache API entry
	// and in a GitHub Pages repo.
	//
	// Strategy:
	//  - PRECACHE everything under out/ and extensions/ plus the generated
	//    pages, at install time (individual fetches, not cache.addAll, so a
	//    single network hiccup doesn't fail the whole install).
	//  - The cache NAME is derived from a content hash of the precache, so
	//    every deploy gets a fresh cache; activate() deletes old ones. This
	//    is what makes cache-first safe: out/ file URLs are stable across
	//    builds (not content-hashed), so without a new cache name a new
	//    deploy would keep serving the previous build's files.
	//  - Navigations are network-first (new deploys picked up promptly),
	//    falling back to the cached index.html / offline.html.
	//  - Other same-origin GETs are cache-first.

	const urls = new Set();

	// Generated pages (written by earlier steps of this script)
	for (const generated of ['index.html', 'manifest.webmanifest', 'offline.html']) {
		if (!(await exists(path.join(BUILD_DIR, generated)))) {
			throw new Error(`Missing generated file: ${generated}`);
		}
		urls.add(generated);
	}

	// Everything under out/ and extensions/ (skip source maps)
	for (const dir of ['out', 'extensions']) {
		const abs = path.join(BUILD_DIR, dir);
		if (!(await exists(abs))) {
			throw new Error(`Missing ${dir}/ in build output at ${abs}`);
		}
		for (const file of await walk(abs, (f) => !f.endsWith('.map'))) {
			urls.add(path.relative(BUILD_DIR, file).replaceAll(path.sep, '/'));
		}
	}

	// Icons and favicon referenced by the page and manifest
	for (const extra of ['resources/server/code-192.png', 'resources/server/code-512.png', 'resources/server/favicon.ico']) {
		if (await exists(path.join(BUILD_DIR, extra))) {
			urls.add(extra);
		}
	}

	// Content hash over all precached files => cache version. Any file
	// change produces a new version and a fresh cache.
	const hash = createHash('sha256');
	const sorted = [...urls].sort();
	for (const url of sorted) {
		hash.update(url);
		hash.update(await fs.readFile(path.join(BUILD_DIR, url)));
	}
	const version = `vscode-web-static-${hash.digest('hex').slice(0, 16)}`;

	const sw = `/* eslint-disable */
// Auto-generated by scripts/prepare-static.mjs — do not edit.
// Service worker for the Code - OSS static web deployment (GitHub Pages).

const VERSION = '${version}';
const PRECACHE_URLS = ${JSON.stringify(sorted)};

self.addEventListener('install', (event) => {
	event.waitUntil((async () => {
		const cache = await caches.open(VERSION);
		// Stage files individually (not cache.addAll): a single failed fetch
		// must not fail the whole install. Missed files are retried by the
		// next install of a newer VERSION.
		await Promise.allSettled(PRECACHE_URLS.map(async (url) => {
			try {
				const response = await fetch(url, { cache: 'reload' });
				if (response && response.ok) {
					await cache.put(url, response);
				}
			} catch (e) {
				// retried by the next install
			}
		}));
		await self.skipWaiting();
	})());
});

self.addEventListener('activate', (event) => {
	event.waitUntil((async () => {
		// Delete caches from previous deploys
		const keys = await caches.keys();
		await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
		await self.clients.claim();
	})());
});

self.addEventListener('fetch', (event) => {
	const request = event.request;

	if (request.method !== 'GET') {
		return;
	}

	const url = new URL(request.url);
	if (url.origin !== self.location.origin) {
		return;
	}

	// App shell navigations: network-first so new deploys are picked up
	// promptly, cached index.html when offline.
	if (request.mode === 'navigate') {
		event.respondWith((async () => {
			try {
				const fresh = await fetch(request);
				return fresh;
			} catch {
				const cached = await caches.match('index.html');
				if (cached) {
					return cached;
				}
				const offline = await caches.match('offline.html');
				if (offline) {
					return offline;
				}
				return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
			}
		})());
		return;
	}

	// Static assets: cache-first. Safe because each deploy has its own
	// content-hashed VERSION cache.
	event.respondWith((async () => {
		const cached = await caches.match(request);
		if (cached) {
			return cached;
		}
		try {
			const response = await fetch(request);
			if (response && response.ok) {
				const cache = await caches.open(VERSION);
				await cache.put(request, response.clone());
			}
			return response;
		} catch {
			return new Response('Offline', { status: 503 });
		}
	})());
});
`;

	await fs.writeFile(path.join(BUILD_DIR, 'sw.js'), sw);
	console.log(`[static] wrote sw.js (version ${version}, ${sorted.length} precached files)`);
}

// --- main ---------------------------------------------------------------------------

await renderIndex();
await writeManifest();
await writeOfflinePage();
await writeServiceWorker();

console.log('[static] site prepared at', BUILD_DIR);
