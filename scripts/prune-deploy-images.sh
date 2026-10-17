#!/usr/bin/env bash
# Remove a service's old deploy images from the current Docker daemon, keeping the
# ones its newest Helm revisions run.
#
#   scripts/prune-deploy-images.sh <release> <image> [keep]
#   DRY_RUN=1 scripts/prune-deploy-images.sh …    # print what would be removed, remove nothing
#   e.g. scripts/prune-deploy-images.sh web ghcr.io/renchi/church-cms/web       # Deploy: keep 2
#        scripts/prune-deploy-images.sh web church-cms-web 1                     # cluster-up.sh
#
# Why: every deploy adds a ~1.3 GB "<image>:<tag>" (built on the host, pulled into
# minikube), and nothing removed the old ones. After CMS-26 the 62 GB disk was at 99%.
# `docker builder prune` doesn't help with this: it only clears build cache.
#
# What's kept: the images used by the release's newest <keep> successful revisions
# ("deployed" or "superseded" in `helm history`; default 2 = what runs now, and what
# `helm rollback` goes back to), plus "main". Failed revisions don't count, so a
# failed, rolled-back deploy can't push the real rollback target out. Image build
# dates aren't used: a cache-hit rebuild keeps an old date.
#
# What can be removed: only deploy tags, a 40-character commit SHA (Deploy) or
# "local-…" (cluster-up.sh), of the one repository given. A hand-made tag like
# ":debug" is never touched. Never swap this for `docker image prune -a`: the
# minikube container itself runs on an *untagged* kicbase image, which that deletes.
#
# Local images are a cache of the registry: a removed ghcr tag can always be pulled
# again (pullPolicy IfNotPresent), so "keep the newest revisions" is about disk, not
# about losing anything. Only local-* builds exist nowhere else; they're rebuilt.
#
# Fails closed: if Helm or Docker doesn't answer, or no revision of the release
# can be read, it removes nothing and exits non-zero.
set -euo pipefail

usage="usage: $0 <release> <image> [keep≥1]"
release="${1:?$usage}"
image="${2:?$usage}"
keep_count="${3:-2}"
[[ "$keep_count" =~ ^[1-9][0-9]*$ ]] || { echo "$usage (got keep='$keep_count')" >&2; exit 2; }

# Plain assignments, not `mapfile < <(...)`: a failing command inside a process
# substitution is ignored, and an empty answer would mean "keep nothing".
history=$(helm history "$release" --max 20 -o json)
revisions=$(jq -r --argjson n "$keep_count" \
  '[.[] | select(.status == "deployed" or .status == "superseded") | .revision]
   | sort | reverse | .[:$n] | .[]' <<<"$history")
[[ -n "$revisions" ]] || { echo "$release: no successful revision in helm history; removing nothing" >&2; exit 1; }

keep=(main)
while IFS= read -r rev; do
  # --all: the computed values, so a revision that relied on the chart's default
  # repository (e.g. `helm upgrade --set image.tag=…`) still counts.
  values=$(helm get values "$release" --revision "$rev" --all -o json)
  [[ "$(jq -r '.image.repository // ""' <<<"$values")" == "$image" ]] || continue
  tag=$(jq -r '.image.tag // ""' <<<"$values")
  [[ " ${keep[*]} " == *" $tag "* ]] || keep+=("$tag")   # two revisions can share a tag
done <<<"$revisions"

listing=$(docker images "$image" --format '{{.Tag}}')

removed=0 failed=0
while IFS= read -r tag; do
  [[ "$tag" =~ ^([0-9a-f]{40}|local-.+)$ ]] || continue     # deploy tags only
  [[ " ${keep[*]} " == *" $tag "* ]] && continue
  if [[ -n "${DRY_RUN:-}" ]]; then
    echo "  would remove $image:$tag"
    removed=$((removed + 1))
  elif out=$(docker image rm "$image:$tag" 2>&1); then
    echo "  removed $image:$tag"
    removed=$((removed + 1))
  elif [[ "$out" == *"is being used"* || "$out" == *"must be forced"* ]]; then
    # A container still uses it (a Pod that hasn't rolled yet): it goes on a later run.
    echo "  kept $image:$tag (in use by a container)"
  else
    echo "  could not remove $image:$tag: $out" >&2
    failed=$((failed + 1))
  fi
done <<<"$listing"

kept=("${keep[@]:1}")
verb=removed; [[ -n "${DRY_RUN:-}" ]] && verb="would remove"
echo "$image: kept ${kept[*]:-nothing of this repository} (newest $keep_count revision(s) of '$release'), $verb $removed"
(( failed == 0 )) || exit 1
