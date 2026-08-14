import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./app.css";
// §5 (2026-08-14 amendment): the adjudicated PACKAGE's own CSS, unmodified — declares
// "JetBrains Mono Variable" (--font-data, tokens.css) across every subset it ships.
import "@fontsource-variable/jetbrains-mono/index.css";

// Polling owns freshness (§2), so the window-focus refetch would only add duplicate
// requests on top of the 3 s tick.
const client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
