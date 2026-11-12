/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as _ai_chatBilling from "../_ai/chatBilling.js";
import type * as _ai_chatRecovery from "../_ai/chatRecovery.js";
import type * as _ai_config from "../_ai/config.js";
import type * as _ai_embeddingBilling from "../_ai/embeddingBilling.js";
import type * as _ai_embeddings from "../_ai/embeddings.js";
import type * as _ai_errorAnalysis_prompts from "../_ai/errorAnalysis/prompts.js";
import type * as _ai_federation from "../_ai/federation.js";
import type * as _ai_followUp_prompts from "../_ai/followUp/prompts.js";
import type * as _ai_issueAnalysis_agenticWorkflow from "../_ai/issueAnalysis/agenticWorkflow.js";
import type * as _ai_issueAnalysis_index from "../_ai/issueAnalysis/index.js";
import type * as _ai_issueAnalysis_prompts from "../_ai/issueAnalysis/prompts.js";
import type * as _ai_issueAnalysis_types from "../_ai/issueAnalysis/types.js";
import type * as _ai_issueAnalysis_workflow from "../_ai/issueAnalysis/workflow.js";
import type * as _ai_issueFormatting_index from "../_ai/issueFormatting/index.js";
import type * as _ai_issueFormatting_prompts from "../_ai/issueFormatting/prompts.js";
import type * as _ai_issueFormatting_types from "../_ai/issueFormatting/types.js";
import type * as _ai_issueFormatting_workflow from "../_ai/issueFormatting/workflow.js";
import type * as _ai_learning_extractLearning from "../_ai/learning/extractLearning.js";
import type * as _ai_learning_fetchLinkContent from "../_ai/learning/fetchLinkContent.js";
import type * as _ai_learning_prompts from "../_ai/learning/prompts.js";
import type * as _ai_legalAttestation from "../_ai/legalAttestation.js";
import type * as _ai_model from "../_ai/model.js";
import type * as _ai_providerErrors from "../_ai/providerErrors.js";
import type * as _ai_providerResolution from "../_ai/providerResolution.js";
import type * as _ai_providers from "../_ai/providers.js";
import type * as _ai_requestSize from "../_ai/requestSize.js";
import type * as _ai_responseValidation from "../_ai/responseValidation.js";
import type * as _ai_retrievalEmbeddings from "../_ai/retrievalEmbeddings.js";
import type * as _ai_tools_definitions from "../_ai/tools/definitions.js";
import type * as _ai_tools_executors from "../_ai/tools/executors.js";
import type * as _ai_utils from "../_ai/utils.js";
import type * as _ai_workflow from "../_ai/workflow.js";
import type * as _utils_accessControl from "../_utils/accessControl.js";
import type * as _utils_authRedirect from "../_utils/authRedirect.js";
import type * as _utils_environment from "../_utils/environment.js";
import type * as _utils_gitdogFormat from "../_utils/gitdogFormat.js";
import type * as _utils_pagination from "../_utils/pagination.js";
import type * as admin_internalMutation from "../admin/internalMutation.js";
import type * as admin_mutation from "../admin/mutation.js";
import type * as admin_paymentMutation from "../admin/paymentMutation.js";
import type * as admin_paymentQuery from "../admin/paymentQuery.js";
import type * as admin_query from "../admin/query.js";
import type * as admin_utils from "../admin/utils.js";
import type * as aiAuth_internalAction from "../aiAuth/internalAction.js";
import type * as apiKeys_action from "../apiKeys/action.js";
import type * as apiKeys_gateway from "../apiKeys/gateway.js";
import type * as apiKeys_http from "../apiKeys/http.js";
import type * as apiKeys_internalMutation from "../apiKeys/internalMutation.js";
import type * as apiKeys_mutation from "../apiKeys/mutation.js";
import type * as apiKeys_query from "../apiKeys/query.js";
import type * as apiKeys_security from "../apiKeys/security.js";
import type * as auth from "../auth.js";
import type * as crons from "../crons.js";
import type * as github_action from "../github/action.js";
import type * as github_botIdentity from "../github/botIdentity.js";
import type * as github_helpers from "../github/helpers.js";
import type * as github_installationAccess from "../github/installationAccess.js";
import type * as github_internalMutation from "../github/internalMutation.js";
import type * as github_internalQuery from "../github/internalQuery.js";
import type * as github_oauthInstallationAttestation from "../github/oauthInstallationAttestation.js";
import type * as github_query from "../github/query.js";
import type * as github_repositoryAccessReconciliation from "../github/repositoryAccessReconciliation.js";
import type * as github_repositoryIdentity from "../github/repositoryIdentity.js";
import type * as github_webhook from "../github/webhook.js";
import type * as github_webhookAccessStateAttestation from "../github/webhookAccessStateAttestation.js";
import type * as http from "../http.js";
import type * as invitations_action from "../invitations/action.js";
import type * as invitations_availability from "../invitations/availability.js";
import type * as invitations_internalMutation from "../invitations/internalMutation.js";
import type * as invitations_internalQuery from "../invitations/internalQuery.js";
import type * as invitations_mutation from "../invitations/mutation.js";
import type * as invitations_query from "../invitations/query.js";
import type * as lemonSqueezy_webhook from "../lemonSqueezy/webhook.js";
import type * as notifications_mutation from "../notifications/mutation.js";
import type * as notifications_query from "../notifications/query.js";
import type * as paymentLogs_internalMutation from "../paymentLogs/internalMutation.js";
import type * as paymentLogs_privacy from "../paymentLogs/privacy.js";
import type * as paymentLogs_settlementConfiguration from "../paymentLogs/settlementConfiguration.js";
import type * as providerApiKeys_action from "../providerApiKeys/action.js";
import type * as providerApiKeys_crypto from "../providerApiKeys/crypto.js";
import type * as providerApiKeys_internalMutation from "../providerApiKeys/internalMutation.js";
import type * as providerApiKeys_internalQuery from "../providerApiKeys/internalQuery.js";
import type * as providerApiKeys_mutation from "../providerApiKeys/mutation.js";
import type * as providerApiKeys_query from "../providerApiKeys/query.js";
import type * as providerApiKeys_usability from "../providerApiKeys/usability.js";
import type * as providerApiKeys_validation from "../providerApiKeys/validation.js";
import type * as pullRequests_action from "../pullRequests/action.js";
import type * as pullRequests_context from "../pullRequests/context.js";
import type * as pullRequests_errors from "../pullRequests/errors.js";
import type * as pullRequests_github from "../pullRequests/github.js";
import type * as pullRequests_internalAction from "../pullRequests/internalAction.js";
import type * as pullRequests_internalMutation from "../pullRequests/internalMutation.js";
import type * as pullRequests_internalQuery from "../pullRequests/internalQuery.js";
import type * as pullRequests_review from "../pullRequests/review.js";
import type * as pullRequests_webhook from "../pullRequests/webhook.js";
import type * as pullRequests_workflow from "../pullRequests/workflow.js";
import type * as ragV2_action from "../ragV2/action.js";
import type * as ragV2_chunkBudget from "../ragV2/chunkBudget.js";
import type * as ragV2_internalMutation from "../ragV2/internalMutation.js";
import type * as ragV2_internalQuery from "../ragV2/internalQuery.js";
import type * as ragV2_parser from "../ragV2/parser.js";
import type * as repoIndexing_action from "../repoIndexing/action.js";
import type * as repoIndexing_internalAction from "../repoIndexing/internalAction.js";
import type * as repoIndexing_internalQuery from "../repoIndexing/internalQuery.js";
import type * as repoIndexing_mutation from "../repoIndexing/mutation.js";
import type * as repoIndexing_query from "../repoIndexing/query.js";
import type * as repoIndexing_readiness from "../repoIndexing/readiness.js";
import type * as repoIndexing_treeSnapshot from "../repoIndexing/treeSnapshot.js";
import type * as repoIndexing_watchdog from "../repoIndexing/watchdog.js";
import type * as repoLearnings_action from "../repoLearnings/action.js";
import type * as repoLearnings_internalQuery from "../repoLearnings/internalQuery.js";
import type * as repoLearnings_mutation from "../repoLearnings/mutation.js";
import type * as repoLearnings_query from "../repoLearnings/query.js";
import type * as repoLearnings_trust from "../repoLearnings/trust.js";
import type * as repositories_accessLifecycle from "../repositories/accessLifecycle.js";
import type * as repositories_action from "../repositories/action.js";
import type * as repositories_aiReadiness from "../repositories/aiReadiness.js";
import type * as repositories_embeddingPolicy from "../repositories/embeddingPolicy.js";
import type * as repositories_embeddingPolicyRuntime from "../repositories/embeddingPolicyRuntime.js";
import type * as repositories_immutableIdentity from "../repositories/immutableIdentity.js";
import type * as repositories_internalMutation from "../repositories/internalMutation.js";
import type * as repositories_internalQuery from "../repositories/internalQuery.js";
import type * as repositories_mutation from "../repositories/mutation.js";
import type * as repositories_nameIdentity from "../repositories/nameIdentity.js";
import type * as repositories_osiLicense from "../repositories/osiLicense.js";
import type * as repositories_query from "../repositories/query.js";
import type * as repositoryMembers_mutation from "../repositoryMembers/mutation.js";
import type * as repositoryMembers_query from "../repositoryMembers/query.js";
import type * as subscriptions_action from "../subscriptions/action.js";
import type * as subscriptions_billingBoundaries from "../subscriptions/billingBoundaries.js";
import type * as subscriptions_entitlement from "../subscriptions/entitlement.js";
import type * as subscriptions_internalMutation from "../subscriptions/internalMutation.js";
import type * as subscriptions_internalQuery from "../subscriptions/internalQuery.js";
import type * as subscriptions_query from "../subscriptions/query.js";
import type * as subscriptions_quotaEntitlement from "../subscriptions/quotaEntitlement.js";
import type * as subscriptions_wallet from "../subscriptions/wallet.js";
import type * as ticketActions_action from "../ticketActions/action.js";
import type * as ticketActions_executionRecovery from "../ticketActions/executionRecovery.js";
import type * as ticketActions_internalAction from "../ticketActions/internalAction.js";
import type * as ticketActions_internalMutation from "../ticketActions/internalMutation.js";
import type * as ticketActions_internalQuery from "../ticketActions/internalQuery.js";
import type * as ticketActions_query from "../ticketActions/query.js";
import type * as tickets_internalAction from "../tickets/internalAction.js";
import type * as tickets_internalMutation from "../tickets/internalMutation.js";
import type * as tickets_internalQuery from "../tickets/internalQuery.js";
import type * as tickets_mutation from "../tickets/mutation.js";
import type * as tickets_query from "../tickets/query.js";
import type * as tokenUsage_internalMutation from "../tokenUsage/internalMutation.js";
import type * as tokenUsage_internalQuery from "../tokenUsage/internalQuery.js";
import type * as tokenUsage_query from "../tokenUsage/query.js";
import type * as tokenUsage_quota from "../tokenUsage/quota.js";
import type * as tokenUsage_totals from "../tokenUsage/totals.js";
import type * as users_action from "../users/action.js";
import type * as users_internalQuery from "../users/internalQuery.js";
import type * as users_legal from "../users/legal.js";
import type * as users_mutation from "../users/mutation.js";
import type * as users_query from "../users/query.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "_ai/chatBilling": typeof _ai_chatBilling;
  "_ai/chatRecovery": typeof _ai_chatRecovery;
  "_ai/config": typeof _ai_config;
  "_ai/embeddingBilling": typeof _ai_embeddingBilling;
  "_ai/embeddings": typeof _ai_embeddings;
  "_ai/errorAnalysis/prompts": typeof _ai_errorAnalysis_prompts;
  "_ai/federation": typeof _ai_federation;
  "_ai/followUp/prompts": typeof _ai_followUp_prompts;
  "_ai/issueAnalysis/agenticWorkflow": typeof _ai_issueAnalysis_agenticWorkflow;
  "_ai/issueAnalysis/index": typeof _ai_issueAnalysis_index;
  "_ai/issueAnalysis/prompts": typeof _ai_issueAnalysis_prompts;
  "_ai/issueAnalysis/types": typeof _ai_issueAnalysis_types;
  "_ai/issueAnalysis/workflow": typeof _ai_issueAnalysis_workflow;
  "_ai/issueFormatting/index": typeof _ai_issueFormatting_index;
  "_ai/issueFormatting/prompts": typeof _ai_issueFormatting_prompts;
  "_ai/issueFormatting/types": typeof _ai_issueFormatting_types;
  "_ai/issueFormatting/workflow": typeof _ai_issueFormatting_workflow;
  "_ai/learning/extractLearning": typeof _ai_learning_extractLearning;
  "_ai/learning/fetchLinkContent": typeof _ai_learning_fetchLinkContent;
  "_ai/learning/prompts": typeof _ai_learning_prompts;
  "_ai/legalAttestation": typeof _ai_legalAttestation;
  "_ai/model": typeof _ai_model;
  "_ai/providerErrors": typeof _ai_providerErrors;
  "_ai/providerResolution": typeof _ai_providerResolution;
  "_ai/providers": typeof _ai_providers;
  "_ai/requestSize": typeof _ai_requestSize;
  "_ai/responseValidation": typeof _ai_responseValidation;
  "_ai/retrievalEmbeddings": typeof _ai_retrievalEmbeddings;
  "_ai/tools/definitions": typeof _ai_tools_definitions;
  "_ai/tools/executors": typeof _ai_tools_executors;
  "_ai/utils": typeof _ai_utils;
  "_ai/workflow": typeof _ai_workflow;
  "_utils/accessControl": typeof _utils_accessControl;
  "_utils/authRedirect": typeof _utils_authRedirect;
  "_utils/environment": typeof _utils_environment;
  "_utils/gitdogFormat": typeof _utils_gitdogFormat;
  "_utils/pagination": typeof _utils_pagination;
  "admin/internalMutation": typeof admin_internalMutation;
  "admin/mutation": typeof admin_mutation;
  "admin/paymentMutation": typeof admin_paymentMutation;
  "admin/paymentQuery": typeof admin_paymentQuery;
  "admin/query": typeof admin_query;
  "admin/utils": typeof admin_utils;
  "aiAuth/internalAction": typeof aiAuth_internalAction;
  "apiKeys/action": typeof apiKeys_action;
  "apiKeys/gateway": typeof apiKeys_gateway;
  "apiKeys/http": typeof apiKeys_http;
  "apiKeys/internalMutation": typeof apiKeys_internalMutation;
  "apiKeys/mutation": typeof apiKeys_mutation;
  "apiKeys/query": typeof apiKeys_query;
  "apiKeys/security": typeof apiKeys_security;
  auth: typeof auth;
  crons: typeof crons;
  "github/action": typeof github_action;
  "github/botIdentity": typeof github_botIdentity;
  "github/helpers": typeof github_helpers;
  "github/installationAccess": typeof github_installationAccess;
  "github/internalMutation": typeof github_internalMutation;
  "github/internalQuery": typeof github_internalQuery;
  "github/oauthInstallationAttestation": typeof github_oauthInstallationAttestation;
  "github/query": typeof github_query;
  "github/repositoryAccessReconciliation": typeof github_repositoryAccessReconciliation;
  "github/repositoryIdentity": typeof github_repositoryIdentity;
  "github/webhook": typeof github_webhook;
  "github/webhookAccessStateAttestation": typeof github_webhookAccessStateAttestation;
  http: typeof http;
  "invitations/action": typeof invitations_action;
  "invitations/availability": typeof invitations_availability;
  "invitations/internalMutation": typeof invitations_internalMutation;
  "invitations/internalQuery": typeof invitations_internalQuery;
  "invitations/mutation": typeof invitations_mutation;
  "invitations/query": typeof invitations_query;
  "lemonSqueezy/webhook": typeof lemonSqueezy_webhook;
  "notifications/mutation": typeof notifications_mutation;
  "notifications/query": typeof notifications_query;
  "paymentLogs/internalMutation": typeof paymentLogs_internalMutation;
  "paymentLogs/privacy": typeof paymentLogs_privacy;
  "paymentLogs/settlementConfiguration": typeof paymentLogs_settlementConfiguration;
  "providerApiKeys/action": typeof providerApiKeys_action;
  "providerApiKeys/crypto": typeof providerApiKeys_crypto;
  "providerApiKeys/internalMutation": typeof providerApiKeys_internalMutation;
  "providerApiKeys/internalQuery": typeof providerApiKeys_internalQuery;
  "providerApiKeys/mutation": typeof providerApiKeys_mutation;
  "providerApiKeys/query": typeof providerApiKeys_query;
  "providerApiKeys/usability": typeof providerApiKeys_usability;
  "providerApiKeys/validation": typeof providerApiKeys_validation;
  "pullRequests/action": typeof pullRequests_action;
  "pullRequests/context": typeof pullRequests_context;
  "pullRequests/errors": typeof pullRequests_errors;
  "pullRequests/github": typeof pullRequests_github;
  "pullRequests/internalAction": typeof pullRequests_internalAction;
  "pullRequests/internalMutation": typeof pullRequests_internalMutation;
  "pullRequests/internalQuery": typeof pullRequests_internalQuery;
  "pullRequests/review": typeof pullRequests_review;
  "pullRequests/webhook": typeof pullRequests_webhook;
  "pullRequests/workflow": typeof pullRequests_workflow;
  "ragV2/action": typeof ragV2_action;
  "ragV2/chunkBudget": typeof ragV2_chunkBudget;
  "ragV2/internalMutation": typeof ragV2_internalMutation;
  "ragV2/internalQuery": typeof ragV2_internalQuery;
  "ragV2/parser": typeof ragV2_parser;
  "repoIndexing/action": typeof repoIndexing_action;
  "repoIndexing/internalAction": typeof repoIndexing_internalAction;
  "repoIndexing/internalQuery": typeof repoIndexing_internalQuery;
  "repoIndexing/mutation": typeof repoIndexing_mutation;
  "repoIndexing/query": typeof repoIndexing_query;
  "repoIndexing/readiness": typeof repoIndexing_readiness;
  "repoIndexing/treeSnapshot": typeof repoIndexing_treeSnapshot;
  "repoIndexing/watchdog": typeof repoIndexing_watchdog;
  "repoLearnings/action": typeof repoLearnings_action;
  "repoLearnings/internalQuery": typeof repoLearnings_internalQuery;
  "repoLearnings/mutation": typeof repoLearnings_mutation;
  "repoLearnings/query": typeof repoLearnings_query;
  "repoLearnings/trust": typeof repoLearnings_trust;
  "repositories/accessLifecycle": typeof repositories_accessLifecycle;
  "repositories/action": typeof repositories_action;
  "repositories/aiReadiness": typeof repositories_aiReadiness;
  "repositories/embeddingPolicy": typeof repositories_embeddingPolicy;
  "repositories/embeddingPolicyRuntime": typeof repositories_embeddingPolicyRuntime;
  "repositories/immutableIdentity": typeof repositories_immutableIdentity;
  "repositories/internalMutation": typeof repositories_internalMutation;
  "repositories/internalQuery": typeof repositories_internalQuery;
  "repositories/mutation": typeof repositories_mutation;
  "repositories/nameIdentity": typeof repositories_nameIdentity;
  "repositories/osiLicense": typeof repositories_osiLicense;
  "repositories/query": typeof repositories_query;
  "repositoryMembers/mutation": typeof repositoryMembers_mutation;
  "repositoryMembers/query": typeof repositoryMembers_query;
  "subscriptions/action": typeof subscriptions_action;
  "subscriptions/billingBoundaries": typeof subscriptions_billingBoundaries;
  "subscriptions/entitlement": typeof subscriptions_entitlement;
  "subscriptions/internalMutation": typeof subscriptions_internalMutation;
  "subscriptions/internalQuery": typeof subscriptions_internalQuery;
  "subscriptions/query": typeof subscriptions_query;
  "subscriptions/quotaEntitlement": typeof subscriptions_quotaEntitlement;
  "subscriptions/wallet": typeof subscriptions_wallet;
  "ticketActions/action": typeof ticketActions_action;
  "ticketActions/executionRecovery": typeof ticketActions_executionRecovery;
  "ticketActions/internalAction": typeof ticketActions_internalAction;
  "ticketActions/internalMutation": typeof ticketActions_internalMutation;
  "ticketActions/internalQuery": typeof ticketActions_internalQuery;
  "ticketActions/query": typeof ticketActions_query;
  "tickets/internalAction": typeof tickets_internalAction;
  "tickets/internalMutation": typeof tickets_internalMutation;
  "tickets/internalQuery": typeof tickets_internalQuery;
  "tickets/mutation": typeof tickets_mutation;
  "tickets/query": typeof tickets_query;
  "tokenUsage/internalMutation": typeof tokenUsage_internalMutation;
  "tokenUsage/internalQuery": typeof tokenUsage_internalQuery;
  "tokenUsage/query": typeof tokenUsage_query;
  "tokenUsage/quota": typeof tokenUsage_quota;
  "tokenUsage/totals": typeof tokenUsage_totals;
  "users/action": typeof users_action;
  "users/internalQuery": typeof users_internalQuery;
  "users/legal": typeof users_legal;
  "users/mutation": typeof users_mutation;
  "users/query": typeof users_query;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
