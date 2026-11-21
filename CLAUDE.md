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

- 비밀값(SESSION_SECRET, OPENAI_API_KEY 등 API 키)은 .dev.vars(로컬)와 Cloudflare 비밀값(운영, `wrangler pages secret put`)에만 둔다. 코드에서는 functions/ 의 `env.<이름>` 으로만 읽고 public/ 에는 넣지 않는다. `.dev.vars.example` 에는 이름만 적고 값은 비운다
- 커밋 전 검사: `.githooks/pre-commit` 이 비밀값 파일과 키 모양 문자열을 막는다. 새로 클론하면 `git config core.hooksPath .githooks` 로 켠다
- 로그인 허용 여부는 서버(functions/_lib.js)가 판정한다
- 화면은 모바일 375px, 태블릿 768px, 데스크탑 1280px 에서 가로 스크롤이 없어야 한다
- 기능을 바꾸면 test/e2e.test.js 에 허용·거부 경우를 함께 추가하고 npm test 를 통과시킨다

## AI 기능 규칙 (OpenAI API)

이 프로젝트에 AI(Agent·Worker) 기능을 만들 때는 아래를 모두 지킨다.

- AI는 OpenAI 공식 SDK(`openai`, 버전 고정)의 Responses API(`client.responses.create`)로만 부른다. 직접 fetch 는 쓰지 않는다. 공용 호출은 `functions/_ai.js` 의 `callAgent` 를 쓴다
- 키는 `OPENAI_API_KEY`(운영에 `OPEN_API_KEY` 로 넣은 값도 받는다). 모델은 `OPENAI_MODEL`(기본 `gpt-6.2-astra`), 단순 분류·추출 Worker 는 `OPENAI_WORKER_MODEL`(기본 `gpt-6-luna`). 기본값은 `_ai.js` 의 `DEFAULT_MODELS` 한 곳에만 둔다. 호출은 functions/ 에서만 한다
- Agent마다 입력과 출력을 JSON Schema로 정의하고 구조화 출력(`text.format`, `type: 'json_schema'`, `strict: true`)으로 받는다. strict 이므로 출력 스키마의 모든 객체는 속성을 전부 `required` 에 넣고 `additionalProperties: false` 를 둔다. 응답이 스키마에 맞지 않으면 한 번 다시 요청하고, 그래도 안 되면 오류로 처리한다
- 금액·일수·비율 같은 계산은 코드(함수)로 한다. Claude에게는 판단과 설명만 맡긴다
- 근거가 없는 법령·판례·수치는 만들지 않는다. 근거가 부족하면 '확인 필요'로 표시한다
- 반복과 재검토는 최대 2회. 실행마다 호출 수와 입력·출력 토큰(`usage.input_tokens`, `usage.output_tokens`)을 로그로 남긴다
- 테스트는 OpenAI 호출을 고정 응답(mock, `test/helpers/ai-mock.js`)으로 바꿔 API 키 없이 돈다 (`npm test` 와 GitHub Actions 에 키가 없다)
- 화면에서 Agent별 입력·출력·소요 시간을 펼쳐 볼 수 있게 한다
- 모델 참고: GPT-6.2 는 `temperature`·`top_p`·logprobs 를 받지 않는다. 판단 정도는 `reasoning.effort`(Agent 는 `medium`)로 정하고, Worker 는 모델 기본값을 쓴다. 고정 지시는 첫 `developer` 메시지에 둔다(top-level `instructions` 는 입력 뒤에 붙어 캐시가 덜 맞는다). 거절은 출력의 `refusal`, 잘림은 `status: 'incomplete'` 와 `incomplete_details.reason` 으로 확인한다
