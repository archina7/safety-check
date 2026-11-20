# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# 현장 안전점검 (safety-check)

Cloudflare Pages 정적 화면(public/)과 Pages Functions(functions/)로 된 앱이다.

## 실행

- 로컬: `cp .dev.vars.example .dev.vars` 후 값을 채우고 `npm run dev` → http://localhost:8788
- 테스트: `npm test` (wrangler pages dev 를 띄워 로그인 허용·거부를 확인한다). 구글 대신 테스트용 RSA 키로 ID 토큰을 만들고 `GOOGLE_CERTS_URL`(localhost 주소만 받아들임)로 공개키를 넘긴다. `.dev.vars` 가 있으면 테스트 설정을 덮어쓸 수 있으니 테스트가 그 이유로 멈추면 잠시 치운다
- 배포: 자동 배포는 쓰지 않는다. `npm test` 통과 후 `npx wrangler pages deploy public --project-name safety-check --branch main` 으로 직접 배포한다 → https://safety-check-ezs.pages.dev . GitHub Actions 는 테스트만 돈다
- Pages 환경 변수(`GOOGLE_CLIENT_ID`, `ALLOWED_EMAILS`, `SESSION_SECRET`)가 하나라도 없으면 사이트 전체가 503 이다 (`npx wrangler pages secret put <이름> --project-name safety-check`)

## 규칙

- 비밀값(SESSION_SECRET, ANTHROPIC_API_KEY 등 API 키)은 .dev.vars(로컬)와 Cloudflare 비밀값(운영, `wrangler pages secret put`)에만 둔다. 코드에서는 functions/ 의 `env.<이름>` 으로만 읽고 public/ 에는 넣지 않는다. `.dev.vars.example` 에는 이름만 적고 값은 비운다
- 커밋 전 검사: `.githooks/pre-commit` 이 비밀값 파일과 키 모양 문자열을 막는다. 새로 클론하면 `git config core.hooksPath .githooks` 로 켠다
- 로그인 허용 여부는 서버(functions/_lib.js)가 판정한다
- 화면은 모바일 375px, 태블릿 768px, 데스크탑 1280px 에서 가로 스크롤이 없어야 한다
- 기능을 바꾸면 test/e2e.test.js 에 허용·거부 경우를 함께 추가하고 npm test 를 통과시킨다

## AI 기능 규칙 (Claude API)

이 프로젝트에 AI(Agent·Worker) 기능을 만들 때는 아래를 모두 지킨다.

- Claude API는 공식 SDK로만 부른다. 이 프로젝트(JavaScript, functions/)는 `@anthropic-ai/sdk`, Python 스크립트는 `anthropic`. OpenAI 호환 방식이나 직접 fetch 는 쓰지 않는다
- 키는 `ANTHROPIC_API_KEY`. 모델은 `CLAUDE_MODEL`(기본 `claude-opus-5-5`), 단순 분류·추출 Worker 는 `CLAUDE_WORKER_MODEL`(기본 `claude-haiku-5-5`). 모두 env 에서 읽고 코드에 박지 않는다. 호출은 functions/ 에서만 한다
- Agent마다 입력과 출력을 JSON Schema로 정의하고 구조화 출력(`output_config.format`)으로 받는다. 응답이 스키마에 맞지 않으면 한 번 다시 요청하고, 그래도 안 되면 오류로 처리한다
- 금액·일수·비율 같은 계산은 코드(함수)로 한다. Claude에게는 판단과 설명만 맡긴다
- 근거가 없는 법령·판례·수치는 만들지 않는다. 근거가 부족하면 '확인 필요'로 표시한다
- 반복과 재검토는 최대 2회. 실행마다 호출 수와 입력·출력 토큰(`usage.input_tokens`, `usage.output_tokens`)을 로그로 남긴다
- 테스트는 Claude 호출을 고정 응답(mock)으로 바꿔 API 키 없이 돈다 (`npm test` 와 GitHub Actions 에 키가 없다)
- 화면에서 Agent별 입력·출력·소요 시간을 펼쳐 볼 수 있게 한다
- 모델 참고: `claude-opus-5-5` 는 thinking 을 끌 수 없고(`disabled` 는 400) effort 기본값이 `medium` 이라 필요하면 `output_config.effort` 를 명시한다. assistant prefill 은 400 이므로 형식은 구조화 출력으로 맞춘다
