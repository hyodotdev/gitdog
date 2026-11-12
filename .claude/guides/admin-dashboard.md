# Admin Dashboard

관리자 전용 페이지 구조와 사용법.

## 접근 권한

`userProfiles.isAdmin === true`인 사용자만 접근 가능.
권한 없으면 404 페이지 표시.

## 페이지 구조

```text
/admin/payments   - 결제 대시보드
/admin/workflows  - AI 워크플로우 로그
```

### Payments (`/admin/payments`)

**기능:**

- 월별 매출 통계 (월 선택 가능)
- All-time 매출 (Lemon Squeezy 대시보드와 비교용)
- 구독자 목록 관리
- 사용자별 결제 내역
- 토큰 추가/환불 기능

**데이터 소스:**

- `paymentLogs` - 결제 이벤트 로그
- `subscriptions` - 구독 정보

### Workflows (`/admin/workflows`)

**기능:**

- AI 호출 로그 조회
- 티켓별 / 인덱싱별 / 전체 로그 뷰
- 성공률, 토큰 사용량, 비용 통계

**데이터 소스:**

- `aiLogs` - AI 호출 로그
- `tickets` - 이슈/PR 티켓

## 컴포넌트 구조

```text
src/pages/admin/
├── components/       # 공유 컴포넌트
│   ├── StatCard.tsx
│   ├── EmptyState.tsx
│   └── ExpandableSection.tsx
├── payments/
│   ├── index.tsx
│   ├── SubscriptionRow.tsx
│   └── PurchaseHistoryCard.tsx
└── workflows/
    ├── index.tsx
    ├── TicketCard.tsx
    ├── RepositoryCard.tsx
    └── LogItem.tsx
```

## Admin Check 패턴

```typescript
// Query에서
const isAdmin = useQuery(api.admin.query.isAdmin);

// 로딩 중
if (isAdmin === undefined) return <LoadingIndicator />;

// 권한 없음
if (!isAdmin) return <NotFoundPage />;

// 권한 있음 - 데이터 쿼리
const data = useQuery(
  api.admin.paymentQuery.getPaymentStats,
  isAdmin ? { year, month } : "skip"
);
```

## Convex Admin Functions

```text
convex/admin/
├── query.ts          # isAdmin 등 기본 쿼리
├── paymentQuery.ts   # 결제 통계 쿼리
├── paymentMutation.ts # 토큰 추가/환불
└── testMutation.ts   # 결제 테스트용 (개발)
```
