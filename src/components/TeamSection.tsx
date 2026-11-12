import { useQuery, useMutation } from "convex/react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { Users, Plus, X, Crown, Eye, LogOut } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import type { InvitationUnavailableReason } from "../../convex/invitations/availability";
import { cn } from "../utils/cn";
import { showToast } from "../utils/signals/toast";
import { Modal } from "./uis/Modal";
import { InviteMemberModal } from "./InviteMemberModal";

interface TeamSectionProps {
  repositoryId: Id<"repositories">;
  isOwner: boolean;
  invitationUnavailableReason?: InvitationUnavailableReason;
}

export function TeamSection({
  repositoryId,
  isOwner,
  invitationUnavailableReason,
}: TeamSectionProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showProUpgradeModal, setShowProUpgradeModal] = useState(false);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);

  const members = useQuery(api.repositoryMembers.query.list, { repositoryId });
  const pendingInvitations = useQuery(
    api.invitations.query.getPendingForRepository,
    {
      repositoryId,
    },
  );
  const subscription = useQuery(api.subscriptions.query.getCurrent);

  const removeMember = useMutation(api.repositoryMembers.mutation.remove);
  const leaveRepo = useMutation(api.repositoryMembers.mutation.leave);
  const cancelInvitation = useMutation(api.invitations.mutation.cancel);

  const isPro = subscription?.plan === "pro";
  const invitationUnavailableMessage = invitationUnavailableReason
    ? t(`team.inviteUnavailable.${invitationUnavailableReason}`)
    : undefined;

  const handleInviteClick = () => {
    if (invitationUnavailableReason) {
      return;
    }
    if (isPro) {
      setShowInviteModal(true);
    } else {
      setShowProUpgradeModal(true);
    }
  };

  const handleRemoveMember = async (memberId: Id<"repositoryMembers">) => {
    try {
      setRemovingMemberId(memberId);
      await removeMember({ memberId });
      showToast(t("team.memberRemoved"), "success");
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : t("common.error"),
        "error",
      );
    } finally {
      setRemovingMemberId(null);
    }
  };

  const handleLeave = async () => {
    try {
      await leaveRepo({ repositoryId });
      showToast(t("team.leftRepository"), "success");
      navigate("/");
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : t("common.error"),
        "error",
      );
    }
  };

  const handleCancelInvitation = async (invitationId: Id<"invitations">) => {
    try {
      await cancelInvitation({ invitationId });
      showToast(t("team.invitationCancelled"), "success");
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : t("common.error"),
        "error",
      );
    }
  };

  const getRoleIcon = (role: string) => {
    switch (role) {
      case "owner":
        return <Crown size={14} className={cn("text-yellow-500")} />;
      case "viewer":
        return <Eye size={14} />;
      default:
        return null;
    }
  };

  return (
    <>
      <section
        className={cn(
          "border border-gray-200 dark:border-gray-800",
          "bg-white dark:bg-[#0a0a0a]",
        )}
      >
        {/* Header */}
        <div
          className={cn(
            "flex items-center justify-between",
            "px-6 py-4",
            "border-b border-gray-200 dark:border-gray-800",
          )}
        >
          <div className={cn("flex items-center gap-2")}>
            <Users size={20} className="shrink-0" />
            <h2 className={cn("text-lg font-bold")}>{t("team.title")}</h2>
          </div>
          {isOwner && (
            <button
              onClick={handleInviteClick}
              disabled={invitationUnavailableReason !== undefined}
              aria-describedby={
                invitationUnavailableReason
                  ? "team-invitation-unavailable"
                  : undefined
              }
              title={invitationUnavailableMessage}
              className={cn(
                "flex items-center gap-1",
                "px-3 py-1.5",
                "bg-black text-white text-sm",
                "hover:bg-gray-800",
                "dark:bg-white dark:text-black dark:hover:bg-gray-200",
                "disabled:cursor-not-allowed disabled:opacity-50",
                "transition-colors",
              )}
            >
              <Plus size={16} />
              {t("team.inviteMember")}
            </button>
          )}
        </div>

        {isOwner && invitationUnavailableMessage && (
          <p
            id="team-invitation-unavailable"
            className={cn(
              "px-6 py-3 text-sm",
              "text-amber-900 bg-amber-50",
              "border-b border-amber-200",
              "dark:text-amber-100 dark:bg-amber-950/30 dark:border-amber-900",
            )}
          >
            {invitationUnavailableMessage}
          </p>
        )}

        {/* Members List */}
        <div className={cn("p-6")}>
          <h3
            className={cn(
              "text-sm font-medium text-gray-500 dark:text-gray-400 mb-4",
            )}
          >
            {t("team.members")} ({members?.length ?? 0})
          </h3>
          <div className={cn("space-y-3")}>
            {members?.map((member) => (
              <div
                key={member.userId}
                className={cn(
                  "flex items-center justify-between",
                  "p-3",
                  "border border-gray-100 dark:border-gray-800",
                )}
              >
                <div className={cn("flex items-center gap-3")}>
                  {member.avatarUrl ? (
                    <img
                      src={member.avatarUrl}
                      alt={member.githubUsername}
                      className={cn("w-8 h-8")}
                    />
                  ) : (
                    <div
                      className={cn(
                        "w-8 h-8",
                        "bg-gray-200 dark:bg-gray-700",
                        "flex items-center justify-center",
                      )}
                    >
                      <span className={cn("text-sm font-medium")}>
                        {member.githubUsername[0].toUpperCase()}
                      </span>
                    </div>
                  )}
                  <div>
                    <div className={cn("flex items-center gap-2")}>
                      <span className={cn("font-medium")}>
                        {member.displayName || member.githubUsername}
                      </span>
                      {member.isCurrentUser && (
                        <span
                          className={cn(
                            "text-xs px-1.5 py-0.5",
                            "bg-gray-100 text-gray-600",
                            "dark:bg-gray-800 dark:text-gray-400",
                          )}
                        >
                          {t("common.you")}
                        </span>
                      )}
                    </div>
                    <span
                      className={cn("text-sm text-gray-500 dark:text-gray-400")}
                    >
                      @{member.githubUsername}
                    </span>
                  </div>
                </div>
                <div className={cn("flex items-center gap-2")}>
                  <span
                    className={cn(
                      "flex items-center gap-1",
                      "text-sm text-gray-600 dark:text-gray-400",
                    )}
                  >
                    {getRoleIcon(member.role)}
                    {t(`team.roles.${member.role}`)}
                  </span>
                  {isOwner && member.role !== "owner" && member._id && (
                    <div className={cn("flex items-center gap-1 ml-2")}>
                      <button
                        onClick={() =>
                          handleRemoveMember(
                            member._id as Id<"repositoryMembers">,
                          )
                        }
                        disabled={removingMemberId === member._id}
                        className={cn(
                          "p-1",
                          "text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20",
                          "transition-colors",
                          "disabled:opacity-50",
                        )}
                        title={t("team.remove")}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )}
                  {member.isCurrentUser && member.role !== "owner" && (
                    <button
                      onClick={handleLeave}
                      className={cn(
                        "flex items-center gap-1 ml-2",
                        "text-sm text-red-500 hover:text-red-600",
                      )}
                    >
                      <LogOut size={14} />
                      {t("team.leave")}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Pending Invitations */}
          {isOwner && pendingInvitations && pendingInvitations.length > 0 && (
            <div className={cn("mt-6")}>
              <h3
                className={cn(
                  "text-sm font-medium text-gray-500 dark:text-gray-400 mb-4",
                )}
              >
                {t("team.pendingInvitations")} ({pendingInvitations.length})
              </h3>
              <div className={cn("space-y-2")}>
                {pendingInvitations.map((invitation) => (
                  <div
                    key={invitation._id}
                    className={cn(
                      "flex items-center justify-between",
                      "p-3",
                      "border border-dashed border-gray-200 dark:border-gray-700",
                      "bg-gray-50 dark:bg-gray-900/50",
                    )}
                  >
                    <div className={cn("flex items-center gap-3")}>
                      <div
                        className={cn(
                          "w-8 h-8",
                          "bg-gray-200 dark:bg-gray-700",
                          "flex items-center justify-center",
                        )}
                      >
                        <span className={cn("text-sm font-medium")}>
                          {invitation.inviteeGithubUsername[0].toUpperCase()}
                        </span>
                      </div>
                      <div>
                        <span className={cn("font-medium")}>
                          @{invitation.inviteeGithubUsername}
                        </span>
                        <div
                          className={cn(
                            "text-xs text-gray-500 dark:text-gray-400",
                          )}
                        >
                          {t("invitations.pending")} •{" "}
                          {t(`team.roles.${invitation.role}`)}
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => handleCancelInvitation(invitation._id)}
                      className={cn(
                        "text-sm text-gray-500 hover:text-red-500",
                        "transition-colors",
                      )}
                    >
                      {t("common.cancel")}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Invite Member Modal */}
      <InviteMemberModal
        isOpen={showInviteModal}
        onClose={() => setShowInviteModal(false)}
        repositoryId={repositoryId}
      />

      {/* Pro Upgrade Modal */}
      <Modal
        isOpen={showProUpgradeModal}
        onClose={() => setShowProUpgradeModal(false)}
        title={t("team.proRequired")}
      >
        <div className={cn("space-y-4")}>
          <p className={cn("text-gray-600 dark:text-gray-400")}>
            {t("team.proRequiredDescription")}
          </p>
          <div className={cn("flex justify-end gap-2")}>
            <button
              onClick={() => setShowProUpgradeModal(false)}
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
              onClick={() => {
                setShowProUpgradeModal(false);
                navigate("/pricing");
              }}
              className={cn(
                "px-4 py-2",
                "bg-black text-white",
                "hover:bg-gray-800",
                "dark:bg-white dark:text-black dark:hover:bg-gray-200",
                "transition-colors",
              )}
            >
              {t("team.viewPricing")}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
