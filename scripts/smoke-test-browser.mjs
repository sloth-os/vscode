#!/usr/bin/env node
// ---------------------------------------------------------------------
// Smoke test: load the prepared static site in headless Chromium and
// check that the workbench actually boots (not just that files serve).
//
// Usage: node scripts/smoke-test-browser.mjs [baseUrl]
//   baseUrl defaults to http://127.0.0.1:8765/vscode/
// ---------------------------------------------------------------------
// Resolve playwright from the vscode checkout (this script lives in the
// publishing repo, which has no dependencies of its own).
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
const vscodeRoot = process.env.VSCODE_ROOT ?? new URL('../../../../vscode', import.meta.url).pathname;
const require = createRequire(pathToFileURL(vscodeRoot + '/package.json'));
const { chromium } = require('playwright');

const BASE = process.argv[2] ?? 'http://127.0.0.1:8765/vscode/';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];

page.on('console', (msg) => {
	if (msg.type() === 'error') {
		consoleErrors.push(msg.text().slice(0, 300));
	}
});
page.on('pageerror', (err) => {
	pageErrors.push(String(err).slice(0, 300));
});
page.on('requestfailed', (req) => {
	failedRequests.push(`${req.method()} ${req.url()} :: ${req.failure()?.errorText}`);
});
page.on('response', (res) => {
	if (res.status() >= 400) {
		failedRequests.push(`${res.status()} ${res.url()}`);
	}
});

console.log(`[smoke] loading ${BASE}`);
try {
	await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 });

	// Wait for the workbench container to appear (the shell mounts
	// .monaco-workbench on the body once the workbench starts).
	await page.waitForSelector('.monaco-workbench', { timeout: 120_000 });
	console.log('[smoke] workbench container appeared');

	// Wait a bit more for the UI to settle (activity bar, title bar).
	await page.waitForTimeout(5_000);

	const title = await page.title();
	console.log(`[smoke] title: ${title}`);

	const hasActivityBar = await page.locator('.activitybar').count();
	const hasTitleBar = await page.locator('.titlebar').count();
	const bodyClasses = await page.evaluate(() => document.body.className);
	console.log(`[smoke] activitybar: ${hasActivityBar > 0}, titlebar: ${hasTitleBar > 0}`);
	console.log(`[smoke] body classes: ${bodyClasses.slice(0, 120)}`);

	// The service worker should be registered and active.
	const swState = await page.evaluate(async () => {
		const reg = await navigator.serviceWorker.getRegistration();
		return reg ? { scope: reg.scope, active: !!reg.active } : null;
	});
	console.log(`[smoke] service worker: ${JSON.stringify(swState)}`);

	// Take a screenshot for manual inspection.
	await page.screenshot({ path: '/tmp/smoke-workbench.png' });
	console.log('[smoke] screenshot: /tmp/smoke-workbench.png');

	// Report network failures (excluding benign ones).
	const realFailures = failedRequests.filter((f) => !f.includes('favicon'));
	if (realFailures.length > 0) {
		console.log(`[smoke] FAILED REQUESTS (${realFailures.length}):`);
		for (const f of realFailures.slice(0, 15)) {
			console.log(`  ${f}`);
		}
	} else {
		console.log('[smoke] no failed requests');
	}
	if (pageErrors.length > 0) {
		console.log(`[smoke] PAGE ERRORS (${pageErrors.length}):`);
		for (const e of pageErrors.slice(0, 5)) {
			console.log(`  ${e}`);
		}
	} else {
		console.log('[smoke] no page errors');
	}

	const fatalErrors = consoleErrors.filter((e) =>
		!/ResizeObserver|Dehydration|sourcemap|source map|favicon|Download the React DevTools/i.test(e));
	if (fatalErrors.length > 0) {
		console.log(`[smoke] CONSOLE ERRORS (${fatalErrors.length}):`);
		for (const e of fatalErrors.slice(0, 10)) {
			console.log(`  ${e}`);
		}
	} else {
		console.log('[smoke] no fatal console errors');
	}

	const booted = hasActivityBar > 0;
	console.log(booted ? '[smoke] PASS: workbench booted' : '[smoke] FAIL: workbench did not fully boot');
	await browser.close();
	process.exit(booted ? 0 : 1);
} catch (err) {
	console.log(`[smoke] FAIL: ${String(err).slice(0, 500)}`);
	await page.screenshot({ path: '/tmp/smoke-fail.png' }).catch(() => {});
	await browser.close();
	process.exit(1);
}
