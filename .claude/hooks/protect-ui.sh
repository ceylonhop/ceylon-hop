#!/usr/bin/env bash
# PreToolUse guard: hard-block edits to the frozen front-end / live-site files.
# Belt-and-suspenders with the permission denylist and the CI protect-ui job.
# Reads the tool-call JSON on stdin; exit 2 blocks the call and feeds stderr back.

input="$(cat)"

# Canonicalise the target to a repo-relative, lowercased path so path tricks can't
# slip a frozen file past the match: "./index.html", "trip/../index.html",
# "docs/../index.html", "//index.html", and "Index.html" (APFS is case-insensitive)
# all normalise to "index.html". Paths outside the repo come back starting with "..".
rel="$(printf '%s' "$input" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const path=require("path"),fs=require("fs");let cwd=process.cwd();try{cwd=fs.realpathSync(cwd)}catch(e){}const fp=(j.tool_input&&j.tool_input.file_path)||"";if(!fp){process.stdout.write("");return}const rel=path.relative(cwd,path.resolve(cwd,fp));process.stdout.write(rel.toLowerCase())}catch(e){process.stdout.write("")}})')"

# Outside the repo (or unparseable) — not ours to guard.
case "$rel" in
  ""|..|../*) exit 0 ;;
esac

# These trees are always writable.
case "$rel" in
  api/*|docs/*|.claude/*|.github/*) exit 0 ;;
esac

# The frozen live-site surface — the EXISTING root files ONLY (M16 Step 0,
# 2026-07-02). New SEO html (route pages under trip/, redirect stubs, and
# terms/privacy/404) is intentionally allowed. To edit an existing page, use the
# owner-authorized unfreeze + the 'allow-ui-change' PR label (see M16 PR3).
case "$rel" in
  index.html|about.html|blog.html|booking.html|plan.html|search.html|tour.html|tours.html|why.html|_ops-preview.html|\
  site.css|favicon.svg|image-slots.state.json|\
  booking.js|datepicker.js|image-slot.js|plan.js|routes-data.js|search.js|site.js|tours-data.js|transfers-data.js|tweaks.js)
    echo "BLOCKED: '$rel' is a frozen front-end / live-site file (CLAUDE.md rule 3). New SEO files are allowed; to edit an existing page use the owner-authorized unfreeze + 'allow-ui-change' label." >&2
    exit 2 ;;
esac

exit 0
