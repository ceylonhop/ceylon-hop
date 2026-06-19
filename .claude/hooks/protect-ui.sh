#!/usr/bin/env bash
# PreToolUse guard: hard-block edits to the frozen front-end / live-site files.
# Belt-and-suspenders with the permission denylist and the CI protect-ui job.
# Reads the tool-call JSON on stdin; exit 2 blocks the call and feeds stderr back.

input="$(cat)"
path="$(printf '%s' "$input" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);process.stdout.write((j.tool_input&&j.tool_input.file_path)||"")}catch(e){process.stdout.write("")}})')"

# Anything under these trees is fair game — never blocked.
case "$path" in
  */api/*|*/docs/*|*/.claude/*|*/.github/*) exit 0 ;;
esac

base="$(basename "$path")"
case "$base" in
  *.html|site.css|favicon.svg|image-slots.state.json|site.js|booking.js|plan.js|search.js|datepicker.js|image-slot.js|tours-data.js|transfers-data.js|routes-data.js|tweaks.js)
    echo "BLOCKED: '$base' is a frozen front-end / live-site file. The UI is frozen (see CLAUDE.md rule 3). If this is the M7 wiring step, a human must make this change." >&2
    exit 2 ;;
esac

exit 0
