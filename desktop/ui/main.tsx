import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles.css";
import App from "./App";

const container = document.getElementById("root");
if (!container) throw new Error("The REA Workspace root element is missing.");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
