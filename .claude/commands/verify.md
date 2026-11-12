# Verify Code

코드 변경 후 전체 검증을 실행합니다.

## 실행 순서

1. ESLint 검사
2. TypeScript 타입 검사
3. 프로덕션 빌드
4. 유닛 테스트

## 명령어

전체 검증:

```bash
bun run lint && bun run typecheck && bun run build && bun run test
```

## 개별 실행

문제가 발생하면 개별적으로 확인:

```bash
bun run lint       # ESLint - 코드 스타일
bun run typecheck  # TypeScript - 타입 오류
bun run build      # Vite - 빌드 오류
bun run test       # Vitest - 테스트 실패
```

## 자동 수정

lint 오류 자동 수정:

```bash
bun run lint --fix
```

## 언제 실행?

- PR 생성 전
- 커밋 전
- 기능 구현 완료 후
- 리팩토링 후
