# Convex Function 작성 가이드

새로운 Convex 함수를 작성할 때 따라야 할 패턴입니다.

## 파일 구조

```text
convex/[feature]/
├── query.ts           # Public queries
├── mutation.ts        # Public mutations
├── action.ts          # External API calls
├── internalQuery.ts   # Server-only queries
└── internalMutation.ts # Server-only mutations
```

## Query 템플릿

```typescript
import { query } from "../_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

export const myQuery = query({
  args: {
    // 필요한 인자 정의
  },
  handler: async (ctx, args) => {
    // 1. 인증 체크
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // 2. 인덱스 사용해서 쿼리 (filter 대신 withIndex)
    const result = await ctx.db
      .query("tableName")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    return result;
  },
});
```

## Mutation 템플릿

```typescript
import { mutation } from "../_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

export const myMutation = mutation({
  args: {
    id: v.id("tableName"),
    // 다른 인자들
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // 권한 체크
    const doc = await ctx.db.get(args.id);
    if (!doc || doc.userId !== userId) {
      throw new Error("Not authorized");
    }

    // 업데이트
    await ctx.db.patch(args.id, {
      // 변경 내용
      updatedAt: Date.now(),
    });

    return { success: true };
  },
});
```

## Internal Function 템플릿

```typescript
import { internalMutation } from "../_generated/server";
import { v } from "convex/values";

export const myInternalMutation = internalMutation({
  args: {
    userId: v.string(), // string으로 받고 내부에서 캐스팅
  },
  handler: async (ctx, args) => {
    // 인증 체크 불필요 (서버에서만 호출)

    await ctx.db.insert("tableName", {
      userId: args.userId as Id<"users">,
      createdAt: Date.now(),
    });
  },
});
```

## 주의사항

- `.filter()` 대신 `.withIndex()` 사용
- API 호출은 dot notation: `api.feature.query.name`
- Internal은 `internal.feature.internalMutation.name`
- 루트에 barrel export 파일 생성 금지
