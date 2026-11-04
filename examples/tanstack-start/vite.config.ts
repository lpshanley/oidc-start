import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { checkClientBundle } from "./check-client-bundle.ts";

export default defineConfig({
	plugins: [tanstackStart(), react(), checkClientBundle()],
});
