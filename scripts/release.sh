#!/usr/bin/env bash
# Starts a release of Chatting with AI Minus.
#
# Usage: scripts/release.sh <X.Y.Z>
#
# Bumps the version in manifest.json, package.json, package-lock.json and
# versions.json, commits, tags and pushes the commit and the tag. The Release
# workflow (.github/workflows/release.yml) then checks, builds and creates a
# draft GitHub release; publish it on GitHub.

set -euo pipefail

VERSION="${1:-}"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 <X.Y.Z> (got '$VERSION')" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is not clean; commit or stash first." >&2
  git status --short >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/$VERSION" >/dev/null; then
  echo "error: tag $VERSION already exists." >&2
  exit 1
fi

npm version "$VERSION" --no-git-tag-version >/dev/null
node -e '
  const fs = require("fs");
  const version = process.argv[1];
  const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
  manifest.version = version;
  fs.writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  const versions = JSON.parse(fs.readFileSync("versions.json", "utf8"));
  versions[version] = manifest.minAppVersion;
  fs.writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");
' "$VERSION"

git commit -m "Release $VERSION" -- manifest.json package.json package-lock.json versions.json
git tag -a "$VERSION" -m "Release $VERSION"
git push --atomic origin HEAD "refs/tags/$VERSION"

echo "Pushed $VERSION. The Release workflow creates a draft release; publish it on GitHub."
