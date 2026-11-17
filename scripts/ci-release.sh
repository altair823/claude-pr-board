#!/usr/bin/env bash
# main에서 시험이 통과한 뒤 CI가 실행한다. 다음 버전을 정해 release 브랜치에 버전 커밋을 올리고
# v<버전> 태그와 Gitea 릴리스를 만든다. 설치본은 마켓플레이스가 가리키는 release 브랜치만 받는다.
#
# 다음 버전: main의 plugin.json에 적힌 버전이 마지막 태그보다 높으면 그 버전(사람이 minor, major를 올린 경우),
# 아니면 마지막 태그의 patch를 1 올린다. 마지막 릴리스 뒤로 hooks/, types/가 바뀌지 않았으면 릴리스하지 않는다.
#
# 사용: GITEA_TOKEN=<토큰> scripts/ci-release.sh
#       DRY_RUN=1 scripts/ci-release.sh   (push와 릴리스 없이 다음 버전과 노트만 출력)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

git fetch -q --tags --force origin
last="$(git tag -l 'v*' --sort=-v:refname | head -1)"
last="${last#v}"
declared="$(jq -r .version .claude-plugin/plugin.json)"
newer() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]; }

if [ -z "$last" ] || newer "$declared" "$last"; then
    next="$declared"
else
    if git diff --quiet "v$last" HEAD -- hooks types; then
        echo "v$last 뒤로 hooks/, types/가 바뀌지 않아 릴리스하지 않는다"
        exit 0
    fi
    IFS=. read -r major minor patch <<<"$last"
    next="$major.$minor.$((patch + 1))"
fi

# 노트는 지난 릴리스 뒤로 main에 들어온 커밋 제목이다. 릴리스 커밋은 release 브랜치에만 있으므로
# 지난 태그와 main이 갈라진 곳(merge-base)부터 센다.
base="${last:+$(git merge-base "v$last" HEAD)}"
notes="$(git log --no-merges --format='- %s' ${base:+"$base"..}HEAD)"
body="$(printf '%s\n\n## 변경\n\n%s\n\n## 설치\n\n```\nclaude plugin marketplace add altair823/claude-pr-board\nclaude plugin install pr-board@claude-pr-board\n```\n\n이미 설치했다면 claude plugin update pr-board@claude-pr-board로 받고 /reload-plugins로 적용한다.\n' \
    "pr-board $next 릴리스다. main의 시험을 통과한 커밋을 CI가 릴리스했다." "$notes")"

if [ "${DRY_RUN:-}" = 1 ]; then
    printf '다음 버전: %s (마지막 태그 %s, plugin.json %s)\n\n%s\n' "$next" "${last:-없음}" "$declared" "$body"
    exit 0
fi

: "${GITEA_TOKEN:?GITEA_TOKEN이 필요하다}"
# CI의 checkout에는 git 사용자 정보가 없다. 공용 CI의 커밋과 같은 이름으로 기록한다.
export GIT_AUTHOR_NAME=gitea-ci GIT_AUTHOR_EMAIL=gitea-ci@altair823.xyz
export GIT_COMMITTER_NAME=gitea-ci GIT_COMMITTER_EMAIL=gitea-ci@altair823.xyz

tmp="$(mktemp)"
jq --arg v "$next" '.version = $v' .claude-plugin/plugin.json >"$tmp"
mv "$tmp" .claude-plugin/plugin.json
git add .claude-plugin/plugin.json
git commit -q --allow-empty -m "$next 릴리스 [skip ci]"
git tag -a "v$next" -m "$next"

# release 브랜치는 매번 main 위의 새 릴리스 커밋을 가리키므로 강제로 옮긴다. 지난 릴리스는 태그로 남는다.
# 브랜치와 태그를 한 번에 올린다. Gitea의 push mirror는 브랜치 push에만 반응하므로, 나중에 GitHub 미러를 붙여도
# 태그가 브랜치와 함께 넘어간다.
git push -q --force origin HEAD:refs/heads/release "refs/tags/v$next"

curl -sS --fail-with-body -X POST \
    -H @<(printf 'Authorization: token %s\n' "$GITEA_TOKEN") -H 'Content-Type: application/json' \
    "${GITHUB_SERVER_URL:-https://gitea.altair823.xyz}/api/v1/repos/${GITHUB_REPOSITORY:-altair823-org/claude-pr-board}/releases" \
    --data-binary @<(jq -n --arg t "v$next" --arg n "$next" --arg b "$body" '{tag_name: $t, name: $n, body: $b}') >/dev/null
echo "릴리스: v$next"
