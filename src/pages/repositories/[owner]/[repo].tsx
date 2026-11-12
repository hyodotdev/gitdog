import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Doc, Id } from "../../../../convex/_generated/dataModel";
import { useParams, useNavigate } from "react-router";
import { Helmet } from "react-helmet-async";
import { Layout } from "../../../components/Layout";
import { ChevronLeft, RefreshCw, Save, Trash2, X } from "lucide-react";
import { SiGithub } from "@icons-pack/react-simple-icons";
import { useState } from "react";
import { showToast } from "../../../utils/signals/toast";
import { Accordion } from "../../../components/uis/Accordion";
import { Checkbox } from "../../../components/uis/Checkbox";
import { LoadingIndicator } from "../../../components/uis/LoadingIndicator";
import { useTranslation } from "react-i18next";
import { cn } from "../../../utils/cn";
import { IndexingStatus } from "../../home/IndexingStatus";
import { Button } from "../../../components/uis/Button";
import { TeamSection } from "../../../components/TeamSection";

export function RepositorySettingsPage() {
  const { t } = useTranslation();
  const { owner, repo } = useParams<{ owner: string; repo: string }>();
  const navigate = useNavigate();
  const repository = useQuery(
    api.repositories.query.get,
    owner && repo ? { owner, repo } : "skip",
  );
  const learningCount = useQuery(
    api.repoLearnings.query.countByRepository,
    repository?._id ? { repositoryId: repository._id } : "skip",
  );
  const updateSettings = useMutation(api.repositories.mutation.updateSettings);
  const toggleActive = useMutation(api.repositories.mutation.toggleActive);
  const removeRepository = useMutation(api.repositories.mutation.remove);
  const syncRepository = useAction(api.repositories.action.syncRepository);

  const [settingsDraft, setSettingsDraft] = useState<{
    repositoryId: Id<"repositories">;
    settings: Doc<"repositories">["settings"];
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [showLogs, setShowLogs] = useState(false);

  if (!owner || !repo) {
    return <div>{t("repositories.settings.errors.invalidRepository")}</div>;
  }

  if (repository === undefined) {
    return (
      <Layout>
        <div
          className={cn(
            "max-w-5xl mx-auto px-6 py-12 flex items-center justify-center",
          )}
        >
          <LoadingIndicator />
        </div>
      </Layout>
    );
  }

  if (!repository) {
    return (
      <Layout>
        <div className={cn("max-w-5xl mx-auto px-6 py-12")}>
          {t("repositories.settings.errors.notFound")}
        </div>
      </Layout>
    );
  }

  const hasLocalChanges = settingsDraft?.repositoryId === repository._id;
  const currentSettings = hasLocalChanges
    ? settingsDraft.settings
    : repository.settings;
  const indexStatus = repository.indexStatus;
  const ragStatus = repository.ragStatus;
  const isOwner = repository.userRole === "owner";
  const requiresReconnect =
    repository.githubInstallationReconnectRequired === true;
  const isGithubAccessRevoked =
    repository.githubAccessRevokedAt !== undefined && !requiresReconnect;
  const invitationRepositoryFallback = requiresReconnect
    ? ("reconnect" as const)
    : isGithubAccessRevoked
      ? ("revoked" as const)
      : undefined;
  const invitationUnavailableReason = disconnecting
    ? ("disconnecting" as const)
    : (repository.invitationUnavailableReason ?? invitationRepositoryFallback);

  const handleSave = async () => {
    if (!isOwner || !currentSettings) return;

    setSaving(true);
    try {
      await updateSettings({
        repositoryId: repository._id,
        settings: currentSettings,
      });
      setSettingsDraft(null);
      showToast(t("repositories.settings.saveSuccess"), "success");
    } catch (err) {
      showToast(
        err instanceof Error
          ? err.message
          : t("repositories.settings.saveFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async () => {
    if (!isOwner || isGithubAccessRevoked || requiresReconnect) return;
    try {
      await toggleActive({ repositoryId: repository._id });
      showToast(
        repository.isActive
          ? t("repositories.settings.repositoryPaused")
          : t("repositories.settings.repositoryActivated"),
        "success",
      );
    } catch (err) {
      showToast(
        err instanceof Error
          ? err.message
          : t("repositories.settings.toggleFailed"),
        "error",
      );
    }
  };

  const handleDisconnect = async () => {
    if (!isOwner) return;
    setDisconnecting(true);
    try {
      await removeRepository({ repositoryId: repository._id });
      showToast(t("repositories.settings.disconnectSuccess"), "success");
      navigate("/");
    } catch (err) {
      showToast(
        err instanceof Error
          ? err.message
          : t("repositories.settings.disconnectFailed"),
        "error",
      );
      setDisconnecting(false);
    }
    setShowDisconnectConfirm(false);
  };

  const handleSync = async () => {
    if (!isOwner || isGithubAccessRevoked || requiresReconnect) return;
    setSyncing(true);
    try {
      const result = await syncRepository({ repositoryId: repository._id });
      if (result.success) {
        showToast(t("repositories.settings.syncStarted"), "success");
        setShowLogs(true);
      } else {
        showToast(result.message, "error");
      }
    } catch (err) {
      showToast(
        err instanceof Error
          ? err.message
          : t("repositories.settings.syncFailed"),
        "error",
      );
    } finally {
      setSyncing(false);
    }
  };

  const updateSetting = (key: string, value: boolean | string) => {
    if (!isOwner) return;
    setSettingsDraft({
      repositoryId: repository._id,
      settings: {
        ...currentSettings,
        [key]: value,
      },
    });
  };

  // Keep file and RAG work on the same observable recovery screen.
  if (
    repository &&
    !requiresReconnect &&
    repository.isActive &&
    (indexStatus === "pending" ||
      indexStatus === "indexing" ||
      ragStatus === "indexing" ||
      (indexStatus === "completed" && ragStatus === "pending"))
  ) {
    return (
      <>
        <Helmet>
          <title>
            {t("repositories.settings.connectingTitle") ||
              "Connecting - Gitdog"}
          </title>
          <meta name="description" content="Connecting your repository" />
        </Helmet>
        <Layout>
          <div className={cn("max-w-7xl mx-auto px-6 py-12")}>
            <button
              onClick={() => navigate("/")}
              className={cn(
                "flex items-center gap-2 text-gray-600 mb-4",
                "hover:text-black",
                "dark:text-gray-400 dark:hover:text-white",
              )}
            >
              <ChevronLeft size={20} />
              {t("repositories.settings.connectingBackButton")}
            </button>
            <IndexingStatus
              repositoryId={repository._id}
              repositoryName={repository.githubRepo}
            />
          </div>
        </Layout>
      </>
    );
  }

  return (
    <>
      <Helmet>
        <title>
          {t("repositories.settings.title", { owner, repo }) ||
            `${owner}/${repo} - Gitdog`}
        </title>
        <meta
          name="description"
          content={t("repositories.settings.description") || ""}
        />
      </Helmet>
      <Layout>
        <div className={cn("max-w-5xl mx-auto px-6 py-12")}>
          {/* Header */}
          <div className={cn("mb-8")}>
            <button
              onClick={() => navigate("/")}
              className={cn(
                "flex items-center gap-2 text-gray-600 mb-4",
                "hover:text-black",
                "dark:text-gray-400 dark:hover:text-white",
              )}
            >
              <ChevronLeft size={20} className="shrink-0" />
              {t("repositories.settings.backToWorkspace")}
            </button>
            <div
              className={cn(
                "flex flex-wrap items-center justify-between gap-4",
              )}
            >
              <div className={cn("min-w-0")}>
                <div className={cn("flex flex-wrap items-center gap-3 mb-2")}>
                  <a
                    href={`https://github.com/${owner}/${repo}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      "text-gray-700 hover:text-black transition-colors",
                      "dark:text-gray-300 dark:hover:text-white",
                    )}
                  >
                    <SiGithub size={32} aria-hidden="true" />
                    <span className="sr-only">
                      {owner}/{repo}
                    </span>
                  </a>
                  <h1
                    className={cn(
                      "min-w-0 text-3xl font-brand font-bold text-black break-words",
                      "dark:text-white",
                    )}
                  >
                    {owner}/{repo}
                  </h1>
                  {isGithubAccessRevoked ? (
                    <span
                      className={cn(
                        "px-3 py-1 text-sm text-red-700",
                        "bg-red-100 border border-red-300",
                        "dark:bg-red-950/30 dark:border-red-800 dark:text-red-300",
                      )}
                    >
                      {t("repositories.settings.githubAccessRemoved")}
                    </span>
                  ) : requiresReconnect ? (
                    <span
                      className={cn(
                        "px-3 py-1 text-sm text-amber-800",
                        "bg-amber-100 border border-amber-300",
                        "dark:bg-amber-950/30 dark:border-amber-800 dark:text-amber-200",
                      )}
                    >
                      {t("repositories.settings.reconnectRequired")}
                    </span>
                  ) : !repository.isActive ? (
                    <span
                      className={cn(
                        "px-3 py-1 text-sm text-gray-600",
                        "bg-gray-200",
                        "dark:bg-gray-800 dark:text-gray-400",
                      )}
                    >
                      {t("repositories.settings.paused")}
                    </span>
                  ) : null}
                </div>
                {repository.description && (
                  <p className={cn("text-gray-600", "dark:text-gray-400")}>
                    {repository.description}
                  </p>
                )}
              </div>
              <div className={cn("flex flex-wrap items-center gap-3")}>
                <button
                  onClick={() => setShowLogs(true)}
                  className={cn(
                    "text-sm text-gray-600 hover:text-black underline",
                    "dark:text-gray-400 dark:hover:text-white",
                  )}
                >
                  {t("repositories.settings.logsButton")}
                </button>
                {isOwner && (
                  <>
                    <button
                      onClick={handleSync}
                      disabled={
                        isGithubAccessRevoked ||
                        requiresReconnect ||
                        syncing ||
                        (repository.isActive &&
                          (indexStatus === "pending" ||
                            indexStatus === "indexing" ||
                            ragStatus === "indexing" ||
                            (indexStatus === "completed" &&
                              ragStatus === "pending")))
                      }
                      className={cn(
                        "flex items-center gap-2 px-4 py-2 text-gray-700",
                        "border border-gray-300",
                        "hover:bg-gray-100",
                        "disabled:opacity-50 disabled:cursor-not-allowed",
                        "dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800",
                      )}
                    >
                      <RefreshCw
                        size={16}
                        className={cn(syncing && "animate-spin")}
                      />
                      {syncing
                        ? t("repositories.settings.syncing")
                        : t("repositories.settings.syncButton")}
                    </button>
                    <button
                      onClick={handleToggleActive}
                      disabled={isGithubAccessRevoked || requiresReconnect}
                      className={cn(
                        "px-4 py-2 text-gray-700",
                        "border border-gray-300",
                        "hover:bg-gray-100",
                        "disabled:opacity-50 disabled:cursor-not-allowed",
                        "dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800",
                      )}
                    >
                      {repository.isActive
                        ? t("repositories.settings.pauseButton")
                        : t("repositories.settings.activateButton")}
                    </button>
                    <button
                      onClick={handleSave}
                      disabled={saving || !hasLocalChanges}
                      className={cn(
                        "flex items-center gap-2 px-4 py-2 whitespace-nowrap",
                        "bg-black text-white",
                        "hover:bg-gray-800",
                        "disabled:opacity-50 disabled:cursor-not-allowed",
                        "dark:bg-white dark:text-black dark:hover:bg-gray-200",
                      )}
                    >
                      <Save size={16} />
                      {saving
                        ? t("repositories.settings.saving")
                        : t("repositories.settings.saveButton")}
                    </button>
                  </>
                )}
              </div>
            </div>
            {isGithubAccessRevoked && (
              <div
                className={cn(
                  "flex items-center justify-between gap-4 mt-6 p-4",
                  "text-red-950 bg-red-50 border border-red-300",
                  "dark:text-red-100 dark:bg-red-950/30 dark:border-red-800",
                )}
              >
                <p className={cn("text-sm")}>
                  {t("repositories.settings.githubAccessRemovedDescription")}
                </p>
                {isOwner && (
                  <a
                    href={`https://github.com/settings/installations/${repository.installationId}`}
                    className={cn(
                      "shrink-0 px-4 py-2 text-sm",
                      "text-red-700 border border-red-500",
                      "hover:bg-red-100",
                      "dark:text-red-200 dark:border-red-600 dark:hover:bg-red-950/50",
                    )}
                  >
                    {t("repositories.settings.manageGithubAccess")}
                  </a>
                )}
              </div>
            )}
            {requiresReconnect && (
              <div
                className={cn(
                  "flex items-center justify-between gap-4 mt-6 p-4",
                  "text-amber-950 bg-amber-50 border border-amber-300",
                  "dark:text-amber-100 dark:bg-amber-950/30 dark:border-amber-800",
                )}
              >
                <p className={cn("text-sm")}>
                  {t(
                    isOwner
                      ? "repositories.settings.reconnectDescription"
                      : "repositories.settings.reconnectDescriptionReadOnly",
                  )}
                </p>
                {isOwner && (
                  <button
                    onClick={() =>
                      navigate(
                        `/repositories/connect?reconnectRepositoryId=${encodeURIComponent(repository._id)}`,
                      )
                    }
                    className={cn(
                      "shrink-0 px-4 py-2 text-sm",
                      "text-amber-900 border border-amber-500",
                      "hover:bg-amber-100",
                      "dark:text-amber-100 dark:border-amber-600 dark:hover:bg-amber-950/50",
                    )}
                  >
                    {t("repositories.settings.reconnectButton")}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Settings Sections */}
          <div className={cn("space-y-8")}>
            <section
              className={cn("p-6 border border-gray-200 dark:border-gray-800")}
            >
              <h2 className={cn("text-xl font-brand font-bold mb-4")}>
                {t("repositories.settings.pullRequests.title")}
              </h2>
              <div className={cn("space-y-4")}>
                <Checkbox
                  checked={currentSettings.pullRequestReviewsEnabled === true}
                  disabled={!isOwner}
                  onChange={(checked) =>
                    updateSetting("pullRequestReviewsEnabled", checked)
                  }
                  label={t("repositories.settings.pullRequests.enabled")}
                  description={t(
                    "repositories.settings.pullRequests.description",
                  )}
                />
                <Checkbox
                  checked={
                    currentSettings.pullRequestSuggestionsEnabled !== false
                  }
                  disabled={!isOwner}
                  onChange={(checked) =>
                    updateSetting("pullRequestSuggestionsEnabled", checked)
                  }
                  label={t("repositories.settings.pullRequests.suggestions")}
                  description={t(
                    "repositories.settings.pullRequests.suggestionsDescription",
                  )}
                />
                <Checkbox
                  checked={
                    currentSettings.requireApprovalForPullRequests !== false
                  }
                  disabled={!isOwner}
                  onChange={(checked) =>
                    updateSetting("requireApprovalForPullRequests", checked)
                  }
                  label={t("repositories.settings.pullRequests.approval")}
                  description={t(
                    "repositories.settings.pullRequests.approvalDescription",
                  )}
                />
                <p className={cn("text-sm text-gray-500 dark:text-gray-400")}>
                  {t("repositories.settings.pullRequests.limitations")}
                </p>
                {isOwner && !requiresReconnect && (
                  <a
                    href={`https://github.com/settings/installations/${repository.installationId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block text-sm underline"
                  >
                    {t("repositories.settings.pullRequests.permissions")}
                  </a>
                )}
              </div>
            </section>

            {/* Issue Assistant */}
            <section
              className={cn(
                "p-6",
                "border border-gray-200",
                "dark:border-gray-800",
              )}
            >
              <h2
                className={cn(
                  "text-xl font-brand font-bold text-black mb-4",
                  "dark:text-white",
                )}
              >
                {t("repositories.settings.issueAssistant.title")}
              </h2>
              <div className={cn("space-y-4")}>
                <Checkbox
                  checked={currentSettings.issueAssistantEnabled}
                  disabled={!isOwner}
                  onChange={(checked) =>
                    updateSetting("issueAssistantEnabled", checked)
                  }
                  label={t(
                    "repositories.settings.issueAssistant.enabled.label",
                  )}
                  description={t(
                    "repositories.settings.issueAssistant.enabled.description",
                  )}
                />
                <Checkbox
                  checked={currentSettings.autoFormatIssue}
                  disabled={!isOwner}
                  onChange={(checked) =>
                    updateSetting("autoFormatIssue", checked)
                  }
                  label={t(
                    "repositories.settings.issueAssistant.autoFormat.label",
                  )}
                  description={t(
                    "repositories.settings.issueAssistant.autoFormat.description",
                  )}
                />
                <Checkbox
                  checked={currentSettings.autoAnswerQuestions}
                  disabled={!isOwner}
                  onChange={(checked) =>
                    updateSetting("autoAnswerQuestions", checked)
                  }
                  label={t(
                    "repositories.settings.issueAssistant.autoAnswer.label",
                  )}
                  description={t(
                    "repositories.settings.issueAssistant.autoAnswer.description",
                  )}
                />
                <Checkbox
                  checked={currentSettings.tagMaintainersForCodeChanges}
                  disabled={!isOwner}
                  onChange={(checked) =>
                    updateSetting("tagMaintainersForCodeChanges", checked)
                  }
                  label={t(
                    "repositories.settings.issueAssistant.tagMaintainers.label",
                  )}
                  description={t(
                    "repositories.settings.issueAssistant.tagMaintainers.description",
                  )}
                />
                <Checkbox
                  checked={currentSettings.requireApproval}
                  disabled={!isOwner}
                  onChange={(checked) =>
                    updateSetting("requireApproval", checked)
                  }
                  label={t(
                    "repositories.settings.issueAssistant.requireApproval.label",
                  )}
                  description={t(
                    "repositories.settings.issueAssistant.requireApproval.description",
                  )}
                />
                {/* Response Style System Prompt - Accordion */}
                <Accordion
                  bordered={false}
                  title={
                    <span className={cn("text-sm font-medium")}>
                      {t(
                        "repositories.settings.issueAssistant.responseStyle.label",
                      ) || "Response style (optional)"}
                    </span>
                  }
                  className={cn(
                    "mt-4 pt-4 border-t border-gray-200 dark:border-gray-700",
                  )}
                  headerClassName={cn(
                    "bg-transparent hover:bg-gray-50 dark:hover:bg-gray-800/50",
                    "py-2 px-0",
                  )}
                  contentClassName="pb-2"
                >
                  <p
                    className={cn(
                      "text-sm text-gray-500 mb-3",
                      "dark:text-gray-400",
                    )}
                  >
                    {t(
                      "repositories.settings.issueAssistant.responseStyle.description",
                    ) ||
                      "Customize how the AI responds to issues. This will be added to the system prompt."}
                  </p>
                  <textarea
                    value={currentSettings.issueResponseStyle ?? ""}
                    readOnly={!isOwner}
                    onChange={(e) =>
                      updateSetting("issueResponseStyle", e.target.value)
                    }
                    placeholder={
                      t(
                        "repositories.settings.issueAssistant.responseStyle.placeholder",
                      ) ||
                      "e.g., Always respond in a friendly and professional tone. Use bullet points for clarity. Include code examples when relevant."
                    }
                    rows={4}
                    className={cn(
                      "w-full px-4 py-3 text-sm",
                      "border border-gray-300",
                      "bg-white text-black",
                      "placeholder:text-gray-400",
                      "focus:outline-hidden focus:border-black",
                      "dark:bg-gray-900 dark:text-white dark:border-gray-700",
                      "dark:placeholder:text-gray-500 dark:focus:border-white",
                    )}
                  />
                </Accordion>
              </div>
            </section>

            {/* Discussion Assistant */}
            <section
              className={cn(
                "p-6",
                "border border-gray-200",
                "dark:border-gray-800",
              )}
            >
              <h2
                className={cn(
                  "text-xl font-brand font-bold text-black mb-4",
                  "dark:text-white",
                )}
              >
                {t("repositories.settings.discussionAssistant.title") ||
                  "Discussion Assistant"}
              </h2>
              <div className={cn("space-y-4")}>
                <Checkbox
                  checked={currentSettings.discussionAssistantEnabled ?? false}
                  disabled={!isOwner}
                  onChange={(checked) =>
                    updateSetting("discussionAssistantEnabled", checked)
                  }
                  label={
                    t(
                      "repositories.settings.discussionAssistant.enabled.label",
                    ) || "Enable Discussion Assistant"
                  }
                  description={
                    t(
                      "repositories.settings.discussionAssistant.enabled.description",
                    ) || "Enable AI-powered assistance for GitHub Discussions"
                  }
                />
                <Checkbox
                  checked={currentSettings.autoFormatDiscussion}
                  disabled={!isOwner}
                  onChange={(checked) =>
                    updateSetting("autoFormatDiscussion", checked)
                  }
                  label={
                    t(
                      "repositories.settings.discussionAssistant.autoFormat.label",
                    ) || "Auto-format discussions"
                  }
                  description={
                    t(
                      "repositories.settings.discussionAssistant.autoFormat.description",
                    ) ||
                    "Automatically improve poorly written discussion titles and bodies"
                  }
                />
                <Checkbox
                  checked={currentSettings.autoAnswerDiscussionQuestions}
                  disabled={!isOwner}
                  onChange={(checked) =>
                    updateSetting("autoAnswerDiscussionQuestions", checked)
                  }
                  label={
                    t(
                      "repositories.settings.discussionAssistant.autoAnswer.label",
                    ) || "Auto-answer questions"
                  }
                  description={
                    t(
                      "repositories.settings.discussionAssistant.autoAnswer.description",
                    ) ||
                    "Automatically answer questions based on your codebase in discussions"
                  }
                />
                <Checkbox
                  checked={
                    currentSettings.tagMaintainersForDiscussionCodeChanges ??
                    true
                  }
                  disabled={!isOwner}
                  onChange={(checked) =>
                    updateSetting(
                      "tagMaintainersForDiscussionCodeChanges",
                      checked,
                    )
                  }
                  label={
                    t(
                      "repositories.settings.discussionAssistant.tagMaintainers.label",
                    ) || "Tag maintainers"
                  }
                  description={
                    t(
                      "repositories.settings.discussionAssistant.tagMaintainers.description",
                    ) ||
                    "Tag relevant maintainers when code changes are discussed"
                  }
                />
                <Checkbox
                  checked={currentSettings.requireApprovalForDiscussions}
                  disabled={!isOwner}
                  onChange={(checked) =>
                    updateSetting("requireApprovalForDiscussions", checked)
                  }
                  label={
                    t(
                      "repositories.settings.discussionAssistant.requireApproval.label",
                    ) || "Require approval before actions"
                  }
                  description={
                    t(
                      "repositories.settings.discussionAssistant.requireApproval.description",
                    ) ||
                    "Review AI suggestions before they are posted to GitHub"
                  }
                />
                {/* Response Style System Prompt - Accordion */}
                <Accordion
                  bordered={false}
                  title={
                    <span className={cn("text-sm font-medium")}>
                      {t(
                        "repositories.settings.discussionAssistant.responseStyle.label",
                      ) || "Response style (optional)"}
                    </span>
                  }
                  className={cn(
                    "mt-4 pt-4 border-t border-gray-200 dark:border-gray-700",
                  )}
                  headerClassName={cn(
                    "bg-transparent hover:bg-gray-50 dark:hover:bg-gray-800/50",
                    "py-2 px-0",
                  )}
                  contentClassName="pb-2"
                >
                  <p
                    className={cn(
                      "text-sm text-gray-500 mb-3",
                      "dark:text-gray-400",
                    )}
                  >
                    {t(
                      "repositories.settings.discussionAssistant.responseStyle.description",
                    ) ||
                      "Customize how the AI responds to discussions. This will be added to the system prompt."}
                  </p>
                  <textarea
                    value={currentSettings.discussionResponseStyle ?? ""}
                    readOnly={!isOwner}
                    onChange={(e) =>
                      updateSetting("discussionResponseStyle", e.target.value)
                    }
                    placeholder={
                      t(
                        "repositories.settings.discussionAssistant.responseStyle.placeholder",
                      ) ||
                      "e.g., Provide detailed explanations with examples. Be welcoming to newcomers. Link to relevant documentation when available."
                    }
                    rows={4}
                    className={cn(
                      "w-full px-4 py-3 text-sm",
                      "border border-gray-300",
                      "bg-white text-black",
                      "placeholder:text-gray-400",
                      "focus:outline-hidden focus:border-black",
                      "dark:bg-gray-900 dark:text-white dark:border-gray-700",
                      "dark:placeholder:text-gray-500 dark:focus:border-white",
                    )}
                  />
                </Accordion>
              </div>
            </section>

            {/* Team */}
            <TeamSection
              repositoryId={repository._id}
              isOwner={isOwner}
              invitationUnavailableReason={invitationUnavailableReason}
            />

            {/* Danger Zone */}
            {isOwner && (
              <section
                className={cn(
                  "p-6",
                  "bg-red-50/50",
                  "border border-red-300",
                  "dark:bg-red-950/20 dark:border-red-900",
                )}
              >
                <h2
                  className={cn(
                    "text-xl font-brand font-bold text-red-600 mb-4",
                    "dark:text-red-400",
                  )}
                >
                  {t("repositories.settings.dangerZone.title")}
                </h2>
                <div className={cn("space-y-4")}>
                  <div className={cn("flex items-center justify-between")}>
                    <div>
                      <h3
                        className={cn(
                          "text-base font-bold text-black mb-1",
                          "dark:text-white",
                        )}
                      >
                        {t("repositories.settings.dangerZone.disconnect.title")}
                      </h3>
                      <p
                        className={cn(
                          "text-sm text-gray-600",
                          "dark:text-gray-400",
                        )}
                      >
                        {t(
                          "repositories.settings.dangerZone.disconnect.description",
                        )}
                      </p>
                    </div>
                    <button
                      onClick={() => setShowDisconnectConfirm(true)}
                      className={cn(
                        "flex items-center gap-2 px-4 py-2",
                        "border-2 border-red-600 text-red-600",
                        "transition-colors",
                        "hover:bg-red-600 hover:text-white",
                        "dark:border-red-400 dark:text-red-400 dark:hover:bg-red-400 dark:hover:text-black",
                      )}
                    >
                      <Trash2 size={16} />
                      {t("repositories.settings.dangerZone.disconnect.button")}
                    </button>
                  </div>
                </div>
              </section>
            )}
          </div>

          {/* Disconnect Confirmation Modal */}
          {isOwner && showDisconnectConfirm && (
            <div
              className={cn(
                "fixed inset-0 bg-black/50 flex items-center justify-center z-50",
              )}
            >
              <div
                className={cn(
                  "relative p-8 max-w-md w-full mx-4",
                  "bg-white",
                  "border-2 border-gray-200",
                  "dark:bg-black dark:border-gray-800",
                )}
              >
                <button
                  onClick={() => setShowDisconnectConfirm(false)}
                  className={cn(
                    "absolute top-4 right-4 text-gray-400",
                    "transition-colors",
                    "hover:text-black",
                    "dark:hover:text-white",
                  )}
                  aria-label="Close"
                >
                  <X size={24} />
                </button>
                <h3
                  className={cn(
                    "text-2xl font-brand font-bold text-black mb-4 pr-8",
                    "dark:text-white",
                  )}
                >
                  {t("repositories.settings.disconnectModal.title")}
                </h3>
                <p
                  className={cn("text-gray-600 mb-4", "dark:text-gray-400")}
                  dangerouslySetInnerHTML={{
                    __html: t(
                      "repositories.settings.disconnectModal.description",
                      {
                        owner,
                        repo,
                      },
                    ),
                  }}
                />
                {/* Warning about data loss */}
                <div
                  className={cn(
                    "p-4 mb-6",
                    "bg-red-50 dark:bg-red-900/20",
                    "border border-red-200 dark:border-red-800",
                  )}
                >
                  <p
                    className={cn(
                      "text-sm font-medium text-red-800 dark:text-red-200 mb-2",
                    )}
                  >
                    ⚠️ Warning: All indexed data will be permanently deleted
                  </p>
                  <ul
                    className={cn(
                      "text-xs text-red-700 dark:text-red-300 list-disc ml-4 space-y-1",
                    )}
                  >
                    <li>Code structure analysis and file mappings</li>
                    <li>Dependency graphs and indexing data</li>
                    {learningCount && learningCount > 0 && (
                      <li className="font-semibold">
                        {learningCount} AI learned guideline
                        {learningCount > 1 ? "s" : ""} from past interactions
                      </li>
                    )}
                  </ul>
                  <p
                    className={cn(
                      "text-xs text-red-700 dark:text-red-300 mt-2 font-medium",
                    )}
                  >
                    This action cannot be undone.
                  </p>
                </div>
                <div className={cn("flex gap-3")}>
                  <Button
                    variant="secondary"
                    size="lg"
                    onClick={() => setShowDisconnectConfirm(false)}
                    className="flex-1"
                    disabled={disconnecting}
                  >
                    {t("repositories.settings.disconnectModal.cancel")}
                  </Button>
                  <Button
                    variant="danger"
                    size="lg"
                    onClick={handleDisconnect}
                    loading={disconnecting}
                    icon={!disconnecting && <Trash2 size={16} />}
                    className="flex-1"
                  >
                    {t("repositories.settings.disconnectModal.confirm")}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Logs Modal */}
          {showLogs && repository && (
            <div
              className={cn(
                "fixed inset-0 bg-black/50 flex items-center justify-center z-50",
                "dark:bg-white/10",
              )}
              onClick={() => setShowLogs(false)}
            >
              <div
                className={cn(
                  "bg-white w-full max-w-4xl max-h-[80vh] overflow-y-auto",
                  "dark:bg-gray-900",
                  "border border-gray-200",
                  "dark:border-gray-800",
                )}
                onClick={(e) => e.stopPropagation()}
              >
                <div
                  className={cn(
                    "sticky top-0 bg-white",
                    "dark:bg-gray-900",
                    "border-b border-gray-200",
                    "dark:border-gray-800",
                    "p-6 flex items-center justify-between",
                  )}
                >
                  <h2
                    className={cn(
                      "text-xl font-brand font-bold text-black",
                      "dark:text-white",
                    )}
                  >
                    {t("repositories.settings.logsModalTitle")}
                  </h2>
                  <button
                    onClick={() => setShowLogs(false)}
                    className={cn(
                      "text-gray-600 hover:text-black",
                      "dark:text-gray-400 dark:hover:text-white",
                    )}
                  >
                    <X size={24} />
                  </button>
                </div>
                <div className={cn("p-6")}>
                  <IndexingStatus
                    repositoryId={repository._id}
                    repositoryName={repository.githubRepo}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </Layout>
    </>
  );
}
