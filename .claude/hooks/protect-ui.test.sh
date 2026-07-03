#!/usr/bin/env bash
# Verifies protect-ui.sh blocks the frozen live-site files and allows new SEO files.
# Paths are built under $PWD (the repo root) to match how the tool passes absolute
# file paths and how the hook normalizes them to repo-relative.
set -u
HOOK="$(dirname "$0")/protect-ui.sh"
fail=0
check() { # <repo-relative path> <expected-exit>
  echo "{\"tool_input\":{\"file_path\":\"$PWD/$1\"}}" | bash "$HOOK" >/dev/null 2>&1
  local got=$?; [ "$got" = "$2" ] || { echo "FAIL $1: want $2 got $got"; fail=1; }
}
# frozen root files → blocked (exit 2)
for f in index.html about.html blog.html booking.html plan.html search.html tour.html tours.html why.html _ops-preview.html \
         site.css favicon.svg image-slots.state.json site.js booking.js plan.js search.js datepicker.js image-slot.js tours-data.js transfers-data.js routes-data.js tweaks.js; do
  check "$f" 2
done
# new SEO files → allowed (exit 0). Note trip/<slug>/index.html shares a basename
# with the frozen homepage but must be permitted.
for f in trip/kandy-to-ella/index.html trip/index.html terms.html privacy.html 404.html about-us/index.html sitemap.xml robots.txt tools/generate-route-pages.mjs; do
  check "$f" 0
done
# api/docs/.claude/.github always allowed
for f in api/src/x.ts docs/y.md .claude/settings.json .github/workflows/ci.yml; do
  check "$f" 0
done
# path-normalisation bypasses that MUST still be blocked (all resolve to a frozen file)
for f in ./index.html trip/../index.html docs/../index.html /index.html Index.html BOOKING.JS ./site.css; do
  check "$f" 2
done
[ "$fail" = 0 ] && echo "protect-ui: ALL PASS" || { echo "protect-ui: FAILURES"; exit 1; }
