import React from "react";
import ReactDOM from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import App from "./App";
import "./index.css";
import "./utils/signals/theme";
import { getCanonicalOriginRedirect } from "./utils/canonicalOrigin";

const canonicalRedirect = getCanonicalOriginRedirect(window.location.href);

if (canonicalRedirect) {
  window.location.replace(canonicalRedirect);
} else {
  const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL!);
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ConvexAuthProvider client={convex}>
        <App />
      </ConvexAuthProvider>
    </React.StrictMode>,
  );
}
