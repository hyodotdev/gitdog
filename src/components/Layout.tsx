import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery, useAction, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Link, useNavigate, useLocation } from "react-router";
import { User, LogOut, Moon, Sun, Languages } from "lucide-react";
import { themeSignal, toggleTheme } from "../utils/signals/theme";
import { useSignals } from "@preact/signals-react/runtime";
import { useEffect, useState } from "react";
import { SiGithub } from "@icons-pack/react-simple-icons";
import { useTranslation } from "react-i18next";
import { cn } from "../utils/cn";
import { Button } from "./uis/Button";
import { NotificationBell } from "./uis/NotificationBell";
import { ProviderKeyAlert } from "./ProviderKeyAlert";

export function Layout({ children }: { children: React.ReactNode }) {
  useSignals();
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const { signOut } = useAuthActions();
  const currentUser = useQuery(api.users.query.getCurrentUser);
  const repositories = useQuery(api.repositories.query.list);
  const hasConnectedRepositories = repositories && repositories.length > 0;
  const navigate = useNavigate();
  const ensureProfile = useAction(api.users.action.ensureProfile);
  const [showLangMenu, setShowLangMenu] = useState(false);

  const toggleLanguage = (lang: string) => {
    void i18n.changeLanguage(lang);
    setShowLangMenu(false);
  };

  // Ensure profile exists after login
  useEffect(() => {
    if (currentUser && !currentUser.profile) {
      void ensureProfile();
    }
  }, [currentUser, ensureProfile]);

  // Grant the one-time trial credit; the server ignores repeat claims.
  const claimTrialCredit = useMutation(
    api.subscriptions.mutation.claimTrialCredit,
  );
  const signedInUserId = currentUser?._id;
  useEffect(() => {
    if (signedInUserId) void claimTrialCredit({}).catch(() => undefined);
  }, [signedInUserId, claimTrialCredit]);

  const navItems = currentUser
    ? [
        { to: "/", label: t("nav.workspace") },
        { to: "/tickets", label: t("nav.tickets") },
        { to: "/usage", label: t("nav.usage") },
      ]
    : currentUser === null
      ? [{ to: "/pricing", label: t("nav.pricing") }]
      : [];

  const handleSignOut = () => {
    void signOut();
    navigate("/");
  };

  return (
    <div
      className={cn(
        // Display & Flex
        "flex flex-col",
        // Sizing
        "min-h-screen",
        // Background
        "bg-[#F5F5F5]",
        // Transitions
        "transition-colors",
        // Dark mode
        "dark:bg-[#1a1a1a]",
      )}
    >
      <a
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main")?.focus();
        }}
        className={cn(
          "sr-only",
          "focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50",
          "focus:bg-black focus:px-4 focus:py-2 focus:text-white",
          "dark:focus:bg-white dark:focus:text-black",
        )}
      >
        {t("nav.skipToContent")}
      </a>

      {/* Header */}
      <header
        className={cn(
          // Background & Border
          "bg-white border-b border-gray-200",
          // Dark mode
          "dark:bg-[#0a0a0a] dark:border-gray-800",
        )}
      >
        <div
          className={cn(
            // Display & Flex
            "flex flex-wrap items-center justify-between gap-x-2 gap-y-2 md:gap-x-8",
            // Sizing
            "max-w-7xl mx-auto",
            // Spacing
            "px-4 py-3 sm:px-6 sm:py-4",
          )}
        >
          <Link to="/" className={cn("flex items-center gap-2")}>
            {/* Light mode: icon-bg.jpg, Dark mode: icon.png */}
            <img
              src="/icon-bg.jpg"
              alt=""
              width={32}
              height={32}
              className={cn("w-8 h-8", "border border-gray-200", "dark:hidden")}
            />
            <img
              src="/icon.png"
              alt=""
              width={32}
              height={32}
              className={cn("w-8 h-8", "hidden dark:block")}
            />
            <span
              className={cn("text-xl font-bold text-black", "dark:text-white")}
            >
              Gitdog
            </span>
          </Link>
          {navItems.length > 0 && (
            <nav
              className={cn(
                "order-last flex w-full gap-6",
                "md:order-none md:mr-auto md:w-auto",
              )}
            >
              {navItems.map((item) => {
                const isActive =
                  item.to === "/"
                    ? location.pathname === "/"
                    : location.pathname === item.to ||
                      location.pathname.startsWith(`${item.to}/`);
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "hover:text-black",
                      "dark:hover:text-white",
                      isActive
                        ? "text-black font-medium dark:text-white"
                        : "text-gray-500 dark:text-gray-400",
                    )}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          )}

          <div className={cn("ml-auto flex items-center gap-2 sm:gap-4")}>
            {/* Language Switcher - Only in development */}
            {import.meta.env.DEV && (
              <div className={cn("relative")}>
                <button
                  onClick={() => setShowLangMenu(!showLangMenu)}
                  className={cn(
                    // Spacing
                    "p-2",
                    // Typography
                    "text-gray-700",
                    // Transitions
                    "transition-colors",
                    // State
                    "hover:text-black",
                    // Dark mode
                    "dark:text-gray-300 dark:hover:text-white",
                  )}
                  aria-label={t("nav.ariaLabels.changeLanguage")}
                  aria-expanded={showLangMenu}
                >
                  <Languages size={20} />
                </button>
                {showLangMenu && (
                  <div
                    className={cn(
                      // Layout
                      "absolute right-0 z-50",
                      // Sizing
                      "w-32",
                      // Spacing
                      "mt-2",
                      // Background & Border
                      "bg-white border border-gray-200",
                      // Effects
                      "shadow-lg",
                      // Dark mode
                      "dark:bg-[#0a0a0a] dark:border-gray-800",
                    )}
                  >
                    <button
                      onClick={() => toggleLanguage("en")}
                      className={cn(
                        // Sizing
                        "w-full",
                        // Spacing
                        "px-4 py-2",
                        // Typography
                        "text-left text-sm text-gray-700",
                        // State
                        "hover:bg-gray-100",
                        i18n.language === "en" &&
                          "bg-gray-100 font-medium dark:bg-gray-900",
                        // Dark mode
                        "dark:text-gray-200 dark:hover:bg-gray-900",
                      )}
                    >
                      English
                    </button>
                    <button
                      onClick={() => toggleLanguage("ko")}
                      className={cn(
                        // Sizing
                        "w-full",
                        // Spacing
                        "px-4 py-2",
                        // Typography
                        "text-left text-sm text-gray-700",
                        // State
                        "hover:bg-gray-100",
                        i18n.language === "ko" &&
                          "bg-gray-100 font-medium dark:bg-gray-900",
                        // Dark mode
                        "dark:text-gray-200 dark:hover:bg-gray-900",
                      )}
                    >
                      한국어
                    </button>
                    <button
                      onClick={() => toggleLanguage("ja")}
                      className={cn(
                        // Sizing
                        "w-full",
                        // Spacing
                        "px-4 py-2",
                        // Typography
                        "text-left text-sm text-gray-700",
                        // State
                        "hover:bg-gray-100",
                        i18n.language === "ja" &&
                          "bg-gray-100 font-medium dark:bg-gray-900",
                        // Dark mode
                        "dark:text-gray-200 dark:hover:bg-gray-900",
                      )}
                    >
                      日本語
                    </button>
                  </div>
                )}
              </div>
            )}

            <button
              onClick={toggleTheme}
              className={cn(
                // Spacing
                "p-2",
                // Typography
                "text-gray-700",
                // Transitions
                "transition-colors",
                // State
                "hover:text-black",
                // Dark mode
                "dark:text-gray-300 dark:hover:text-white",
              )}
              aria-label={t("nav.ariaLabels.toggleTheme")}
            >
              {themeSignal.value === "dark" ? (
                <Sun size={20} />
              ) : (
                <Moon size={20} />
              )}
            </button>

            {currentUser === undefined ? (
              <div
                className={cn(
                  // Sizing
                  "w-32 h-10",
                  // Background
                  "bg-gray-200",
                  // Animation
                  "animate-pulse",
                  // Dark mode
                  "dark:bg-[#2a2a2a]",
                )}
              />
            ) : currentUser ? (
              <div className={cn("flex items-center gap-4")}>
                <NotificationBell />
                <Link
                  to="/profile"
                  className={cn(
                    // Display & Flex
                    "flex items-center gap-2",
                    // Typography
                    "text-gray-700",
                    // State
                    "hover:text-black",
                    // Dark mode
                    "dark:text-gray-300 dark:hover:text-white",
                  )}
                >
                  <User size={20} aria-hidden="true" />
                  <span className={cn("sr-only sm:not-sr-only")}>
                    {currentUser.profile?.displayName ||
                      currentUser.profile?.githubUsername ||
                      t("nav.profile")}
                  </span>
                </Link>
                <button
                  onClick={handleSignOut}
                  className={cn(
                    // Display & Flex
                    "flex items-center gap-2",
                    // Typography
                    "text-gray-700",
                    // State
                    "hover:text-black",
                    // Dark mode
                    "dark:text-gray-300 dark:hover:text-white",
                  )}
                  title={t("nav.signOut")}
                  aria-label={t("nav.signOut")}
                >
                  <LogOut size={20} aria-hidden="true" />
                </button>
              </div>
            ) : (
              <Button
                variant="auth"
                onClick={() => navigate("/legal/consent")}
                icon={<SiGithub size={20} />}
                className={cn("whitespace-nowrap px-3 text-sm sm:px-4")}
              >
                {t("auth.signInWithGitHub")}
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* Repository Connection Prompt for Authenticated Users */}
      {currentUser && hasConnectedRepositories === false && (
        <div
          className={cn(
            // Spacing
            "py-3",
            // Typography & Background
            "bg-black text-white",
            // Dark mode
            "dark:bg-white dark:text-black",
          )}
        >
          <div
            className={cn(
              // Display & Flex
              "flex flex-wrap items-center justify-between gap-x-4 gap-y-1",
              // Sizing
              "max-w-7xl mx-auto",
              // Spacing
              "px-4 sm:px-6",
            )}
          >
            <p className={cn("text-sm")}>{t("banner.connectPrompt")}</p>
            <button
              onClick={() => navigate("/repositories/connect")}
              className={cn(
                // Typography
                "text-sm font-medium underline",
                // State
                "hover:no-underline",
              )}
            >
              {t("banner.connectNow")}
            </button>
          </div>
        </div>
      )}

      {currentUser && <ProviderKeyAlert />}

      {/* Main Content */}
      <main id="main" tabIndex={-1} className={cn("flex-1 outline-hidden")}>
        {children}
      </main>

      {/* Footer */}
      <footer
        className={cn(
          // Spacing
          "mt-auto",
          // Background & Border
          "bg-white border-t border-gray-200",
          // Dark mode
          "dark:bg-[#0a0a0a] dark:border-gray-800",
        )}
      >
        <div
          className={cn(
            // Sizing
            "max-w-7xl mx-auto",
            // Spacing
            "px-4 py-6 sm:px-6",
          )}
        >
          <div
            className={cn(
              "flex flex-col gap-4",
              "sm:flex-row sm:items-center sm:justify-between",
            )}
          >
            {/* Copyright */}
            <span className={cn("text-sm text-gray-600", "dark:text-gray-400")}>
              {t("footer.copyright", { year: new Date().getFullYear() })}
            </span>

            {/* Links */}
            <div
              className={cn(
                "flex flex-wrap items-center gap-4",
                "text-sm text-gray-600",
                "dark:text-gray-400",
              )}
            >
              <Link
                to="/pricing"
                className={cn("hover:text-black", "dark:hover:text-white")}
              >
                {t("footer.pricing")}
              </Link>
              <Link
                to="/about"
                className={cn("hover:text-black", "dark:hover:text-white")}
              >
                {t("footer.about")}
              </Link>
              <Link
                to="/legal/terms-of-service"
                className={cn("hover:text-black", "dark:hover:text-white")}
              >
                {t("footer.termsOfService")}
              </Link>
              <Link
                to="/legal/privacy-policy"
                className={cn("hover:text-black", "dark:hover:text-white")}
              >
                {t("footer.privacyPolicy")}
              </Link>
              <Link
                to="/contact"
                className={cn("hover:text-black", "dark:hover:text-white")}
              >
                {t("footer.contact")}
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
