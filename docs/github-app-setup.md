# GitHub App Setup Guide

## Overview

Gitdog uses a **GitHub App** to access user repositories. This provides:

- Access to private and organization repositories
- Better permission control than OAuth Apps
- Multiple organization installations
- Webhook integration for real-time updates

## Important Notes

Gitdog uses **GitHub App** for both user authentication and repository access. This provides better security and permission control than traditional OAuth Apps.

## Creating the GitHub App

### 1. Create New GitHub App

Go to: <https://github.com/settings/apps/new>

### 2. Basic Information

- **GitHub App name**: Choose a unique name whose slug matches
  `VITE_GITHUB_APP_SLUG` (the local default slug is `gitdogbot-dev`)
- **Homepage URL**: `http://localhost:5173` (production: `https://gitdog.dev`)
- **Callback URL**:
  `${CUSTOM_AUTH_SITE_URL ?? CONVEX_SITE_URL}/api/auth/callback/github`
  - Use the concrete `CUSTOM_AUTH_SITE_URL` when it is configured; otherwise,
    use the target deployment's concrete `CONVEX_SITE_URL`, such as
    `https://example-deployment.convex.site`
  - This is the OAuth authentication callback; it is not the frontend Setup URL
- **Setup URL**: `http://localhost:5173/repositories/connect`
  - ✅ Check "Redirect on update"

### 3. Webhook Configuration

- **Webhook URL**: `https://your-deployment.convex.site/github/webhook`
- **Webhook secret**: Generate a random string and save it
- **Active**: ✅ Checked

### 4. Permissions

**Repository permissions:**

- Contents: Read-only
- Pull requests: Read & write
- Issues: Read & write
- Discussions: Read & write
- Metadata: Read-only (automatic)

**Account permissions:**

- Email addresses: Read-only

### 5. Subscribe to Events

- ✅ Installation
- ✅ Installation repositories
- ✅ Repository
- ✅ Push
- ✅ Pull requests
- ✅ Issues
- ✅ Issue comments
- ✅ Discussions
- ✅ Discussion comments

The `Repository` event keeps stored repository metadata current after
repository metadata changes. Gitdog identifies rename and transfer events by
GitHub's immutable numeric repository ID, then fail-closes cached free
eligibility until the next live generation verification. `Installation` and
`Installation repositories` events pause repositories when access is removed;
an access-added event reactivates the existing row and schedules a fresh index.
The `Push` event keeps the index current after default-branch commits.

PR reviews are opt-in per repository. Enable **Pull request reviews** and retain
**Approve before posting** to inspect proposals in Tickets. The GitHub App
requires the Pull requests permission and event above on both dev and production;
existing installations must accept the expanded permission. Reviews inspect
immutable head/merge-base source and never execute pull-request code.

### 6. Installation Settings

**Where can this GitHub App be installed?**

- ✅ **Any account** (IMPORTANT: This allows users to install on multiple organizations)

### 7. Create GitHub App

Click **Create GitHub App** button

## After Creation

1. Note your **App ID**
2. Note your **Client ID**
3. **Generate a Client secret**
4. **Generate a private key** (downloads a `.pem` file)

## Setting Up Environment Variables

### Convert Private Key to PKCS#8 Format

The downloaded private key is in PKCS#1 format. Convert it to PKCS#8:

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in your-app.private-key.pem \
  -out your-app.pkcs8.pem
```

### Set Convex Environment Variables

```bash
bunx convex env set GITHUB_APP_SLUG gitdogbot-dev
bunx convex env set GITHUB_APP_ID "your_app_id"
bunx convex env set GITHUB_APP_CLIENT_ID "your_client_id"

# Prefer the Convex Dashboard for secrets. If using the CLI, read each secret
# from a permission-restricted file so it is not stored in shell history.
bunx convex env set GITHUB_APP_CLIENT_SECRET < github-app-client-secret.txt
bunx convex env set GITHUB_WEBHOOK_SECRET < github-webhook-secret.txt
bunx convex env set GITHUB_APP_PRIVATE_KEY < your-app.pkcs8.pem
```

### Set the Frontend GitHub App Slug

Set the slug from the GitHub App URL (`github.com/apps/<slug>`) as a Vite
build-time variable. It must contain only lowercase letters, numbers, and
hyphens:

```bash
# .env.local
VITE_GITHUB_APP_SLUG=gitdogbot-dev
```

Set the matching Convex environment variable for each backend deployment:

```bash
# Production Convex deployment
bunx convex env set GITHUB_APP_SLUG gitdogbot --prod
```

The backend fails closed for mentions and bot-authorship checks when this value
is missing or invalid. Never configure both bot slugs in one deployment.

GitHub Actions preview builds must use the repository secret
`VITE_CONVEX_DEV_URL`. The preview workflow maps it to `VITE_CONVEX_URL` and
pins `VITE_GITHUB_APP_SLUG=gitdogbot-dev`, so testing a pull request cannot
authenticate against or mutate the production Convex deployment. Keep the
production `VITE_CONVEX_URL` secret reserved for the main-branch deployment.

When the frontend `VITE_GITHUB_APP_SLUG` variable is omitted, Gitdog defaults
to `gitdogbot-dev` in development and `gitdogbot` in production. The backend
variable has no fallback and must match the frontend deployment exactly.

### Verify Environment Variables

Open **Convex Dashboard → Settings → Environment Variables** and confirm that
these variable names are present. Do not paste their values into logs, issues,
or support messages. Avoid `convex env list` for this check because it prints
secret values.

- `GITHUB_APP_SLUG`
- `GITHUB_APP_ID`
- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`

## How It Works

### User Flow

1. User logs in with **GitHub App** (authentication)
2. User navigates to `/repositories/connect`
3. User clicks "Install GitHub App" (if not already installed)
4. User is redirected to GitHub installation page
5. User selects account (personal or organization)
6. User selects repositories to grant access
7. After installation, GitHub redirects to `/repositories/connect?installation_id=XXXXX`
8. GitHub's signed installation webhook binds the installation to the webhook sender's verified OAuth account
9. User can now see all accessible repositories (including private and org repos)

### Multiple Installations

Users can install the app on:

- Their personal account
- Organization A
- Organization B
- Any other organizations they have access to

Each installation is separate with its own installation ID. All installations can be managed at <https://github.com/settings/installations>

Do not connect the same repository to both `gitdogbot` and `gitdogbot-dev`.
Mentions are isolated by `GITHUB_APP_SLUG`, but GitHub sends automatic issue,
discussion, repository, and push events to every App installed on that
repository. Use a dedicated test repository for the development App.

## Production Setup

For production deployment:

1. Update GitHub App settings:
   - Homepage URL: `https://gitdog.dev`
   - Callback URL:
     `${CUSTOM_AUTH_SITE_URL ?? CONVEX_SITE_URL}/api/auth/callback/github`,
     using the concrete production custom auth site URL when configured and the
     concrete production Convex site URL otherwise
   - Setup URL: `https://gitdog.dev/repositories/connect`
   - Redirect on update: ✅ Checked
   - Webhook URL: `https://your-production.convex.site/github/webhook`

2. Update Convex environment variables for production deployment:

   ```bash
   bunx convex env set GITHUB_APP_SLUG gitdogbot --prod
   bunx convex env set GITHUB_APP_ID "your_app_id" --prod
   bunx convex env set GITHUB_APP_CLIENT_ID "your_client_id" --prod
   bunx convex env set GITHUB_APP_CLIENT_SECRET --prod < github-app-client-secret.txt
   bunx convex env set GITHUB_WEBHOOK_SECRET --prod < github-webhook-secret.txt
   bunx convex env set GITHUB_APP_PRIVATE_KEY --prod < your-app.pkcs8.pem
   ```

## Troubleshooting

### Installation not being saved

- Check webhook is active in GitHub App settings
- Verify webhook URL is correct
- Check Convex logs for webhook events: `bunx convex logs`
- Verify the user is signed in with the same GitHub account that installed the app

### Private key error

- Ensure private key is converted to PKCS#8 format
- Confirm `GITHUB_APP_PRIVATE_KEY` is present in the Convex Dashboard without
  revealing its value. If its contents are uncertain, convert the downloaded
  key again and overwrite the variable from the file.
- Key should start with `-----BEGIN PRIVATE KEY-----` (not `BEGIN RSA PRIVATE KEY`)

### Repositories not showing

- Verify installation ID is saved: check Debug Info on `/repositories/connect`
- Check user has installed the app: <https://github.com/settings/installations>
- Verify app has permission to access repositories

## Architecture

```text
User Login Flow:
GitHub App → convex/auth.ts → User session created

Repository Access Flow:
GitHub OAuth login → Short-lived `/user/installations` attestation → Recover personal installations
Organization installation/update → Signed webhook → Save installation
Setup callback → Coordinate verification and repository reconnect UI
User requests repos → convex/github/action.ts → Generate JWT → Get installation token → Fetch repos
```
