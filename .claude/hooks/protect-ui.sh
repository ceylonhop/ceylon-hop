#!/usr/bin/env bash
# PreToolUse guard: hard-block edits to the frozen front-end / live-site files.
# Belt-and-suspenders with the permission denylist and the CI protect-ui job.
# Reads the tool-call JSON on stdin; exit 2 blocks the call and feeds stderr back.

input="$(cat)"
path="$(printf '%s' "$input" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);process.stdout.write((j.tool_input&&j.tool_input.file_path)||"")}catch(e){process.stdout.write("")}})')"

# Normalize to a repo-relative path (the hook runs with cwd = project root, and
# the tool passes an absolute file_path). This lets us protect the EXISTING root
# files by exact path while allowing new nested pages that share a basename —
# e.g. root index.html stays frozen, but trip/<slug>/index.html is permitted.
rel="${path#"$PWD"/}"

# Anything under these trees is fair game — never blocked.
case "$rel" in
  api/*|docs/*|.claude/*|.github/*) exit 0 ;;
esac
case "$path" in
  */api/*|*/docs/*|*/.claude/*|*/.github/*) exit 0 ;;
esac

# The frozen live-site surface — the EXISTING root files ONLY (M16 Step 0,
# 2026-07-02). New SEO html (route pages under trip/, redirect stubs, and
# terms/privacy/404) is intentionally allowed. PR3's edits to the existing pages
# use the owner-authorized unfreeze + the 'allow-ui-change' PR label.
case "$rel" in
  index.html|about.html|blog.html|booking.html|plan.html|search.html|tour.html|tours.html|why.html|_ops-preview.html|\
  site.css|favicon.svg|image-slots.state.json|\
  booking.js|datepicker.js|image-slot.js|plan.js|routes-data.js|search.js|site.js|tours-data.js|transfers-data.js|tweaks.js)
    echo "BLOCKED: '$rel' is a frozen front-end / live-site file (CLAUDE.md rule 3). New SEO files are allowed; to edit an existing page use the owner-authorized unfreeze + 'allow-ui-change' label." >&2
    exit 2 ;;
esac

exit 0
