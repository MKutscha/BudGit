import { defineConfig } from "vitest/config";

// Eigene Test-Konfiguration: Node hat kein IndexedDB, daher der In-Memory-Ersatz.
export default defineConfig({
  test: { setupFiles: ["tests/setup.ts"] },
});
