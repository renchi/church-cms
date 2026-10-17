#!/usr/bin/env bash
# Remove superseded deploy images of one service from the current Docker daemon.
#
#   scripts/prune-deploy-images.sh <image> <current-tag>
#   e.g. scripts/prune-deploy-images.sh ghcr.io/renchi/church-cms/web 9e8b177…
#
# Why: every Deploy builds "<image>:<sha>" on the host and minikube pulls it, about
# 1.3 GB per service per deploy, and nothing removed the old ones. The 62 GB disk
# went from 16 GB to 0.9 GB free after one deploy (CMS-26). `docker builder prune`
# doesn't help with this: it only clears build cache, not tagged images.
#
# Keeps: the current tag, the newest older tag (the image `helm rollback` would
# need), and the "main" tag. Removes every other tag of <image>, newest first.
#
# Safe by construction: it only touches tags of the one repository it's given.
# Never swap this for `docker image prune -a`: the minikube container itself runs
# on an *untagged* kicbase image, which prune -a would delete.
#
# Deploy runs it twice per service: against the host daemon (where the image was
# built) and inside minikube (`eval "$(minikube docker-env)"`, where it was pulled).
set -euo pipefail

image="${1:?usage: $0 <image> <current-tag>}"
current="${2:?usage: $0 <image> <current-tag>}"

# All tags of this repository except "main" and the current one, newest first.
# CreatedAt sorts correctly as text: it starts "YYYY-MM-DD HH:MM:SS".
mapfile -t older < <(
  docker images "$image" --format '{{.CreatedAt}}|{{.Tag}}' \
    | grep -v '|<none>$' \
    | awk -F'|' -v cur="$current" '$2 != cur && $2 != "main"' \
    | sort -r | cut -d'|' -f2
)

if (( ${#older[@]} <= 1 )); then
  echo "$image: nothing to remove (keeping $current${older[0]:+ and ${older[0]}})"
  exit 0
fi

echo "$image: keeping $current and ${older[0]} (rollback target)"
for tag in "${older[@]:1}"; do
  # A tag still used by a container (e.g. a Pod that didn't roll) fails to remove;
  # that's fine, it goes on the next run.
  if docker image rm "$image:$tag" >/dev/null 2>&1; then
    echo "  removed $image:$tag"
  else
    echo "  kept $image:$tag (still in use)"
  fi
done
