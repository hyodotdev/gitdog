# Hooks, Skills, Agents 사용 가이드

Claude Code를 효과적으로 사용하기 위한 세 가지 개념 정리.

## 핵심 구분

| 개념      | 목적           | 특징                              |
| --------- | -------------- | --------------------------------- |
| **Skill** | 사고 기준 고정 | "어떤 기준으로" 할지 정의         |
| **Hook**  | 실행 강제      | "빠지면 안 되는 검사"를 자동 실행 |
| **Agent** | 역할 분리      | "누가" 담당할지 분리              |

## 언제 무엇을 쓸까?

### Skill 사용 시점

- 같은 지시를 매번 반복하고 있을 때
- 코드 스타일, 네이밍 규칙 등 일관성 필요 시
- 특정 작업의 체크리스트가 필요할 때

```text
예: 코드 리뷰 기준, 커밋 메시지 규칙, 테스트 작성 가이드
위치: .claude/commands/*.md
```

### Hook 사용 시점

- Skill에 적어뒀는데 누락될 때
- 강제 실행이 필요한 검증 작업
- 매번 수동으로 실행하기 번거로운 것

```text
예: lint 검사, type check, 테스트 실행, 알림
위치: .claude/settings.json
```

### Agent 사용 시점

- 대화가 길어지면 앞뒤가 안 맞을 때
- 역할 간 객관성이 필요할 때 (구현자 ≠ 리뷰어)
- 복잡한 작업의 단계별 분리

```text
예: 코드 리뷰어, 테스터, 문서 작성자
```

## 주의사항

- **Skill에만 두면**: 누락 위험 있음
- **Hook으로 다 만들면**: 느려짐
- **Agent를 과하게 쪼개면**: 복잡해짐

개인 프로젝트는 Agent 3개 내외가 적당.
"기능"이 아니라 "역할"(산출물이 명확한 단위)로 나누기.

---

## Hooks 상세 가이드

### Hook 이벤트 종류

| Event             | 트리거 시점          | 차단 가능? | Matcher 필요? |
| ----------------- | -------------------- | ---------- | ------------- |
| PreToolUse        | 도구 실행 전         | Yes        | Yes           |
| PostToolUse       | 도구 실행 후         | No         | Yes           |
| UserPromptSubmit  | 사용자 프롬프트 제출 | Yes        | No            |
| Stop              | 메인 에이전트 종료   | Yes        | No            |
| SubagentStop      | 서브에이전트 종료    | Yes        | No            |
| Notification      | 알림 발생            | No         | Yes           |
| PermissionRequest | 권한 요청 시         | Yes        | Yes           |
| PreCompact        | 컨텍스트 압축 전     | No         | No            |
| SessionStart      | 세션 시작/재개       | No         | No            |
| SessionEnd        | 세션 종료            | No         | No            |

### Hook 설정 구조

```json
{
  "hooks": {
    "EventName": [
      {
        "matcher": "ToolPattern",
        "hooks": [
          {
            "type": "command",
            "command": "your-command-here",
            "timeout": 60
          }
        ]
      }
    ]
  }
}
```

### Matcher 패턴

- 정확한 매칭: `"Write"`
- 정규식: `"Edit|Write"`
- 모든 도구: `"*"`
- UserPromptSubmit, Stop 등은 matcher 불필요

### Hook 출력

**Exit codes:**

- `0` = 성공 (작업 허용)
- `2` = 차단 (작업 거부, stderr를 Claude에 표시)
- 기타 = 비차단 에러 (stderr를 사용자에게 표시)

### 실용적인 Hook 예시

#### 1. 커밋 전 검증 (PreToolUse)

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "if echo \"$CLAUDE_TOOL_INPUT\" | grep -q 'git commit'; then bun run lint && bun run typecheck; fi"
          }
        ]
      }
    ]
  }
}
```

#### 2. 파일 수정 후 포맷팅 (PostToolUse)

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '.tool_input.file_path' | xargs -I {} sh -c 'echo {} | grep -q \"\\.ts$\" && bunx prettier --write {}'"
          }
        ]
      }
    ]
  }
}
```

#### 3. 작업 완료 알림 (Stop)

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "osascript -e 'display notification \"Task completed\" with title \"Claude Code\"'"
          }
        ]
      }
    ]
  }
}
```

#### 4. 프롬프트 명확화 (UserPromptSubmit)

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "사용자 요청이 모호하면 먼저 명확한 질문을 해주세요."
          }
        ]
      }
    ]
  }
}
```

### Hook이 받는 입력 (stdin JSON)

```json
{
  "session_id": "세션 ID",
  "transcript_path": "대화 JSON 경로",
  "cwd": "현재 작업 디렉토리",
  "hook_event_name": "이벤트 이름",
  "tool_name": "도구 이름 (PreToolUse/PostToolUse)",
  "tool_input": { "도구 입력" }
}
```

### 설정 파일 위치

| 파일                          | 범위          | Git 추적 |
| ----------------------------- | ------------- | -------- |
| `~/.claude/settings.json`     | 전역 (사용자) | No       |
| `.claude/settings.json`       | 프로젝트      | Yes      |
| `.claude/settings.local.json` | 로컬          | No       |

---

## 이 프로젝트의 구성

### Skills (`.claude/commands/`)

- `verify.md` - 코드 검증 명령어
- `convex-function.md` - Convex 함수 작성 패턴
- `review.md` - 코드 리뷰 체크리스트

### Guides (`.claude/guides/`)

- `project-structure.md` - 기술 스택, 디렉토리 구조
- `convex-patterns.md` - Convex 베스트 프랙티스
- `payment-system.md` - Lemon Squeezy 결제 시스템
- `admin-dashboard.md` - 어드민 페이지 구조
- `hooks-skills-agents.md` - 이 문서

### Hooks (`.claude/settings.json`)

- PreToolUse: 커밋 전 lint/typecheck
- Stop: 작업 완료 알림

## 참고

- [Claude Code Hooks Guide](https://docs.anthropic.com/en/docs/claude-code/hooks)
- 실행을 보장하려면 Hook
- 사고를 고정하려면 Skill
- 상황을 읽어 적용하려면 Agent
