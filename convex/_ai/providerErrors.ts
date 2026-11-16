export type ProviderUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export class ChatProviderRequestError extends Error {
  constructor(
    message: string,
    readonly billingOutcome: "not_billed" | "billed" | "ambiguous",
    readonly options: {
      httpStatus?: number;
      providerRequestId?: string;
      usage?: ProviderUsage;
      creditExhausted?: boolean;
      unavailable?: boolean;
      // Set when the provider's safety classifiers declined the request; the
      // refusal category when the provider reports one, otherwise "unknown".
      refusal?: string;
    } = {},
  ) {
    super(message);
    this.name = "ChatProviderRequestError";
  }

  get httpStatus() {
    return this.options.httpStatus;
  }
  get providerRequestId() {
    return this.options.providerRequestId;
  }
  get usage() {
    return this.options.usage;
  }
  get refusal() {
    return this.options.refusal;
  }
  get canFallback() {
    return (
      this.billingOutcome === "not_billed" &&
      (this.options.creditExhausted === true ||
        this.options.unavailable === true)
    );
  }
}
