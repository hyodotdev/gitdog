import { useQuery, useMutation } from "convex/react";
import { useState } from "react";
import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";
import { api } from "../../../convex/_generated/api";
import { Layout } from "../../components/Layout";
import { LoadingIndicator } from "../../components/uis/LoadingIndicator";
import { cn } from "../../utils/cn";
import { showToast } from "../../utils/signals/toast";
import { SiGithub } from "@icons-pack/react-simple-icons";

export function InvitationsPage() {
  const { t } = useTranslation();
  const pendingInvitations = useQuery(api.invitations.query.listPending);
  const acceptInvitation = useMutation(api.invitations.mutation.accept);
  const rejectInvitation = useMutation(api.invitations.mutation.reject);
  const [processingId, setProcessingId] = useState<string | null>(null);

  const handleAccept = async (invitationId: string) => {
    try {
      setProcessingId(invitationId);
      await acceptInvitation({
        invitationId: invitationId as Parameters<
          typeof acceptInvitation
        >[0]["invitationId"],
      });
      showToast(t("invitations.accepted"), "success");
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : t("common.error"),
        "error",
      );
    } finally {
      setProcessingId(null);
    }
  };

  const handleReject = async (invitationId: string) => {
    try {
      setProcessingId(invitationId);
      await rejectInvitation({
        invitationId: invitationId as Parameters<
          typeof rejectInvitation
        >[0]["invitationId"],
      });
      showToast(t("invitations.rejected"), "success");
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : t("common.error"),
        "error",
      );
    } finally {
      setProcessingId(null);
    }
  };

  if (pendingInvitations === undefined) {
    return (
      <Layout>
        <div className={cn("flex items-center justify-center min-h-[60vh]")}>
          <LoadingIndicator />
        </div>
      </Layout>
    );
  }

  return (
    <>
      <Helmet>
        <title>{t("invitations.title")} - Gitdog</title>
      </Helmet>
      <Layout>
        <div className={cn("max-w-4xl mx-auto px-6 py-12")}>
          <h1
            className={cn(
              "text-3xl font-brand font-bold mb-8 text-black",
              "dark:text-white",
            )}
          >
            {t("invitations.title")}
          </h1>

          {pendingInvitations.length === 0 ? (
            <div
              className={cn(
                "p-12 text-center",
                "border border-gray-200 dark:border-gray-800",
                "bg-white dark:bg-[#0a0a0a]",
              )}
            >
              <p className={cn("text-gray-500 dark:text-gray-400")}>
                {t("invitations.noInvitations")}
              </p>
            </div>
          ) : (
            <div className={cn("space-y-4")}>
              {pendingInvitations.map((invitation) => (
                <div
                  key={invitation._id}
                  className={cn(
                    "p-6",
                    "border border-gray-200 dark:border-gray-800",
                    "bg-white dark:bg-[#0a0a0a]",
                  )}
                >
                  <div className={cn("flex items-start justify-between gap-4")}>
                    <div className={cn("flex-1")}>
                      <div className={cn("flex items-center gap-2 mb-2")}>
                        <SiGithub size={20} className="shrink-0" />
                        <span className={cn("font-bold text-lg")}>
                          {invitation.repository?.githubRepo}
                        </span>
                      </div>
                      {invitation.repository?.description && (
                        <p
                          className={cn(
                            "text-sm text-gray-600 dark:text-gray-400 mb-3",
                          )}
                        >
                          {invitation.repository.description}
                        </p>
                      )}
                      <p
                        className={cn(
                          "text-sm text-gray-500 dark:text-gray-400",
                        )}
                      >
                        {t("invitations.invitedBy", {
                          username: invitation.invitedByUsername,
                        })}{" "}
                        {t("invitations.asRole", {
                          role: t(`team.roles.${invitation.role}`),
                        })}
                      </p>
                    </div>
                    <div className={cn("flex items-center gap-2")}>
                      <button
                        onClick={() => handleReject(invitation._id)}
                        disabled={processingId === invitation._id}
                        className={cn(
                          "px-4 py-2",
                          "border border-gray-300 dark:border-gray-700",
                          "text-gray-700 dark:text-gray-300",
                          "hover:bg-gray-100 dark:hover:bg-gray-800",
                          "transition-colors",
                          "disabled:opacity-50 disabled:cursor-not-allowed",
                        )}
                      >
                        {t("invitations.reject")}
                      </button>
                      <button
                        onClick={() => handleAccept(invitation._id)}
                        disabled={processingId === invitation._id}
                        className={cn(
                          "px-4 py-2",
                          "bg-black text-white",
                          "hover:bg-gray-800",
                          "dark:bg-white dark:text-black dark:hover:bg-gray-200",
                          "transition-colors",
                          "disabled:opacity-50 disabled:cursor-not-allowed",
                        )}
                      >
                        {t("invitations.accept")}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Layout>
    </>
  );
}
