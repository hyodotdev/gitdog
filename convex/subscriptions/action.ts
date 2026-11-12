import { getAuthUserId } from "@convex-dev/auth/server";
import {
  createCheckout,
  lemonSqueezySetup,
} from "@lemonsqueezy/lemonsqueezy.js";
import { v } from "convex/values";
import { action } from "../_generated/server";

function initLemonSqueezy() {
  const apiKey = process.env.LS_API_KEY;
  if (!apiKey) {
    throw new Error("LS_API_KEY environment variable is not set");
  }
  lemonSqueezySetup({ apiKey });
}

export const createCheckoutUrl = action({
  args: {
    plan: v.literal("pro"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    initLemonSqueezy();

    const storeId = process.env.LS_STORE_ID;
    const variantId = process.env.LS_PRO_VARIANT_ID;

    if (!storeId) {
      throw new Error("LS_STORE_ID not configured");
    }
    if (!variantId) {
      throw new Error(`Variant ID not configured for ${args.plan} plan`);
    }

    const checkout = await createCheckout(storeId, variantId, {
      checkoutData: {
        custom: {
          user_id: userId,
        },
      },
      productOptions: {
        redirectUrl: `${process.env.SITE_URL}/usage?checkout=success`,
      },
    });

    if (checkout.error) {
      console.error("Lemon Squeezy checkout request failed");
      throw new Error("Checkout failed");
    }

    const checkoutUrl = checkout.data?.data?.attributes?.url;
    if (!checkoutUrl) {
      console.error("Lemon Squeezy checkout response did not include a URL");
      throw new Error("Failed to create checkout URL");
    }

    return { checkoutUrl };
  },
});

export const createTokenPackCheckoutUrl = action({
  args: {
    packSize: v.union(v.literal("small"), v.literal("large")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    initLemonSqueezy();

    const storeId = process.env.LS_STORE_ID;
    const variantId =
      args.packSize === "small"
        ? process.env.LS_TOKEN_PACK_SMALL_VARIANT_ID
        : process.env.LS_TOKEN_PACK_LARGE_VARIANT_ID;

    if (!storeId) {
      throw new Error("LS_STORE_ID not configured");
    }
    if (!variantId) {
      throw new Error(`Token pack ${args.packSize} variant ID not configured`);
    }

    const checkout = await createCheckout(storeId, variantId, {
      checkoutData: {
        custom: {
          user_id: userId,
        },
      },
      productOptions: {
        redirectUrl: `${process.env.SITE_URL}/usage?checkout=success`,
      },
    });

    if (checkout.error) {
      console.error("Lemon Squeezy checkout request failed");
      throw new Error("Checkout failed");
    }

    const checkoutUrl = checkout.data?.data?.attributes?.url;
    if (!checkoutUrl) {
      console.error("Lemon Squeezy checkout response did not include a URL");
      throw new Error("Failed to create checkout URL");
    }

    return { checkoutUrl };
  },
});
