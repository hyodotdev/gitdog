export type EmbeddingRoute = "free" | "paid";

export type EmbeddingPaidReservationReason =
  "reservation_finalized" | "provider_already_started" | "reservation_closed";

export type EmbeddingDataProvenance = "public_github" | "private_user_input";

export type EmbeddingErrorKind =
  | "reservation_busy"
  | "configuration"
  | "invalid_input"
  | "policy"
  | "repository_access"
  | "authentication"
  | "rate_limit"
  | "request"
  | "network"
  | "provider"
  | "invalid_response";

export type EmbeddingPolicy = {
  route: EmbeddingRoute;
  allowPaidFallback: boolean;
};

export type EmbeddingKeys = {
  freeApiKey?: string;
  paidApiKey?: string;
};

export type EmbeddingDocument = {
  title?: string;
  content: string;
};

export type EmbeddingClientOptions = {
  fetch?: typeof globalThis.fetch;
  beforeProviderRequest?: (route: EmbeddingRoute) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
};

export class EmbeddingProviderError extends Error {
  readonly provider: "google" | "openai";
  readonly kind: EmbeddingErrorKind;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly providerStatus?: string;
  readonly route?: EmbeddingRoute;
  /** The provider was not called, so a durable worker may retry safely. */
  readonly durableRetrySafe: boolean;
  /** Deterministic paid work that must not call the provider again. */
  readonly paidReservationReason?: EmbeddingPaidReservationReason;
  /** Exact provider usage returned before response-body validation failed. */
  readonly knownBilledTokens?: number;

  constructor(
    kind: EmbeddingErrorKind,
    message: string,
    options: {
      provider?: "google" | "openai";
      retryable?: boolean;
      httpStatus?: number;
      providerStatus?: string;
      route?: EmbeddingRoute;
      durableRetrySafe?: boolean;
      paidReservationReason?: EmbeddingPaidReservationReason;
      knownBilledTokens?: number;
    } = {},
  ) {
    super(message);
    this.name = "EmbeddingProviderError";
    this.provider = options.provider ?? "google";
    this.kind = kind;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus;
    this.providerStatus = options.providerStatus;
    this.route = options.route;
    this.durableRetrySafe = options.durableRetrySafe ?? false;
    this.paidReservationReason = options.paidReservationReason;
    this.knownBilledTokens = options.knownBilledTokens;
  }
}
