#!/usr/bin/env bash
# Remove a service's old images from the current Docker daemon, keeping the ones
# Helm has actually deployed most recently.
#
#   scripts/prune-deploy-images.sh <release> <image> [keep]
#   e.g. scripts/prune-deploy-images.sh web ghcr.io/renchi/church-cms/web       # Deploy: keep 2
#        scripts/prune-deploy-images.sh web church-cms-web 1                     # cluster-up.sh
#
# Why: every deploy adds a ~1.3 GB "<image>:<tag>" (built on the host, pulled into
# minikube), and nothing removed the old ones. After CMS-26 the 62 GB disk was at 99%.
# `docker builder prune` doesn't help with this: it only clears build cache.
#
# Which tags are kept: the newest <keep> distinct tags of <image> that appear in the
# release's Helm history with status "deployed" or "superseded" (default 2: what's
# running now, and what `helm rollback` would go back to). Failed revisions don't
# count, so a deploy that failed and was rolled back can't push the real rollback
# target out. Image build times aren't used: a cache-hit rebuild keeps an old
# CreatedAt, so they don't say which tag was deployed when. The "main" tag (Deploy's
# moving tag) is always kept.
#
# Safe by construction: it only removes tags of the one repository it's given, and
# only when the daemon answered. Never swap this for `docker image prune -a`: the
# minikube container itself runs on an *untagged* kicbase image, which that deletes.
set -euo pipefail

release="${1:?usage: $0 <release> <image> [keep]}"
image="${2:?usage: $0 <release> <image> [keep]}"
keep_count="${3:-2}"

# Newest first. --max bounds the work: older revisions can't be among the kept ones.
mapfile -t revisions < <(
  helm history "$release" --max 20 -o json \
    | jq -r '.[] | select(.status == "deployed" or .status == "superseded") | .revision' \
    | sort -rn
)

keep=(main)
for rev in "${revisions[@]}"; do
  (( ${#keep[@]} > keep_count )) && break
  values=$(helm get values "$release" --revision "$rev" -o json)
  [[ "$(jq -r '.image.repository // ""' <<<"$values")" == "$image" ]] || continue
  tag=$(jq -r '.image.tag // ""' <<<"$values")
  [[ -n "$tag" && " ${keep[*]} " != *" $tag "* ]] && keep+=("$tag")
done

# A plain assignment (not `mapfile < <(...)`), so a daemon that doesn't answer fails
# the script instead of looking like "nothing to remove".
listing=$(docker images "$image" --format '{{.Tag}}')

removed=0
while IFS= read -r tag; do
  [[ -z "$tag" || "$tag" == "<none>" || " ${keep[*]} " == *" $tag "* ]] && continue
  # A tag still used by a container (a Pod that hasn't rolled yet) can't be removed;
  # that's fine, it goes on the next run.
  if docker image rm "$image:$tag" >/dev/null 2>&1; then
    echo "  removed $image:$tag"
    removed=$((removed + 1))
  else
    echo "  kept $image:$tag (still in use)"
  fi
done <<<"$listing"

echo "$image: kept ${keep[*]:1} (from helm history of '$release'), removed $removed"
