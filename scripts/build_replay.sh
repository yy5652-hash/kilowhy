#!/usr/bin/env bash
# Build the static replay of the UI into web/dist-replay (the GitHub Pages site). No server runs there, so the UI
# opens in replay mode: it shows the saved real answers bundled in web/src/fixtures/ (copied from eval/answers/).
#   ./scripts/build_replay.sh            build only
#   ./scripts/build_replay.sh --publish  build, then force-push the result to the gh-pages branch
set -euo pipefail
cd "$(dirname "$0")/.."
cp eval/answers/why-did-our-electricity-cost-more-in-the-last-four.json \
   eval/answers/why-did-brixton-use-more-electricity-s2.json \
   eval/answers/what-should-we-change-to-save-money.json web/src/fixtures/
(cd web && npx tsc --noEmit && npx vite build --base=./ --outDir dist-replay --emptyOutDir)
touch web/dist-replay/.nojekyll
echo "built web/dist-replay"

if [ "${1:-}" = "--publish" ]; then
  remote="$(git remote get-url origin)"
  email="$(git log -1 --format=%ae)"   # same author as the main branch
  name="$(git log -1 --format=%an)"
  (cd web/dist-replay && rm -rf .git && git init -q && git checkout -q -b gh-pages \
    && git -c user.email="$email" -c user.name="$name" add -A \
    && git -c user.email="$email" -c user.name="$name" commit -q -m "Replay build of the Kilowhy UI (saved real answers)" \
    && git push -q -f "$remote" gh-pages && rm -rf .git)
  echo "published to the gh-pages branch"
fi
