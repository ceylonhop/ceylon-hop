#!/usr/bin/env bash
# PreToolUse guard: hard-block edits to the frozen front-end / live-site files.
# Belt-and-suspenders with the permission denylist and the CI protect-ui job.
# Reads the tool-call JSON on stdin; exit 2 blocks the call and feeds stderr back.

input="$(cat)"

# Canonicalise the target to a repo-relative, lowercased path so path tricks can't
# slip a frozen file past the match. We realpath BOTH the cwd and the target's
# deepest existing ancestor (re-appending any not-yet-created tail), so symlinks
# into the repo — including a symlinked cwd — resolve to the real frozen path.
# "./index.html", "trip/../index.html", "docs/../index.html", "//index.html",
# "Index.html" (APFS is case-insensitive), and "<symlink>/index.html" all normalise
# to "index.html". Paths outside the repo come back starting with "..".
rel="$(printf '%s' "$input" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const path=require("path"),fs=require("fs");let j;try{j=JSON.parse(d)}catch(e){process.stdout.write("__ERR__");return}const fp=(j.tool_input&&j.tool_input.file_path)||"";if(!fp){process.stdout.write("");return}try{const cwd=fs.realpathSync(process.cwd());let p=path.resolve(cwd,fp),tail=[];for(;;){try{p=fs.realpathSync(p);break}catch(e){tail.unshift(path.basename(p));const par=path.dirname(p);if(par===p)break;p=par}}const rel=path.relative(cwd,path.join(p,...tail));process.stdout.write(rel.toLowerCase())}catch(e){process.stdout.write("__ERR__")}})' 2>/dev/null)"

# Fail closed if the resolver saw a path but could not canonicalise it.
if [ "$rel" = "__ERR__" ]; then
  echo "BLOCKED: protect-ui could not resolve the edit path; failing closed." >&2
  exit 2
fi

# Empty (no file path — not a file edit) or outside the repo: not ours to guard.
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
# Footer WhatsApp-number fix (2026-07-03): site.js is TEMPORARILY unfrozen for the
# owner-authorized one-line footer copy correction (a transposed business phone number).
# Restored in the final commit of this PR; CI's protect-ui gate stays satisfied via the
# 'allow-ui-change' label. Same sanctioned-unfreeze pattern as the GL-4 pricing PR.
case "$rel" in
  index.html|about.html|blog.html|booking.html|plan.html|search.html|tour.html|tours.html|why.html|_ops-preview.html|\
  site.css|favicon.svg|image-slots.state.json|\
  booking.js|datepicker.js|image-slot.js|plan.js|routes-data.js|search.js|tours-data.js|transfers-data.js|tweaks.js)
    echo "BLOCKED: '$rel' is a frozen front-end / live-site file (CLAUDE.md rule 3). New SEO files are allowed; to edit an existing page use the owner-authorized unfreeze + 'allow-ui-change' label." >&2
    exit 2 ;;
esac

exit 0
