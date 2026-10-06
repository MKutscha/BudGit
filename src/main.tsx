import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/public-sans";
import "./styles.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if (import.meta.env.VITE_TARGET === "web") {
  // Nur im Web-Build: Service Worker (Update erst nach Tipp) und Eingaben-Rettung.
  void import("./webboot").then(m => m.boot());
}
