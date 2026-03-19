#!/bin/bash
# Bumps VERSION = 'YYYYMMDD.N' in the edited file when it's index.html or client/faq.html.
# Called by the PostToolUse hook — receives Claude tool JSON on stdin.

f=$(jq -r '.tool_input.file_path // ""')
[ -z "$f" ] && exit 0

# Only act on the two versioned files
echo "$f" | grep -qE '(^|/)index\.html$|(^|/)client/faq\.html$' || exit 0
[ -f "$f" ] || exit 0

today=$(date +%Y%m%d)
# Match only the standalone declaration line (not inside JS regex strings)
current=$(grep -m1 -oP "^\s*const VERSION = '\K\d{8}\.\d+" "$f" 2>/dev/null || true)
[ -z "$current" ] && exit 0

dp="${current%%.*}"
bp="${current##*.}"
if [ "$dp" = "$today" ]; then
    nb=$((bp + 1))
else
    nb=1
fi

new_version="${today}.${nb}"
# Replace only the standalone declaration, not occurrences inside strings/regexes
sed -i "s/^\([ \t]*const VERSION = '\)[^']*'/\1${new_version}'/" "$f"
echo "[bump-version] $f → $new_version"
