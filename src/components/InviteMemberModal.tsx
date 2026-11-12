import { useAction } from "convex/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { cn } from "../utils/cn";
import { showToast } from "../utils/signals/toast";
import { Modal } from "./uis/Modal";

interface InviteMemberModalProps {
  isOpen: boolean;
  onClose: () => void;
  repositoryId: Id<"repositories">;
}

export function InviteMemberModal({
  isOpen,
  onClose,
  repositoryId,
}: InviteMemberModalProps) {
  const { t } = useTranslation();
  const [githubUsername, setGithubUsername] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createInvitation = useAction(api.invitations.action.create);

  const getErrorMessage = (error: unknown): string => {
    if (!(error instanceof Error)) {
      return t("common.error");
    }

    const message = error.message;

    // Map Convex error messages to i18n keys
    switch (true) {
      case message.includes("Pro subscription required"):
        return t("team.proRequired");
      case message.includes("User not found"):
        return t("team.inviteModal.userNotFound");
      case message.includes("already a member"):
        return t("team.inviteModal.alreadyMember");
      case message.includes("already pending"):
        return t("team.inviteModal.alreadyInvited");
      case message.includes("Only repository owner"):
        return t("team.ownerOnly");
      case message.includes("Repository is no longer available"):
      case message.includes("GitHub App installation is not ready"):
        return t("team.inviteModal.repositoryUnavailable");
      default:
        return t("team.inviteModal.inviteFailed");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!githubUsername.trim()) {
      setError(t("team.inviteModal.usernameRequired"));
      return;
    }

    try {
      setIsSubmitting(true);
      await createInvitation({
        repositoryId,
        inviteeGithubUsername: githubUsername.trim(),
        role: "viewer",
      });
      showToast(t("team.invitationSent"), "success");
      setGithubUsername("");
      onClose();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setGithubUsername("");
    setError(null);
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={t("team.inviteModal.title")}
    >
      <form onSubmit={handleSubmit} className={cn("space-y-4")}>
        {/* GitHub Username */}
        <div>
          <label
            htmlFor="github-username"
            className={cn("block text-sm font-medium mb-2")}
          >
            {t("team.inviteModal.usernameLabel")}
          </label>
          <input
            id="github-username"
            type="text"
            value={githubUsername}
            onChange={(e) => {
              setGithubUsername(e.target.value);
              setError(null);
            }}
            placeholder={t("team.inviteModal.usernamePlaceholder")}
            className={cn(
              "w-full px-4 py-2",
              "border border-gray-300 dark:border-gray-700",
              "bg-white dark:bg-gray-900",
              "focus:outline-hidden focus:border-black dark:focus:border-white",
            )}
          />
        </div>

        {/* Access level */}
        <div>
          <p className={cn("block text-sm font-medium mb-2")}>
            {t("team.inviteModal.roleLabel")}
          </p>
          <div
            className={cn(
              "w-full px-4 py-2",
              "text-sm text-gray-700",
              "bg-gray-50 border border-gray-300",
              "dark:text-gray-300 dark:bg-gray-900 dark:border-gray-700",
            )}
          >
            {t("team.roles.viewer")} - {t("team.roleDescriptions.viewer")}
          </div>
        </div>

        {/* Error Message */}
        {error && (
          <div
            className={cn(
              "p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm",
            )}
          >
            {error}
          </div>
        )}

        {/* Actions */}
        <div className={cn("flex justify-end gap-2 pt-2")}>
          <button
            type="button"
            onClick={handleClose}
            className={cn(
              "px-4 py-2",
              "border border-gray-300 dark:border-gray-700",
              "hover:bg-gray-100 dark:hover:bg-gray-800",
              "transition-colors",
            )}
          >
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            disabled={isSubmitting}
            className={cn(
              "px-4 py-2",
              "bg-black text-white",
              "hover:bg-gray-800",
              "dark:bg-white dark:text-black dark:hover:bg-gray-200",
              "transition-colors",
              "disabled:opacity-50 disabled:cursor-not-allowed",
            )}
          >
            {isSubmitting ? t("common.sending") : t("team.inviteModal.send")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
