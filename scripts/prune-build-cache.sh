#!/usr/bin/env bash
# Cap the current Docker daemon's build cache by size, keeping the most recently
# used layers. The one place the cap is defined: Deploy's cleanup job and
# scripts/cluster-up.sh both call this, on the host and inside minikube.
#
#   scripts/prune-build-cache.sh     # prints "Total: <reclaimed per pass>", e.g. "Total: 2.6GB + 3.2GB"
#
# A size cap, not an age limit: on one busy day (CMS-26), many /verify builds plus
# two full deploys left ~11 GB of same-day cache, which "older than 24h" never
# touched, and the disk fell to 6.8 GB free.
#
# The cap only applies to cache that can be freed. A cache record whose layer an
# image also uses is "Shared" in `docker buildx du`: deleting the record frees 0 B,
# because the image still holds those bytes. So `docker system df` can show a
# "Build Cache" size above the cap; compare its RECLAIMABLE column instead.
#
# Why 1GB (CMS-33): until CMS-33 the runtime images copied the builder's whole
# node_modules, so almost all cache was shared with images, nothing was ever
# reclaimable (host 0.04 GB, minikube 2.66 GB), and the old 3GB cap never fired.
# Now the builder's "pnpm install" layer (~930 MB) is used by no image, so it IS
# reclaimable. The three Dockerfiles are identical up to that step, so it's ONE
# layer shared by all three builds, and 1GB keeps it. When the lockfile changes,
# the new install layer is the most recently used one and the old one goes.
#
# Why a loop: cache records form chains (each layer record holds its parent), and
# one prune pass only removes records nothing else holds. Their parents become
# removable on the next pass. Measured in CMS-33: pass 1 freed 2.6 GB, pass 2 another
# 3.2 GB, pass 3 nothing. So: prune until a pass frees 0 B, at most 5 passes.
set -euo pipefail

CAP=1GB   # per daemon: the one shared builder "pnpm install" layer

freed=()
for _ in 1 2 3 4 5; do
  # Docker's summary line is "Total:<tab><size>"; keep only the size. If no such
  # line comes back (another buildx version, a warning), say so and stop, rather
  # than loop on something that never reads 0B.
  total=$(docker builder prune -af --max-used-space "$CAP" | awk '/^Total:/ { print $2 }' | tail -1)
  if [[ ! "$total" =~ ^[0-9.]+[kMGT]?B$ ]]; then freed+=("unknown"); break; fi
  freed+=("$total")
  [[ "$total" == 0B ]] && break
done
joined=$(IFS=+; echo "${freed[*]}")
echo "Total: ${joined//+/ + }"
