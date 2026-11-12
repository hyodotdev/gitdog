import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { isUsableHttpsDeploymentUrl } from "../../.github/scripts/validateDeployUrl";

const workflowSource = readFileSync(
  new URL("../../.github/workflows/deploy-convex.yml", import.meta.url),
  "utf8",
);
const combinedDeploySource = readFileSync(
  new URL("../../.github/workflows/deploy.yml", import.meta.url),
  "utf8",
);
const previewDeploySource = readFileSync(
  new URL("../../.github/workflows/deploy-preview.yml", import.meta.url),
  "utf8",
);

describe("Convex production deploy preflight", () => {
  it("can only be invoked by the ordered combined deployment", () => {
    expect(workflowSource).toContain("workflow_call:");
    expect(workflowSource).not.toContain("workflow_dispatch:");
    expect(combinedDeploySource).toContain(
      "uses: ./.github/workflows/deploy-convex.yml",
    );
  });

  it("guards every production job to main and globally serializes deployments", () => {
    const mainGuard = "if: ${{ github.ref == 'refs/heads/main' }}";
    const buildJob = combinedDeploySource.match(
      / {2}build_frontend:\n([\s\S]*?)(?=\n {2}deploy_convex:)/,
    )?.[1];
    const convexJob = combinedDeploySource.match(
      / {2}deploy_convex:\n([\s\S]*?)(?=\n {2}deploy_frontend:)/,
    )?.[1];
    const publishJob = combinedDeploySource.match(
      / {2}deploy_frontend:\n([\s\S]*?)(?=\n {2}verify_convex:)/,
    )?.[1];
    const verificationJob = combinedDeploySource.match(
      / {2}verify_convex:\n([\s\S]*)$/,
    )?.[1];

    expect(combinedDeploySource).toContain("workflow_dispatch:");
    expect(buildJob).toContain(mainGuard);
    expect(convexJob).toContain(mainGuard);
    expect(publishJob).toContain(mainGuard);
    expect(verificationJob).toContain(mainGuard);
    expect(combinedDeploySource).toContain("group: deploy-production");
    expect(combinedDeploySource).not.toContain(
      "group: deploy-main-${{ github.ref }}",
    );
    expect(workflowSource).not.toContain("group: deploy-convex-");
  });

  it("validates the frontend URL before production and preview builds", () => {
    for (const source of [combinedDeploySource, previewDeploySource]) {
      const validation = source.indexOf(
        'DEPLOY_URL_TO_VALIDATE="$VITE_CONVEX_URL" bun run .github/scripts/validateDeployUrl.ts',
      );
      const build = source.indexOf("bun run build");
      const publish = source.indexOf("FirebaseExtended/action-hosting-deploy@");

      expect(validation).toBeGreaterThan(-1);
      expect(validation).toBeLessThan(build);
      expect(validation).toBeLessThan(publish);
      expect(source).not.toContain('echo "$VITE_CONVEX_URL"');
    }
  });

  it("isolates preview builds on the development Convex deployment and GitHub App", () => {
    expect(previewDeploySource).toContain(
      "VITE_CONVEX_URL: ${{ secrets.VITE_CONVEX_DEV_URL }}",
    );
    expect(previewDeploySource).toContain(
      "VITE_GITHUB_APP_SLUG: gitdogbot-dev",
    );
    expect(previewDeploySource).not.toContain(
      "VITE_CONVEX_URL: ${{ secrets.VITE_CONVEX_URL }}",
    );
    expect(previewDeploySource).toContain("bun install --frozen-lockfile");
  });

  it("requires every production runtime secret without printing values", () => {
    const requiredBlock = workflowSource.match(
      /required_production_env=\(\n([\s\S]*?)\n\s*\)/,
    )?.[1];
    expect(requiredBlock).toBeDefined();
    for (const name of [
      "GITHUB_APP_SLUG",
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_WEBHOOK_SECRET",
      "GITHUB_APP_CLIENT_ID",
      "GITHUB_APP_CLIENT_SECRET",
      "SITE_URL",
      "LS_API_KEY",
      "LS_STORE_ID",
      "LS_WEBHOOK_SECRET",
      "LS_TEST_MODE",
      "LS_SETTLEMENT_FINGERPRINT_SECRET_V1",
      "LS_PRO_VARIANT_ID",
      "LS_TOKEN_PACK_SMALL_VARIANT_ID",
      "LS_TOKEN_PACK_LARGE_VARIANT_ID",
    ]) {
      expect(requiredBlock).toContain(name);
    }
    expect(workflowSource).toContain(
      'bunx convex env get "$name" --prod 2>/dev/null',
    );
    expect(workflowSource).not.toContain('echo "$value"');
  });

  it("pins production to the production GitHub App identity", () => {
    expect(workflowSource).toContain(
      'if [ "${production_env[GITHUB_APP_SLUG]}" != "gitdogbot" ]; then',
    );
    expect(workflowSource).toContain(
      "GITHUB_APP_SLUG must be exactly gitdogbot in production.",
    );
  });

  it("has no Gemini credential dependency or rollback route", () => {
    expect(workflowSource).not.toContain("GEMINI_");
    expect(workflowSource).toContain(
      "AI_GENERATION_ROUTE must be claude-openai.",
    );
    expect(workflowSource).toContain("generation_keys=(OPENAI_API_KEY)");
  });

  it("validates production SITE_URL without printing it", () => {
    expect(workflowSource).toContain(
      'DEPLOY_URL_TO_VALIDATE="${production_env[SITE_URL]}" bun run .github/scripts/validateDeployUrl.ts',
    );
    expect(workflowSource).not.toContain('echo "${production_env[SITE_URL]}"');
  });

  it("rejects Lemon Squeezy test mode in production", () => {
    expect(workflowSource).toContain(
      'if [ "${production_env[LS_TEST_MODE]}" != "false" ]; then',
    );
    expect(workflowSource).toContain(
      "LS_TEST_MODE must be exactly false in production.",
    );
    expect(workflowSource).not.toContain(
      '[ "${production_env[LS_TEST_MODE]}" != "true" ]',
    );
  });

  it("verifies the deployed settlement fingerprint without blocking the matching frontend", () => {
    expect(workflowSource).not.toContain(
      "paymentLogs/privacy:verifySettlementConfiguration",
    );
    expect(combinedDeploySource).toContain(
      "paymentLogs/privacy:verifySettlementConfiguration",
    );
    expect(combinedDeploySource).toContain(
      "Settlement fingerprint key differs from production's pinned configuration or could not be verified.",
    );
    const publishJob = combinedDeploySource.match(
      / {2}deploy_frontend:\n([\s\S]*?)(?=\n {2}verify_convex:)/,
    )?.[1];
    const verificationJob = combinedDeploySource.match(
      / {2}verify_convex:\n([\s\S]*)$/,
    )?.[1];
    expect(publishJob).toContain("- deploy_convex");
    expect(publishJob).not.toContain("verify_convex");
    expect(verificationJob).toContain("needs: deploy_convex");
    expect(verificationJob).toContain(
      "paymentLogs/privacy:verifySettlementConfiguration",
    );
    expect(workflowSource).not.toContain(
      'echo "${production_env[LS_SETTLEMENT_FINGERPRINT_SECRET_V1]}"',
    );
  });

  it("prebuilds the frontend before Convex and publishes only afterward", () => {
    const buildJob = combinedDeploySource.match(
      / {2}build_frontend:\n([\s\S]*?)(?=\n {2}deploy_convex:)/,
    )?.[1];
    const convexJob = combinedDeploySource.match(
      / {2}deploy_convex:\n([\s\S]*?)(?=\n {2}deploy_frontend:)/,
    )?.[1];
    const publishJob = combinedDeploySource.match(
      / {2}deploy_frontend:\n([\s\S]*?)(?=\n {2}verify_convex:)/,
    )?.[1];
    const artifactUpload = combinedDeploySource.indexOf(
      "actions/upload-artifact@",
    );
    const convexDeploy = combinedDeploySource.indexOf(
      "uses: ./.github/workflows/deploy-convex.yml",
    );
    const artifactDownload = combinedDeploySource.indexOf(
      "actions/download-artifact@",
    );
    const firebasePublish = combinedDeploySource.indexOf(
      "FirebaseExtended/action-hosting-deploy@",
    );
    expect(buildJob).toBeDefined();
    expect(convexJob).toBeDefined();
    expect(publishJob).toBeDefined();
    expect(buildJob).toContain("bun run build");
    expect(buildJob).toContain("actions/upload-artifact@");
    expect(convexJob).toContain("needs: build_frontend");
    expect(convexJob).not.toContain("FirebaseExtended/action-hosting-deploy");
    expect(publishJob).toContain("actions/download-artifact@");
    expect(publishJob).not.toContain("bun run build");
    expect(publishJob).toContain("- build_frontend");
    expect(publishJob).toContain("- deploy_convex");
    expect(artifactUpload).toBeGreaterThan(-1);
    expect(convexDeploy).toBeGreaterThan(artifactUpload);
    expect(artifactDownload).toBeGreaterThan(convexDeploy);
    expect(firebasePublish).toBeGreaterThan(-1);
    expect(firebasePublish).toBeGreaterThan(artifactDownload);
    expect(convexJob).toContain("uses: ./.github/workflows/deploy-convex.yml");
  });
});

describe("deployment URL validation", () => {
  it.each([
    "https://example.convex.cloud",
    "https://gitdog.dev",
    "https://service.example.com:8443",
  ])("accepts the exact public HTTPS origin %s", (value) => {
    expect(isUsableHttpsDeploymentUrl(value)).toBe(true);
  });

  it.each([
    "https://9.255.255.255",
    "https://11.0.0.0",
    "https://100.63.255.255",
    "https://100.128.0.0",
    "https://169.253.255.255",
    "https://169.255.0.0",
    "https://172.15.255.255",
    "https://172.32.0.0",
    "https://192.0.0.9",
    "https://192.0.0.10",
    "https://192.167.255.255",
    "https://192.169.0.0",
    "https://198.17.255.255",
    "https://198.20.0.0",
    "https://223.255.255.255",
    "https://[2001:1::1]",
    "https://[2001:3::1]",
    "https://[2001:db7::1]",
    "https://[2001:db9::1]",
    "https://[2001:4860:4860::8888]",
    "https://[2c00::1]",
    "https://[2606:4700:4700::1111]",
    "https://[::808:808]",
    "https://[::ffff:808:808]",
    "https://[64:ff9b::808:808]",
  ])("accepts the public HTTPS URL %s", (value) => {
    expect(isUsableHttpsDeploymentUrl(value)).toBe(true);
  });

  it.each([
    "https://gitdog.dev/",
    "https://gitdog.dev/base",
    "https://gitdog.dev?source=deploy",
    "https://gitdog.dev#deployment",
    "https://user:secret@gitdog.dev",
  ])("rejects a value that is not the exact HTTPS origin %s", (value) => {
    expect(isUsableHttpsDeploymentUrl(value)).toBe(false);
  });

  it.each([
    undefined,
    "",
    "not a URL",
    "http://gitdog.dev",
    " https://gitdog.dev",
    "https://gitdog.dev ",
    "https://localhost",
    "https://localhost.",
    "https://preview.localhost",
    "https://127.0.0.1",
    "https://127.0.0.2",
    "https://127.255.255.254",
    "https://127.1",
    "https://0177.0.0.1",
    "https://2130706433",
    "https://0.0.0.0",
    "https://0.1.2.3",
    "https://0",
    "https://10.0.0.0",
    "https://10.255.255.255",
    "https://100.64.0.0",
    "https://100.127.255.255",
    "https://169.254.0.0",
    "https://169.254.255.255",
    "https://172.16.0.0",
    "https://172.31.255.255",
    "https://192.0.0.8",
    "https://192.0.0.11",
    "https://192.0.2.1",
    "https://192.88.99.1",
    "https://192.168.0.0",
    "https://192.168.255.255",
    "https://198.18.0.0",
    "https://198.19.255.255",
    "https://198.51.100.1",
    "https://203.0.113.1",
    "https://224.0.0.0",
    "https://239.255.255.255",
    "https://240.0.0.0",
    "https://255.255.255.255",
    "https://[::]",
    "https://[::1]",
    "https://[0:0:0:0:0:0:0:1]",
    "https://[64:ff9b:1::1]",
    "https://[100::1]",
    "https://[100:0:0:1::1]",
    "https://[2001:2::1]",
    "https://[2001:db8::1]",
    "https://[2002::1]",
    "https://[2d00::1]",
    "https://[3fff::1]",
    "https://[5f00::1]",
    "https://[fc00::1]",
    "https://[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]",
    "https://[fe80::1]",
    "https://[febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff]",
    "https://[fec0::1]",
    "https://[ff00::1]",
    "https://[::7f00:1]",
    "https://[::a00:1]",
    "https://[::6440:1]",
    "https://[::ffff:7f00:1]",
    "https://[::ffff:7fff:fffe]",
    "https://[::ffff:0:0]",
    "https://[::ffff:a9fe:101]",
    "https://[::ffff:ac10:1]",
    "https://[::ffff:c0a8:1]",
    "https://[64:ff9b::c0a8:1]",
    "https://[0:0:0:0:0:ffff:7f00:1]",
  ])("rejects the missing, malformed, or unusable URL %s", (value) => {
    expect(isUsableHttpsDeploymentUrl(value)).toBe(false);
  });
});
