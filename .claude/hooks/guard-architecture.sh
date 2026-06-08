#!/usr/bin/env bash
# PreToolUse guard for Edit/Write/MultiEdit.
# Enforces two ADR rules that are easy to violate while moving fast:
#   1. ADR-0007 — do not scaffold deferred services.
#   2. Context-map ACL — never import another context's aggregate; reference by ID.
#
# Exit 2 => block the tool call and feed stderr back to Claude.
# Exit 0 => allow.
set -euo pipefail

input="$(cat)"

# Extract the target path and the text being written, tolerant of tool shape.
file_path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')"
payload="$(printf '%s' "$input" | jq -r '
  [ .tool_input.content,
    .tool_input.new_string,
    (.tool_input.edits // [] | map(.new_string) | join("\n"))
  ] | map(select(. != null)) | join("\n")')"

[ -z "$file_path" ] && exit 0

# Rule 1: deferred services (ADR-0007).
if printf '%s' "$file_path" | grep -Eq 'apps/(identity|finance|communications|groups)-service/'; then
  echo "BLOCKED (ADR-0007): '$file_path' belongs to a deferred service." >&2
  echo "Only members-service, events-service, and web are in active development." >&2
  echo "If this is intentional, disable the guard-architecture hook in .claude/settings.json." >&2
  exit 2
fi

# Rule 2: cross-context aggregate import (context-map ACL).
# Importing the Member aggregate from outside members-service breaks the ACL —
# other contexts reference memberId only and use read models for display data.
if ! printf '%s' "$file_path" | grep -q 'apps/members-service/'; then
  if printf '%s' "$payload" | grep -Eq "import[^\n]*\{[^}]*\bMember\b[^}]*\}[^\n]*from[^\n]*members/domain"; then
    echo "BLOCKED (ACL): '$file_path' imports the Member aggregate across a context boundary." >&2
    echo "Reference by memberId and use a read model for display data (see docs/adr/context-map.md)." >&2
    exit 2
  fi
fi

exit 0
