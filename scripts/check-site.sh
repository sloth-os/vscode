#!/usr/bin/env bash
# Static sanity checks for the prepared GitHub Pages site.
# Usage: scripts/check-site.sh <site-dir> [base]
#
# Every check maps to a real failure class this pipeline has hit or could hit
# against a moving upstream main: missing bundles (patch 002 drift), silently
# skipped rewrites (prepare-static anchor drift), broken PWA metadata (icon
# layout drift), incomplete precache (offline regressions), dead PWA file
# handling (patch 001 semantic drift). Exits non-zero on any failure so the
# CI build job stops before uploading a broken site.
set -u
SITE="${1:?usage: check-site.sh <site-dir> [base]}"
BASE="${2:-/vscode}"
cd "$SITE"
fail=0
bad() { echo "  FAIL $*"; fail=$((fail+1)); }
ok()  { echo "  ok   $*"; }

echo "== 0: core files exist =="
for f in index.html callback.html manifest.webmanifest sw.js offline.html \
         out/nls.messages.js out/vs/code/browser/workbench/workbench.js \
         out/vs/code/browser/workbench/workbench.css; do
  [ -f "$f" ] && ok "$f" || bad "$f missing"
done

echo "== 0b: no .map files shipped in out/ or extensions/ =="
if find out extensions -name '*.map' | grep -q .; then bad ".map files present"; else ok "no .map files"; fi

echo "== A: every src/href in index.html is base-prefixed and resolves to a real file =="
urls=$(grep -oE '(src|href)="[^"]+"' index.html | sed -E 's/^(src|href)="//; s/"$//' | grep -v '^$' | sort -u)
[ -n "$urls" ] || bad "no src/href found in index.html at all"
while read -r u; do
  [ -n "$u" ] || continue
  case "$u" in \#*|data:*|mailto:*) continue;; esac
  case "$u" in http*|//*) bad "index.html references external URL (offline-hostile): $u"; continue;; esac
  p="${u#"$BASE"/}"
  [ "$p" = "$u" ] && bad "index.html ref not base-prefixed (would escape the Pages sub-path): $u" && continue
  [ -f "$p" ] && ok "$u" || bad "$u -> $p missing"
done <<< "$urls"

echo "== B: no leftover placeholders, no resources/server refs =="
grep -qE '\{\{[A-Za-z_]+\}\}' index.html && bad "unreplaced {{PLACEHOLDER}} in index.html" || ok "no unreplaced placeholders"
grep -q 'resources/server' index.html && bad "resources/server ref left in index.html" || ok "no resources/server ref"

echo "== C: server resources landed flat at the site root =="
for i in code-192.png code-512.png favicon.ico; do
  [ -f "$i" ] && ok "$i at site root" || bad "$i missing from site root"
done

echo "== D: prepare-static's string-replacement rewrites actually applied =="
grep -q "serviceWorker.register('$BASE/sw.js')" index.html \
  && ok "SW registration injected" \
  || bad "serviceWorker.register NOT injected — offline + PWA install silently gone"
grep -qF "<link rel=\"manifest\" href=\"$BASE/manifest.webmanifest\" />" index.html \
  && ok "stock manifest swapped for manifest.webmanifest" \
  || bad "manifest link NOT swapped — stock manifest.json (start_url '/', no file_handlers) shipped"
grep -q 'manifest.json' index.html && bad "index.html still references stock manifest.json" || ok "no manifest.json ref"
grep -q 'file_handlers' manifest.webmanifest && ok "manifest.webmanifest has file_handlers" || bad "file_handlers missing — PWA File Handling goal unmet"

echo "== E: manifest-referenced paths exist and are sub-path safe =="
node -e '
const fs=require("fs");
const m=JSON.parse(fs.readFileSync("manifest.webmanifest","utf8"));
let bad=0;
for(const i of m.icons||[]){const p=i.src.replace(/^\.\//,"");if(!fs.existsSync(p)){console.log("  FAIL manifest icon missing: "+i.src);bad++;}}
if(m.start_url!=="./"){console.log("  FAIL start_url is not ./");bad++;}
for(const h of m.file_handlers||[]){if(h.action!=="./"){console.log("  FAIL file_handler action is not ./");bad++;}}
if(!bad)console.log("  ok   manifest icons "+(m.icons||[]).length+", file_handlers "+(m.file_handlers||[]).length+", start_url "+m.start_url);
process.exit(bad?1:0);' || fail=$((fail+1))

echo "== F: sw.js precache is non-trivial, complete, and on-disk =="
node -e '
const fs=require("fs");
const s=fs.readFileSync("sw.js","utf8");
const m=s.match(/PRECACHE_URLS = (\[[\s\S]*?\]);/);
if(!m){console.log("  FAIL PRECACHE_URLS not found in sw.js");process.exit(1);}
const a=JSON.parse(m[1]);
console.log("  precache entries: "+a.length);
let bad=0;
if(a.length<300){console.log("  FAIL precache suspiciously small ("+a.length+")");bad++;}
const set=new Set(a);
const named=["index.html","manifest.webmanifest","offline.html",
  "out/nls.messages.js","out/vs/code/browser/workbench/workbench.js",
  "out/vs/code/browser/workbench/workbench.css",
  "code-192.png","code-512.png","favicon.ico",
  "node_modules/vscode-oniguruma/release/onig.wasm",
  "node_modules/vscode-oniguruma/release/main.js",
  "node_modules/vscode-textmate/release/main.js"];
for(const n of named){
  if(!set.has(n)){console.log("  FAIL precache missing runtime file: "+n);bad++;}
}
let miss=0;
for(const u of a) if(!fs.existsSync(u)){miss++;if(miss<=5)console.log("  FAIL precached but absent on disk: "+u);}
if(miss){console.log("  FAIL "+miss+" precache entries do not exist on disk");bad++;}
if(!bad)console.log("  ok   precache complete ("+a.length+" entries) and every entry exists");
process.exit(bad?1:0);' || fail=$((fail+1))

echo "== G: patch-001 PWA file-handling contribution made it into the built bundle =="
grep -rq 'launchQueue' out --include='*.js' \
  && ok "launchQueue consumer present in out/" \
  || bad "launchQueue absent from out/ — patch 001 did not land in the built bundle"
# The contribution ID is a string literal, so it survives minification. It must
# be in the shell bundle the page actually loads (patch 002's output) and in
# the internal bundle the contribution is built from. NOTE: this only proves
# the contribution is *bundled*, not that it works — semantic drift is caught
# by the workflow's type-check step, not here.
grep -q 'workbench.contrib.webPwaFileHandling' out/vs/code/browser/workbench/workbench.js \
  && ok "webPwaFileHandling in workbench.js (shell bundle)" \
  || bad "webPwaFileHandling absent from workbench.js — patch 001 not in the shipped bundle"
grep -q 'workbench.contrib.webPwaFileHandling' out/vs/workbench/workbench.web.main.internal.js \
  && ok "webPwaFileHandling in workbench.web.main.internal.js" \
  || bad "webPwaFileHandling absent from workbench.web.main.internal.js"

echo "== H: site size within GitHub Pages limits =="
bytes=$(du -sb . | cut -f1)
files=$(find . -type f | wc -l)
echo "  site size: $((bytes / 1048576)) MiB in ${files} files"
# Fail well before the published-site 1 GB limit; the deploy also has a 10 min
# timeout, and a ~250 MiB artifact was observed to take ~2 min to publish.
if [ "$bytes" -lt 900000000 ]; then ok "under the 900 MB gate"; else bad "site exceeds the 900 MB gate (${bytes} bytes)"; fi

echo "== summary: $fail failing check(s) =="
exit $(( fail > 0 ))
