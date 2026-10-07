#!/usr/bin/env bash
# Cloudflare Pages 배포용 정적 파일을 dist/ 로 모은다.
# 저장소 루트는 GitHub Pages 호환을 위해 그대로 두고(이동 금지),
# 공개할 파일만 화이트리스트로 복사한다 (docs/·.qa/·테스트·보고서 제외).
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf dist
mkdir -p dist
cp index.html kiosk.html menu.js manifest.json sw.js _headers dist/
cp -R images dist/images
# TWA Digital Asset Links (.well-known/assetlinks.json) — 디렉터리가 있을 때만
if [ -d .well-known ]; then cp -R .well-known dist/.well-known; fi

echo "dist/ 준비 완료:"
find dist -type f | sort
