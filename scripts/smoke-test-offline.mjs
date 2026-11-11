#!/usr/bin/env node
// ---------------------------------------------------------------------
// Offline smoke test: verify the service worker precaches the full site
// and the workbench boots from cache with the network cut.
//
// Usage: node scripts/smoke-test-offline.mjs [baseUrl]
//   baseUrl defaults to http://127.0.0.1:8765/vscode/
//
// Note: a fresh page.goto with the network cut fails with
// ERR_INTERNET_DISCONNECTED before the service worker can answer — the
// navigation never reaches the SW. The reload of an already-controlled
// page is the correct offline test.
// ---------------------------------------------------------------------
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
const vscodeRoot = process.env.VSCODE_ROOT ?? new URL('../../../../vscode', import.meta.url).pathname;
const require = createRequire(pathToFileURL(vscodeRoot + '/package.json'));
const { chromium } = require('playwright');

const BASE = process.argv[2] ?? 'http://127.0.0.1:8765/vscode/';

// Read the expected precache size from the generated sw.js (or override
// with PRECACHE_TARGET). Self-calibrating: survives deploys that change
// the file count.
async function precacheTarget() {
	if (process.env.PRECACHE_TARGET) {
		return parseInt(process.env.PRECACHE_TARGET, 10);
	}
	const res = await fetch(new URL('sw.js', BASE));
	const sw = await res.text();
	const m = sw.match(/PRECACHE_URLS = (\[.*?\]);/s);
	if (!m) {
		throw new Error('PRECACHE_URLS not found in sw.js — is the site prepared?');
	}
	return JSON.parse(m[1]).length;
}
const PRECACHE_TARGET = await precacheTarget();

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

console.log(`[offline] loading ${BASE}`);
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 });

// Wait for the service worker to be active, controlling the page, and the
// precache to be completely filled (the install downloads ~1400 files; the
// SW activates only after skipWaiting, but cache writes can still be in
// flight — poll the cache count from Node).
console.log('[offline] waiting for full precache...');
const pollSwState = () => page.evaluate(async (target) => {
	const reg = await navigator.serviceWorker.getRegistration();
	if (!reg?.active || !navigator.serviceWorker.controller) {
		return null;
	}
	const keys = await caches.keys();
	let cachedCount = 0;
	for (const key of keys) {
		const cache = await caches.open(key);
		cachedCount += (await cache.keys()).length;
	}
	return {
		ready: cachedCount >= target,
		scope: reg?.scope,
		state: reg?.active?.state,
		controller: !!navigator.serviceWorker.controller,
		caches: keys,
		cachedCount,
	};
}, PRECACHE_TARGET);

let swInfo = null;
const deadline = Date.now() + 300_000;
while (Date.now() < deadline) {
	swInfo = await pollSwState();
	if (swInfo?.ready) {
		break;
	}
	await page.waitForTimeout(3_000);
}
console.log(`[offline] SW state: ${JSON.stringify(swInfo)}`);

if (!swInfo?.ready) {
	console.log(`[offline] FAIL: precache not complete (cached ${swInfo?.cachedCount ?? 0}/${PRECACHE_TARGET})`);
	await browser.close();
	process.exit(1);
}

await context.setOffline(true);
console.log('[offline] network cut — reloading the app');
try {
	await page.reload({ waitUntil: 'commit', timeout: 30_000 });
	await page.waitForSelector('.monaco-workbench', { timeout: 120_000 });
	const title = await page.title();
	console.log(`[offline] OFFLINE title: ${title}`);
	await page.screenshot({ path: '/tmp/smoke-offline.png' });
	console.log('[offline] PASS: workbench boots from the service worker cache with no network');
	await browser.close();
	process.exit(0);
} catch (err) {
	console.log(`[offline] FAIL: ${String(err).slice(0, 400)}`);
	await page.screenshot({ path: '/tmp/smoke-offline-fail.png' }).catch(() => {});
	await browser.close();
	process.exit(1);
}
