#!/usr/bin/env bash
# Cap the current Docker daemon's build cache by size, keeping the most recently
# used layers. The one place the cap is defined: Deploy's cleanup job and
# scripts/cluster-up.sh both call this, on the host and inside minikube.
#
#   scripts/prune-build-cache.sh     # prints docker's "Total: <reclaimed>" line
#
# A size cap, not an age limit: on one busy day (CMS-26), many /verify builds plus
# two full deploys left ~11 GB of same-day cache, which "older than 24h" never
# touched, and the disk fell to 6.8 GB free.
#
# The cap counts only cache that can be freed. `docker system df` also counts layers
# that images use (no prune can free those), so its "Build Cache" size can read above
# the cap: compare its RECLAIMABLE column instead.
set -euo pipefail

CAP=3GB   # per daemon: about one full set of the three services' layers

docker builder prune -af --max-used-space "$CAP" | tail -1
