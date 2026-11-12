# Convex Patterns

## File Organization

각 기능 모듈은 다음 파일들로 구성:

```text
convex/[feature]/
├── query.ts           # Public queries (client에서 호출)
├── mutation.ts        # Public mutations
├── action.ts          # Actions (외부 API 호출 등)
├── internalQuery.ts   # Internal queries (서버에서만 호출)
├── internalMutation.ts # Internal mutations
└── utils.ts           # 공유 유틸리티 함수 (checkAdmin 등)
```

**중요**: `convex/` 루트에 barrel export 파일 생성 금지

## API 호출 패턴

Dot notation 사용:

```typescript
// Good
api.repositories.query.list;
api.repositories.mutation.toggleActive;
internal.paymentLogs.internalMutation.createLog;

// Bad
api["repositories/query"].list;
```

## Query Best Practices

### .collect() 및 무한 증가 쿼리 금지

`.collect()`와 `.take(n)`은 계속 쌓이는 데이터에서 사용 금지. 데이터가 n개를 초과하면 누락 발생.

```typescript
// Bad - 모든 로그를 메모리에 로드
const allLogs = await ctx.db.query("paymentLogs").collect();

// Bad - 50,000개 초과 시 데이터 누락
const logs = await ctx.db
  .query("paymentLogs")
  .withIndex("by_status", (q) => q.eq("status", "success"))
  .take(50000);
```

### Summary Table 패턴 (집계 데이터)

계속 쌓이는 데이터의 집계(합계, 카운트 등)는 Summary Table 사용:

```typescript
// 1. Schema에 summary table 정의 (singleton 패턴)
paymentStatsSummary: defineTable({
  key: v.literal("global"),
  totalRevenueCents: v.number(),
  totalOrders: v.number(),
  updatedAt: v.number(),
}).index("by_key", ["key"]),

// 2. 데이터 삽입 시 summary도 함께 업데이트
export const createLog = internalMutation({
  handler: async (ctx, args) => {
    // 로그 삽입
    await ctx.db.insert("paymentLogs", { ... });

    // Summary 업데이트 (성공 시)
    if (args.status === "success") {
      const summary = await ctx.db
        .query("paymentStatsSummary")
        .withIndex("by_key", (q) => q.eq("key", "global"))
        .first();

      await ctx.db.patch(summary._id, {
        totalRevenueCents: summary.totalRevenueCents + args.amountCents,
        totalOrders: summary.totalOrders + 1,
        updatedAt: Date.now(),
      });
    }
  },
});

// 3. 조회 시 summary에서 O(1)로 가져옴
const summary = await ctx.db
  .query("paymentStatsSummary")
  .withIndex("by_key", (q) => q.eq("key", "global"))
  .first();
// summary.totalRevenueCents, summary.totalOrders 사용
```

### 기간 제한 쿼리 (안전)

특정 기간 내 데이터는 `.take(n)` 사용 가능 (기간이 제한되어 있으므로):

```typescript
// Good - 한 달 데이터는 유한함
const monthlyLogs = await ctx.db
  .query("paymentLogs")
  .withIndex("by_created", (q) =>
    q.gte("createdAt", startOfMonth).lt("createdAt", endOfMonth),
  )
  .order("desc")
  .take(10000); // 월별 데이터는 10,000개 미만 예상
```

### Index 사용 (filter 대신)

```typescript
// Good - index 사용
const user = await ctx.db
  .query("userProfiles")
  .withIndex("by_user", (q) => q.eq("userId", userId))
  .first();

// Bad - filter 사용
const user = await ctx.db
  .query("userProfiles")
  .filter((q) => q.eq(q.field("userId"), userId))
  .first();
```

### N+1 Query 방지

루프 안에서 개별 쿼리 대신 배치 조회 사용:

```typescript
// Bad - N+1 query
const enrichedLogs = await Promise.all(
  logs.map(async (log) => {
    const userProfile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", log.userId))
      .first();
    return { ...log, userName: userProfile?.displayName };
  }),
);

// Good - 배치 조회 후 Map으로 매핑
const userIds = [...new Set(logs.map((log) => log.userId).filter(Boolean))];
const userProfiles = await Promise.all(
  userIds.map((userId) =>
    ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first(),
  ),
);

const userProfileMap = new Map<string, Doc<"userProfiles">>();
userProfiles.forEach((profile, index) => {
  if (profile) userProfileMap.set(userIds[index], profile);
});

const enrichedLogs = logs.map((log) => {
  const userProfile = log.userId ? userProfileMap.get(log.userId) : null;
  return { ...log, userName: userProfile?.displayName };
});
```

## Auth & Admin 체크

### 공유 유틸리티 사용

중복 방지를 위해 `utils.ts`에 공유 함수 정의:

```typescript
// convex/admin/utils.ts
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type AdminCheckResult = {
  isAdmin: boolean;
  userId: Id<"users"> | null;
};

export async function checkAdmin(
  ctx: QueryCtx | MutationCtx,
): Promise<AdminCheckResult> {
  const userId = await getAuthUserId(ctx);
  if (!userId) return { isAdmin: false, userId: null };

  const profile = await ctx.db
    .query("userProfiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();

  return { isAdmin: profile?.isAdmin === true, userId };
}
```

### 사용 예시

```typescript
import { checkAdmin } from "./utils";

export const myQuery = query({
  handler: async (ctx) => {
    const { isAdmin, userId } = await checkAdmin(ctx);
    if (!isAdmin) throw new Error("Admin access required");
    // ...
  },
});
```

## Type Safety

### ID 검증 후 캐스팅

string을 Id로 캐스팅할 때는 먼저 검증:

```typescript
// convex/admin/utils.ts
export function isValidConvexId(id: string): boolean {
  return (
    typeof id === "string" && id.length >= 20 && /^[a-zA-Z0-9_-]+$/.test(id)
  );
}

// 사용
if (!isValidConvexId(args.targetUserId)) {
  throw new Error("Invalid user ID format");
}

const subscription = await ctx.db
  .query("subscriptions")
  .withIndex("by_user", (q) => q.eq("userId", args.targetUserId as Id<"users">))
  .first();
```

### as never 사용 금지

타입 시스템을 우회하는 `as never` 사용 금지:

```typescript
// Bad
.withIndex("by_user", (q) => q.eq("userId", userId as never))

// Good - 검증 후 적절한 타입으로 캐스팅
.withIndex("by_user", (q) => q.eq("userId", userId as Id<"users">))
```

## Internal vs Public Functions

- `internal.*`: 서버 간 호출용 (webhook, scheduled jobs)
- `api.*`: 클라이언트 호출용

```typescript
// Webhook에서 internal mutation 호출
await ctx.runMutation(
  internal.subscriptions.internalMutation.addPurchasedTokens,
  {
    userId,
    tokensToAdd: 2_200_000,
  },
);
```

## Schema Indexes

자주 사용하는 인덱스 패턴:

```typescript
defineTable({
  userId: v.id("users"),
  createdAt: v.number(),
  // ...
})
  .index("by_user", ["userId"])
  .index("by_created", ["createdAt"]) // 날짜 범위 쿼리용
  .index("by_user_and_month", ["userId", "createdAt"]);
```
