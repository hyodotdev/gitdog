# Payment System (Lemon Squeezy)

Gitdog는 Lemon Squeezy를 통해 결제를 처리합니다.

## 상품 구조

### Pro 구독 ($9.99/month)

- 월 2.4M 토큰 포함
- 초과 시 토큰 팩 구매 필요
- 내부 서비스 비용 배분율: 18%

### Token Packs (일회성 구매)

| Pack  | Tokens | Price  |
| ----- | ------ | ------ |
| Small | 2.2M   | $9.99  |
| Large | 7.5M   | $29.99 |

### Free Tier

- 월 100k 토큰
- 내부 서비스 비용 배분율: 25%

## 환경 변수

```bash
LS_API_KEY=              # Lemon Squeezy API key
LS_STORE_ID=             # Store ID
LS_WEBHOOK_SECRET=       # Webhook signature secret
LS_TEST_MODE=false       # Store mode assertion
LS_SETTLEMENT_FINGERPRINT_SECRET_V1= # Immutable settlement HMAC key
LS_PRO_VARIANT_ID=       # Pro subscription variant
LS_TOKEN_PACK_SMALL_VARIANT_ID=  # Small pack variant
LS_TOKEN_PACK_LARGE_VARIANT_ID=  # Large pack variant
```

## Webhook Events

`convex/lemonSqueezy/webhook.ts`에서 처리:

| Event                          | Action            |
| ------------------------------ | ----------------- |
| `subscription_created`         | Pro 구독 생성     |
| `subscription_cancelled`       | 구독 취소         |
| `subscription_payment_success` | 갱신 처리         |
| `order_created`                | 토큰 팩 구매 처리 |

## Checkout Flow

```typescript
// 1. Checkout URL 생성
const checkoutUrl = await ctx.runAction(
  api.subscriptions.action.createCheckoutUrl,
  { productType: "token_pack_small" },
);

// 2. 사용자를 checkout URL로 리다이렉트

// 3. Webhook이 결제 완료 처리
// - paymentLogs에 기록
// - subscription 또는 purchasedTokens 업데이트
```

## DB Schema

### subscriptions

```typescript
{
  userId: Id<"users">,
  plan: "free" | "pro",
  status: "active" | "canceled" | "expired",
  includedTokens: number,      // 월 포함 토큰
  purchasedTokens: number,     // 구매한 토큰 잔액
  serviceFeeRate: number,      // 0.18 (pro) or 0.25 (free)
  periodStart: number,
  periodEnd: number,
}
```

### paymentLogs

결제 이벤트 기록 (admin dashboard용):

```typescript
{
  userId: Id<"users">,
  eventType: string,           // "order_created", "subscription_created", etc.
  productType: string,         // "pro", "token_pack_small", "token_pack_large"
  amountCents: number,
  tokensAdded: number,
  status: "success" | "failed" | "pending" | "refunded" | "canceled",
}
```

## Testing

결제와 구독 동작은 외부 결제 상태를 변경하지 않는 테스트 스위트로 검증합니다:

```bash
bun run test -- test/convex/lemonSqueezy test/convex/subscriptions
```
