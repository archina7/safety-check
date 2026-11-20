---
name: cicd
description: safety-check 앱의 배포 절차입니다. npm test 통과 → 커밋·git push(main) → GitHub Actions 실행 확인 → pages.dev 실제 사이트 확인까지 진행합니다. Actions가 실패하면 로그를 읽고 원인을 먼저 보고합니다. "/cicd", "배포해줘", "올려줘", "반영해줘"처럼 safety-check 변경을 배포하려 할 때 사용합니다.
---

# cicd: 테스트 → push → GitHub Actions → pages.dev

배포는 GitHub Actions가 합니다. `main`에 push하면 워크플로가 테스트를 돌리고 Cloudflare Pages에 올립니다. `wrangler pages deploy`로 직접 배포하지 마세요 (CLAUDE.md 규칙).

## 시작 전에 확인할 값

매번 저장소에서 읽습니다. 값을 짐작하지 마세요.

| 항목 | 확인 방법 |
|---|---|
| GitHub 저장소 | `git remote get-url origin` |
| 워크플로 파일 | `.github/workflows/` 안의 배포 워크플로 |
| Pages 프로젝트 이름 | 워크플로의 `--project-name` 값 또는 `wrangler.toml`/`wrangler.jsonc`의 `name` |
| 사이트 주소 | `https://safety-check-ezs.pages.dev` (프로젝트 이름과 다르다. 확인: `npx wrangler pages project list`의 Project Domains) |

아래 경우에는 멈추고 사용자에게 알립니다.
- `origin`이 없음
- 워크플로 파일이 없음
- `gh auth status` 실패 → 사용자에게 `! gh auth login`을 실행해 달라고 요청

## 절차

1. **변경 확인**: `git status --short`와 `git diff --stat`을 실행합니다.
   - 변경이 없고 push할 커밋도 없으면 "배포할 변경 없음"이라고 알립니다. 그 뒤 4번(최근 Actions 실행 상태)과 5번만 보고합니다.
2. **로컬 테스트**: `npm test`를 실행합니다.
   - 실패하면 여기서 멈춥니다. 실패한 테스트 이름과 오류 줄을 보고합니다. 실패한 채로 push하지 않습니다.
3. **커밋·push**
   - 바뀐 파일의 diff를 읽고 비밀값이 들어 있지 않은지 봅니다. 비밀값은 `SESSION_SECRET`, API 키, 토큰, 비밀번호 같은 것입니다. `.dev.vars`와 `.env`는 절대 커밋하지 않습니다. 이상한 것이 있으면 멈추고 묻습니다.
   - `git add`는 파일 이름을 지정해서 합니다. `-A`나 `.`은 쓰지 않습니다.
   - 커밋 메시지는 무엇을 왜 바꿨는지 한 줄로 쓰고, 마지막 줄에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`을 붙입니다.
   - `git push origin main`을 실행합니다. 거절되면 `git pull --rebase origin main` 후 다시 push합니다. 충돌이 나면 멈추고 알립니다.
   - `git ls-remote origin main`의 해시가 `git rev-parse HEAD`와 같은지 확인합니다.
4. **GitHub Actions 확인**
   - 방금 push한 커밋의 실행을 찾습니다: `gh run list --branch main --commit <HEAD 해시> --limit 5`. 실행이 아직 안 보이면 10초 간격으로 최대 1분 다시 봅니다.
   - 완료될 때까지 기다립니다: `gh run watch <run-id> --exit-status`. 시간이 걸리므로 Bash timeout을 600000으로 줍니다.
   - **성공**하면 5번으로 갑니다.
   - **실패**하면 5번으로 넘어가지 말고 아래 "Actions 실패 시"를 따릅니다.
5. **pages.dev 확인** (Actions 성공 후)
   - `https://safety-check-ezs.pages.dev/`가 200이고 로그인 화면이 나오는지 확인합니다.
   - `functions/`에서 로그인이 필요한 경로를 하나 골라, 로그인 없이 요청하면 거부(401 또는 로그인 화면으로 302)되는지 확인합니다. 200이 나오면 로그인 보호가 빠진 것이니 경고합니다. 500이나 503이 나오면 Cloudflare 환경 변수(`SESSION_SECRET` 등)가 빠졌을 수 있다고 알립니다.
   - 배포가 사이트에 반영되기까지 몇십 초 걸릴 수 있습니다. 결과가 예전 그대로이면 15초 간격으로 최대 2분 다시 확인합니다.

## Actions 실패 시: 원인부터 보고

코드를 고치거나 다시 실행하기 전에, 원인을 먼저 보고하고 사용자의 답을 기다립니다.

1. `gh run view <run-id>`로 어느 job과 step이 실패했는지 봅니다.
2. `gh run view <run-id> --log-failed`로 실패한 step의 로그를 읽습니다. 길면 오류 주변만 봅니다.
3. 원인을 분류합니다.
   - **테스트 실패**: 로컬에서는 통과했는데 CI에서 실패했다면 환경 차이를 의심합니다 (Node 버전, CI용 테스트 비밀값 누락, 포트 등).
   - **의존성·빌드 실패**: `npm ci` 오류, lockfile 불일치 등
   - **배포 단계 실패**: `CLOUDFLARE_API_TOKEN`·`CLOUDFLARE_ACCOUNT_ID` 같은 GitHub Secrets 누락, 토큰 권한 부족, 프로젝트 이름 불일치 등
   - **일시적 오류**: 네트워크·Cloudflare 장애 등
4. 아래 형식으로 보고합니다.
   - 실패한 job과 step 이름
   - 원인이 되는 로그 줄을 그대로 인용
   - 원인 판단과 근거
   - 제안하는 조치. 일시적 오류로 보이면 `gh run rerun <run-id> --failed`를 제안합니다. 다만 사용자가 승인하기 전에는 실행하지 않습니다.

## 보고 형식 (정상 완료 시)

- 커밋: `<짧은 해시> <메시지>`와 바뀐 파일 목록
- 로컬 테스트: 통과 수
- Actions: 성공, 실행 URL(`gh run view <run-id> --json url -q .url`), 걸린 시간
- 사이트: `https://safety-check-ezs.pages.dev`, `/`와 보호 경로의 응답 코드
