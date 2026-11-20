import { defineApp } from "convex/server";
import { v } from "convex/values";
import auth from "@convex-dev/auth/convex.config";
import authGithub from "@convex-dev/auth/components/github/convex.config";

const app = defineApp({
  env: {
    GITHUB_APP_CLIENT_ID: v.string(),
    GITHUB_APP_CLIENT_SECRET: v.string(),
  },
});

// Sessions and tokens live in the core; GitHub accounts in authGithub, whose
// OAuth callback is served at <site>/oauth/github/callback.
app.use(auth);
app.use(authGithub, {
  httpPrefix: "/oauth/github",
  env: {
    CLIENT_ID: app.env.GITHUB_APP_CLIENT_ID,
    CLIENT_SECRET: app.env.GITHUB_APP_CLIENT_SECRET,
  },
});

export default app;
