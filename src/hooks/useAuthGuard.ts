import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export function useAuthGuard() {
  const currentUser = useQuery(api.users.query.getCurrentUser);

  const requireAuth = (action: () => void, message?: string) => {
    if (!currentUser) {
      const shouldSignIn = confirm(
        message || "You need to sign in to perform this action. Sign in now?",
      );
      if (shouldSignIn) {
        window.location.assign("/legal/consent");
      }
      return;
    }
    action();
  };

  const isAuthenticated = currentUser !== null && currentUser !== undefined;

  return {
    requireAuth,
    isAuthenticated,
    currentUser,
  };
}
