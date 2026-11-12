import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { useTranslation } from "react-i18next";
import { api } from "../../convex/_generated/api";
import { Link, useNavigate, useLocation } from "react-router";
import { User, LogOut, Moon, Sun } from "lucide-react";
import { themeSignal, toggleTheme } from "../utils/signals/theme";
import { useSignals } from "@preact/signals-react/runtime";
import { cn } from "../utils/cn";

export function AdminLayout({ children }: { children: React.ReactNode }) {
  useSignals();
  const { t } = useTranslation();
  const location = useLocation();
  const { signOut } = useAuthActions();
  const currentUser = useQuery(api.users.query.getCurrentUser);
  const navigate = useNavigate();

  const handleSignOut = () => {
    void signOut();
    navigate("/");
  };

  return (
    <div
      className={cn(
        "flex flex-col",
        "min-h-screen",
        "bg-[#F5F5F5]",
        "transition-colors",
        "dark:bg-[#1a1a1a]",
      )}
    >
      {/* Header */}
      <header
        className={cn(
          "bg-white border-b border-gray-200",
          "dark:bg-[#0a0a0a] dark:border-gray-800",
        )}
      >
        <div
          className={cn(
            "flex items-center justify-between",
            "max-w-7xl mx-auto",
            "px-6 py-4",
          )}
        >
          <div className={cn("flex items-center gap-8")}>
            <Link to="/" className={cn("flex items-center gap-2")}>
              {/* Light mode: icon-bg.jpg, Dark mode: icon.png */}
              <img
                src="/icon-bg.jpg"
                alt="Gitdog"
                className={cn(
                  "w-8 h-8",
                  "border border-gray-200",
                  "dark:hidden",
                )}
              />
              <img
                src="/icon.png"
                alt="Gitdog"
                className={cn("w-8 h-8", "hidden dark:block")}
              />
              <span
                className={cn(
                  "text-xl font-bold text-black",
                  "dark:text-white",
                )}
              >
                Gitdog
              </span>
            </Link>
            {/* Admin Navigation */}
            <nav className={cn("flex gap-6")}>
              <Link
                to="/admin/workflows"
                className={cn(
                  "hover:text-black",
                  "dark:hover:text-white",
                  location.pathname === "/admin/workflows"
                    ? "text-black font-medium dark:text-white"
                    : "text-gray-500 dark:text-gray-400",
                )}
              >
                {t("admin.nav.workflows")}
              </Link>
              <Link
                to="/admin/payments"
                className={cn(
                  "hover:text-black",
                  "dark:hover:text-white",
                  location.pathname === "/admin/payments"
                    ? "text-black font-medium dark:text-white"
                    : "text-gray-500 dark:text-gray-400",
                )}
              >
                {t("admin.nav.payments")}
              </Link>
            </nav>
          </div>

          <div className={cn("flex items-center gap-4")}>
            <button
              onClick={toggleTheme}
              className={cn(
                "p-2",
                "text-gray-700",
                "transition-colors",
                "hover:text-black",
                "dark:text-gray-300 dark:hover:text-white",
              )}
              aria-label="Toggle theme"
            >
              {themeSignal.value === "dark" ? (
                <Sun size={20} />
              ) : (
                <Moon size={20} />
              )}
            </button>

            {currentUser && (
              <div className={cn("flex items-center gap-4")}>
                <Link
                  to="/profile"
                  className={cn(
                    "flex items-center gap-2",
                    "text-gray-700",
                    "hover:text-black",
                    "dark:text-gray-300 dark:hover:text-white",
                  )}
                >
                  <User size={20} className="shrink-0" />
                  <span>
                    {currentUser.profile?.displayName ||
                      currentUser.profile?.githubUsername ||
                      "Profile"}
                  </span>
                </Link>
                <button
                  onClick={handleSignOut}
                  className={cn(
                    "flex items-center gap-2",
                    "text-gray-700",
                    "hover:text-black",
                    "dark:text-gray-300 dark:hover:text-white",
                  )}
                  title="Sign out"
                >
                  <LogOut size={20} />
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className={cn("flex-1")}>{children}</main>

      {/* Footer */}
      <footer
        className={cn(
          "mt-auto",
          "bg-white border-t border-gray-200",
          "dark:bg-[#0a0a0a] dark:border-gray-800",
        )}
      >
        <div className={cn("max-w-7xl mx-auto", "px-6 py-6")}>
          <div
            className={cn(
              "flex flex-col gap-4",
              "sm:flex-row sm:items-center sm:justify-between",
            )}
          >
            <span className={cn("text-sm text-gray-600", "dark:text-gray-400")}>
              &copy; 2025 Gitdog. All rights reserved.
            </span>
            <div
              className={cn(
                "flex flex-wrap items-center gap-4",
                "text-sm text-gray-600",
                "dark:text-gray-400",
              )}
            >
              <Link
                to="/"
                className={cn("hover:text-black", "dark:hover:text-white")}
              >
                {t("admin.backToApp")}
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
