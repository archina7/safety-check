---
name: cicd
description: safety-check(현장 안전점검 웹앱) 전용 배포 절차입니다. npm test 통과 → 커밋·git push(main) → wrangler pages deploy 로 직접 배포 → safety-check-ezs.pages.dev 확인 → GitHub Actions 테스트 결과 확인까지 진행합니다. 배포나 Actions가 실패하면 로그를 읽고 원인을 먼저 보고합니다. "/cicd", "safety-check 배포해줘", "안전점검 앱 배포해줘"처럼 safety-check 폴더에서 이 앱을 배포하려 할 때 사용합니다. 다른 프로젝트(crms 등)의 배포에는 쓰지 않습니다.
---

# cicd: 테스트 → push → 직접 배포 → pages.dev 확인

자동 배포는 쓰지 않습니다 (CLAUDE.md). GitHub Actions(`.github/workflows/test.yml`)는 테스트만 돌고, Cloudflare Pages 배포는 이 절차에서 `wrangler pages deploy`로 직접 합니다.

## 고정 값

| 항목 | 값 |
|---|---|
| GitHub 저장소 | `git remote get-url origin` (현재 archina7/safety-check, 다른 프로젝트와 함께 쓰는 저장소) |
| Pages 프로젝트 | `safety-check` (프로덕션 브랜치 `main`) |
| 사이트 주소 | https://safety-check-ezs.pages.dev (프로젝트 이름과 다르다) |
| 배포 대상 | `public/` 정적 화면 + `functions/` 서버 함수 + `wrangler.toml` 설정 |
| Pages 환경 변수 | `GOOGLE_CLIENT_ID`, `ALLOWED_EMAILS`, `SESSION_SECRET`. 하나라도 없으면 사이트 전체가 503 (준비 중 화면) |

## 실행 환경

- 모든 명령은 **Bash 도구**로, **저장소 맨 위 폴더에서** 실행합니다. 첫 명령에 `cd "$(git rev-parse --show-toplevel)" &&`를 붙입니다. wrangler는 `public`, `functions`, `wrangler.toml`을 현재 폴더 기준으로 찾으므로, 다른 폴더에서 실행하면 `functions/`(로그인 보호)가 빠진 채 배포될 수 있습니다.
- PowerShell에서는 `$(git log ...)`의 한글 커밋 메시지가 깨질 수 있어 Bash를 씁니다.
- `npx wrangler whoami`가 로그인 안 됨이면 멈추고 사용자에게 `! npx wrangler login`을 요청합니다.
- `gh auth status`가 실패하면 사용자에게 `! gh auth login`을 요청합니다. Actions 확인(6번)에만 필요하므로 배포는 계속할 수 있습니다.

## 절차

1. **배포할 것이 있는지 확인**
   - `git status --short` → 커밋할 변경
   - `git fetch origin main && git log --oneline origin/main..HEAD` → push 안 된 커밋
   - `npx wrangler pages deployment list --project-name safety-check --environment production --json` → 첫 항목(가장 최근 배포)의 `Source`가 운영에 올라간 커밋입니다. `git rev-parse --short=7 HEAD`와 비교합니다.
   - 셋 다 없으면(변경 없음, push할 커밋 없음, 운영 = HEAD) "배포할 변경 없음"이라고 알리고 5번(사이트 확인)만 보고합니다.
   - 변경은 없는데 운영이 HEAD와 다르면(예: 지난번 push 후 배포 실패) 2번 테스트를 거쳐 4번 배포로 갑니다.
2. **로컬 테스트**: `npm test`를 실행합니다.
   - 실패하면 여기서 멈춥니다. 실패한 테스트 이름과 오류 줄을 보고합니다. 실패한 채로 커밋·배포하지 않습니다.
3. **커밋·push**
   - 바뀐 파일의 diff를 읽고 비밀값이 들어 있지 않은지 봅니다. 비밀값은 `SESSION_SECRET`, API 키, 토큰, 비밀번호 같은 것입니다. `.dev.vars`와 `.env`는 절대 커밋하지 않습니다. 이상한 것이 있으면 멈추고 묻습니다.
   - `git add`는 파일 이름을 지정해서 합니다. `-A`나 `.`은 쓰지 않습니다.
   - 커밋 메시지는 무엇을 왜 바꿨는지 한 줄로 쓰고, 마지막 줄에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`을 붙입니다.
   - `git push origin main`을 실행합니다. push가 안 되면 배포하지 않습니다 (배포된 코드와 GitHub 코드가 어긋나지 않게).
   - 거절되면 `git pull --rebase origin main`을 하고, **다른 사람의 변경이 들어왔으니 `npm test`를 다시 돌린 뒤** push합니다. 테스트가 실패하거나 충돌이 나면 멈추고 알립니다.
   - `git ls-remote origin main`의 해시가 `git rev-parse HEAD`와 같은지 확인합니다.
4. **직접 배포**
   - 배포는 작업 폴더의 파일을 그대로 올립니다. 아래 둘 중 하나라도 출력이 있으면 멈추고 알립니다.
     - `git status --short public functions wrangler.toml` → 커밋 안 된 변경
     - `git status --short --ignored public functions` → `.gitignore`로 숨겨져 있지만 함께 올라갈 파일
   - 실행합니다:
     ```
     npx wrangler pages deploy public --project-name safety-check --branch main --commit-hash "$(git rev-parse HEAD)" --commit-message "$(git log -1 --pretty=%s)" --commit-dirty=false
     ```
   - 출력에서 `Deployment complete!`와 배포별 주소(`https://<해시>.safety-check-ezs.pages.dev`)를 확인합니다. 실패하면 5번으로 넘어가지 말고 아래 "실패 시"를 따릅니다.
   - 1번의 `deployment list ... --json`을 다시 실행해, 첫 항목의 `Source`가 HEAD 짧은 해시와 같은지 확인합니다.
5. **사이트 확인** (https://safety-check-ezs.pages.dev)
   - 화면 요청은 `curl -H "Accept: text/html"`로 보냅니다. 반영까지 몇십 초 걸릴 수 있으니, 예전 결과가 나오면 15초 간격으로 최대 2분 다시 확인합니다.
   - 설정이 다 들어간 경우의 정상 결과:
     - `/` → 302, `Location: /login?next=%2F`
     - `/login` → 200, 로그인 화면
     - `/api/inspections` (Accept 없이) → 401
     - `/manifest.webmanifest`, `/app.js` → 200
   - `/`가 200이면 로그인 보호가 빠진 것이니 경고합니다.
   - 503과 "준비 중입니다" 화면이 나오면 Pages 환경 변수가 빠진 것입니다. `npx wrangler pages secret list --project-name safety-check`는 **비밀값만** 보여 주고 일반 텍스트 변수는 보이지 않으니, 목록에 없다고 바로 "빠졌다"고 하지 말고 Cloudflare 대시보드(Workers & Pages → safety-check → Settings → Variables and Secrets)도 확인해 달라고 함께 안내합니다. 값을 넣은 뒤에는 다시 배포해야 반영됩니다.
6. **GitHub Actions 테스트 확인**
   - `gh run list --branch main --commit <HEAD 해시> --limit 5`로 실행을 찾고(안 보이면 10초 간격으로 최대 1분), `gh run watch <run-id> --exit-status`로 기다립니다. Bash timeout은 600000.
   - 실패하면 아래 "실패 시"를 따릅니다. 배포된 코드는 로컬 테스트를 통과한 것이라 되돌리지 않고, 원인만 먼저 보고합니다.

## 실패 시: 원인부터 보고

코드를 고치거나 다시 실행하기 전에, 원인을 먼저 보고하고 사용자의 답을 기다립니다.

- **배포(wrangler) 실패**: 출력에서 `✘ [ERROR]` 줄을 그대로 인용합니다. 자주 나오는 원인은 로그인 만료(`npx wrangler whoami`), 프로젝트 이름 불일치, 권한 부족, 네트워크 오류입니다. push는 이미 됐으므로, 고친 뒤 `/cicd`를 다시 실행하면 1번에서 "운영 ≠ HEAD"를 보고 배포부터 이어 갑니다.
- **Actions 실패**: `gh run view <run-id>`로 실패한 job·step을 찾고, `gh run view <run-id> --log-failed`로 로그를 읽습니다. 로컬에서는 통과했는데 CI에서 실패했다면 환경 차이(Node 버전, 포트 등)를 의심합니다. `npm ci` 오류면 lockfile을 봅니다.
- 보고 형식:
  - 실패한 단계 (배포 / job·step 이름)
  - 원인이 되는 로그 줄을 그대로 인용
  - 원인 판단과 근거
  - 제안하는 조치. 다시 배포하거나 `gh run rerun <run-id> --failed`로 다시 돌리는 것은 사용자가 승인한 뒤에만 합니다.

## 보고 형식 (정상 완료 시)

- 커밋: `<짧은 해시> <메시지>`와 바뀐 파일 목록
- 로컬 테스트: 통과 수
- 배포: 배포별 주소, 운영(Production) 첫 항목 `Source` = HEAD 여부
- 사이트: 위 경로별 응답 코드
- Actions 테스트: 성공 여부와 실행 URL
