import { Component, lazy, Suspense, useEffect, type ReactNode } from "react";
import { useQuery } from "convex/react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
} from "react-router";
import { HelmetProvider } from "react-helmet-async";
import { useTranslation } from "react-i18next";
import { ErrorPage } from "./pages/error";
import "./i18n";
import { api } from "../convex/_generated/api";
import { LoadingIndicator } from "./components/uis/LoadingIndicator";
import { ToastContainer } from "./components/uis/Toast";
import { cn } from "./utils/cn";
import {
  createLegalConsentUrl,
  isLegalConsentExemptPath,
  shouldShowLegalConsentLoadingState,
} from "./utils/legalConsent";

const HomePage = lazy(async () => ({
  default: (await import("./pages/home")).HomePage,
}));
const RepositoryConnect = lazy(async () => ({
  default: (await import("./pages/repositories/connect")).RepositoryConnect,
}));
const RepositorySettingsPage = lazy(async () => ({
  default: (await import("./pages/repositories/[owner]/[repo]"))
    .RepositorySettingsPage,
}));
const ProfilePage = lazy(async () => ({
  default: (await import("./pages/profile")).ProfilePage,
}));
const UsagePage = lazy(async () => ({
  default: (await import("./pages/usage")).UsagePage,
}));
const PricingPage = lazy(async () => ({
  default: (await import("./pages/pricing")).PricingPage,
}));
const ContactPage = lazy(async () => ({
  default: (await import("./pages/contact")).ContactPage,
}));
const AboutPage = lazy(async () => ({
  default: (await import("./pages/about")).AboutPage,
}));
const TermsOfServicePage = lazy(async () => ({
  default: (await import("./pages/legal/terms-of-service")).TermsOfServicePage,
}));
const PrivacyPolicyPage = lazy(async () => ({
  default: (await import("./pages/legal/privacy-policy")).PrivacyPolicyPage,
}));
const LegalConsentPage = lazy(async () => ({
  default: (await import("./pages/legal/consent")).LegalConsentPage,
}));
const CliLoginPage = lazy(async () => ({
  default: (await import("./pages/cli/login")).CliLoginPage,
}));
const NotFoundPage = lazy(async () => ({
  default: (await import("./pages/not-found")).NotFoundPage,
}));
const TicketsPage = lazy(async () => ({
  default: (await import("./pages/tickets")).TicketsPage,
}));
const TicketDetailPage = lazy(async () => ({
  default: (await import("./pages/tickets/[id]")).TicketDetailPage,
}));
const AdminWorkflowsPage = lazy(async () => ({
  default: (await import("./pages/admin/workflows")).AdminWorkflowsPage,
}));
const AdminPaymentsPage = lazy(async () => ({
  default: (await import("./pages/admin/payments")).AdminPaymentsPage,
}));
const InvitationsPage = lazy(async () => ({
  default: (await import("./pages/invitations")).InvitationsPage,
}));

function FullScreenLoading() {
  return (
    <div
      className={cn(
        "flex items-center justify-center min-h-screen",
        "bg-[#F5F5F5] dark:bg-[#1a1a1a]",
      )}
    >
      <LoadingIndicator />
    </div>
  );
}

class AppErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    return this.state.hasError ? <ErrorPage /> : this.props.children;
  }
}

function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <AppErrorBoundary key={location.key}>{children}</AppErrorBoundary>;
}

function DocumentLanguage() {
  const { i18n } = useTranslation();

  useEffect(() => {
    document.documentElement.lang = (
      i18n.resolvedLanguage ??
      i18n.language ??
      "en"
    ).split("-")[0];
  }, [i18n.language, i18n.resolvedLanguage]);

  return null;
}

function isAuthenticationRequired(pathname: string): boolean {
  return [
    "/repositories",
    "/tickets",
    "/profile",
    "/usage",
    "/invitations",
    "/admin",
  ].some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

// Scroll to top on route change
function ScrollToTop() {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return null;
}

function AppContent() {
  const currentUser = useQuery(api.users.query.getCurrentUser);
  const location = useLocation();
  const isLegalConsentExempt = isLegalConsentExemptPath(location.pathname);

  if (shouldShowLegalConsentLoadingState(location.pathname, currentUser)) {
    return (
      <div
        className={cn(
          "flex items-center justify-center min-h-screen",
          "bg-[#F5F5F5]",
          "dark:bg-[#1a1a1a]",
        )}
      >
        <LoadingIndicator />
      </div>
    );
  }

  if (
    currentUser &&
    currentUser.requiresCurrentLegalAttestation &&
    !isLegalConsentExempt
  ) {
    const returnPath = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={createLegalConsentUrl(returnPath)} replace />;
  }

  if (currentUser === null && isAuthenticationRequired(location.pathname)) {
    const returnPath = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={createLegalConsentUrl(returnPath)} replace />;
  }

  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/repositories/connect" element={<RepositoryConnect />} />
      <Route path="/projects/connect" element={<RepositoryConnect />} />
      <Route
        path="/repositories/:owner/:repo"
        element={<RepositorySettingsPage />}
      />
      <Route path="/usage" element={<UsagePage />} />
      <Route path="/pricing" element={<PricingPage />} />
      <Route path="/tickets" element={<TicketsPage />} />
      <Route path="/tickets/:id" element={<TicketDetailPage />} />
      <Route path="/profile" element={<ProfilePage />} />
      <Route path="/invitations" element={<InvitationsPage />} />
      {/* Admin pages - shows 404 for non-admins */}
      <Route
        path="/admin"
        element={<Navigate to="/admin/workflows" replace />}
      />
      <Route path="/admin/workflows" element={<AdminWorkflowsPage />} />
      <Route path="/admin/payments" element={<AdminPaymentsPage />} />
      {/* Public pages */}
      <Route path="/contact" element={<ContactPage />} />
      <Route path="/about" element={<AboutPage />} />
      <Route path="/legal/terms-of-service" element={<TermsOfServicePage />} />
      <Route path="/legal/privacy-policy" element={<PrivacyPolicyPage />} />
      <Route path="/legal/consent" element={<LegalConsentPage />} />
      <Route path="/cli/login" element={<CliLoginPage />} />
      {/* 404 - Catch all */}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

function App() {
  return (
    <HelmetProvider>
      <BrowserRouter>
        <ScrollToTop />
        <DocumentLanguage />
        <Suspense fallback={<FullScreenLoading />}>
          <RouteErrorBoundary>
            <AppContent />
          </RouteErrorBoundary>
        </Suspense>
        <ToastContainer />
      </BrowserRouter>
    </HelmetProvider>
  );
}

export default App;
