# Code Review

코드 리뷰를 수행합니다. 변경된 파일들을 분석하고 피드백을 제공합니다.

## 리뷰 기준

### 1. 기능 정확성

- 요구사항 충족 여부
- 엣지 케이스 처리
- 에러 핸들링

### 2. 코드 품질

- 함수/컴포넌트 크기 (100줄 이하 권장)
- 단일 책임 원칙
- 중복 코드 여부
- 네이밍 명확성

### 3. 성능

- 불필요한 리렌더링
- N+1 쿼리 문제
- 메모이제이션 필요 여부

### 4. 보안

- 인증/인가 체크
- 입력값 검증
- SQL Injection, XSS 등 OWASP 취약점

### 5. Convex 패턴 준수

- `.withIndex()` 사용 (`.filter()` 금지)
- Auth 체크 여부
- Dot notation API 호출

### 6. 프로젝트 컨벤션

- UI: border-radius 없음 (rectangular)
- Color: Black/white monochrome
- Font: Space Grotesk (brand), Inter (body)
- State: Signals (global), useState (local)

## 리뷰 방법

```bash
# 변경된 파일 확인
git diff --name-only HEAD~1

# 또는 staged 파일
git diff --staged --name-only
```

## 리뷰 출력 형식

```markdown
## Summary

전체적인 변경 사항 요약

## Good

- 잘된 점들

## Suggestions

- 개선 제안들 (파일:라인 형식으로)

## Questions

- 확인이 필요한 부분
```
