import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import { projectApi } from "./apiKeys/http";
import {
  verifyWebhookSignature,
  handleInstallationEvent,
  handleInstallationRepositoriesEvent,
  handleRepositoryEvent,
  handleIssuesEvent,
  handleIssueCommentEvent,
  handleDiscussionEvent,
  handleDiscussionCommentEvent,
  handlePushEvent,
} from "./github/webhook";
import { handleLemonSqueezyWebhook } from "./lemonSqueezy/webhook";
import { getWorkloadJwks, WORKLOAD_JWKS_PATH } from "./_ai/federation";

import { handlePullRequestEvent } from "./pullRequests/webhook";

const http = httpRouter();

auth.addHttpRoutes(http);
http.route({ path: "/v1/cli", method: "POST", handler: projectApi });

http.route({
  path: WORKLOAD_JWKS_PATH,
  method: "GET",
  handler: httpAction(async () => {
    try {
      const keys = await getWorkloadJwks(process.env.JWKS ?? "");
      return Response.json(keys, {
        headers: { "Cache-Control": "public, max-age=60" },
      });
    } catch {
      return Response.json(
        { error: "Workload public keys unavailable" },
        { status: 503 },
      );
    }
  }),
});

// GitHub webhook endpoint
http.route({
  path: "/github/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // Verify GitHub webhook signature
    const signature = request.headers.get("x-hub-signature-256");
    const event = request.headers.get("x-github-event");
    const deliveryId = request.headers.get("x-github-delivery");

    console.log("GitHub webhook received:", {
      event,
      deliveryId,
      hasSignature: !!signature,
    });

    // Get the raw body for signature verification
    const body = await request.text();

    // Verify webhook signature
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      console.error("GITHUB_WEBHOOK_SECRET not configured");
      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (!signature) {
      console.error("Missing webhook signature");
      return new Response(JSON.stringify({ error: "Missing signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Verify HMAC signature
    const isValid = await verifyWebhookSignature(signature, body, secret);
    if (!isValid) {
      console.error("Invalid webhook signature");
      return new Response(JSON.stringify({ error: "Invalid signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Parse payload
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      console.error("Failed to parse webhook payload");
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Handle different event types
    switch (event) {
      case "installation":
        await handleInstallationEvent(ctx, payload);
        break;

      case "installation_repositories":
        await handleInstallationRepositoriesEvent(ctx, payload, deliveryId);
        break;

      case "repository":
        await handleRepositoryEvent(ctx, payload);
        break;

      case "issues":
        await handleIssuesEvent(ctx, payload);
        break;

      case "issue_comment":
        await handleIssueCommentEvent(ctx, payload);
        break;

      case "discussion":
        await handleDiscussionEvent(ctx, payload);
        break;

      case "discussion_comment":
        await handleDiscussionCommentEvent(ctx, payload);
        break;

      case "pull_request":
        await handlePullRequestEvent(ctx, payload);
        break;

      case "push":
        await handlePushEvent(ctx, payload);
        break;

      default:
        console.log("Unhandled event:", event);
    }

    // Return 200 OK to acknowledge receipt
    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }),
});

// Lemon Squeezy webhook endpoint
http.route({
  path: "/lemon-squeezy/webhook",
  method: "POST",
  handler: handleLemonSqueezyWebhook,
});

// Health check endpoint
http.route({
  path: "/github/health",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }),
});

export default http;
