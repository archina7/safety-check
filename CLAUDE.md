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

- 비밀값(SESSION_SECRET, API 키)은 .dev.vars 와 Cloudflare 환경 변수에만 둔다
- 로그인 허용 여부는 서버(functions/_lib.js)가 판정한다
- 화면은 모바일 375px, 태블릿 768px, 데스크탑 1280px 에서 가로 스크롤이 없어야 한다
- 기능을 바꾸면 test/e2e.test.js 에 허용·거부 경우를 함께 추가하고 npm test 를 통과시킨다
