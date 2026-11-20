# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# 현장 안전점검 (safety-check)

Cloudflare Pages 정적 화면(public/)과 Pages Functions(functions/)로 된 앱이다.

## 실행

- 로컬: `cp .dev.vars.example .dev.vars` 후 값을 채우고 `npm run dev` → http://localhost:8788
- 테스트: `npm test` (wrangler pages dev 를 띄워 로그인 허용·거부를 확인한다)
- 배포: main 에 push 하면 GitHub Actions 가 테스트 후 배포한다. 손으로 배포하지 않는다

## 규칙

- 비밀값(SESSION_SECRET, API 키)은 .dev.vars 와 Cloudflare 환경 변수에만 둔다
- 로그인 허용 여부는 서버(functions/_lib.js)가 판정한다
- 화면은 모바일 375px, 태블릿 768px, 데스크탑 1280px 에서 가로 스크롤이 없어야 한다
- 기능을 바꾸면 test/e2e.test.js 에 허용·거부 경우를 함께 추가하고 npm test 를 통과시킨다
