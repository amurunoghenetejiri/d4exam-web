import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const stubDir = path.join(rootDir, "scripts", ".cap-stubs");
const pathsFile = path.join(stubDir, "paths.json");

/** Read KEY=VALUE from .env without depending on dotenv. */
function readDotEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return out;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function loadStubPaths() {
  if (fs.existsSync(pathsFile)) {
    return JSON.parse(fs.readFileSync(pathsFile, "utf8")) as {
      stubFile: string;
      nodeStub: string;
    };
  }
  return {
    stubFile: path.join(stubDir, "server-shim.js"),
    nodeStub: path.join(stubDir, "node-shim.js"),
  };
}

function capacitorAliases(): Plugin {
  const { stubFile, nodeStub } = loadStubPaths();

  function shouldStub(id: string): string | null {
    if (!id) return null;
    if (id.startsWith("node:")) return nodeStub;
    if (id === "#tanstack-start-entry" || id === "#tanstack-router-entry") return stubFile;
    if (id.includes("tanstack-start-entry")) return stubFile;
    if (id.includes("@tanstack/start-server-core")) return stubFile;
    if (id.includes("@tanstack/start-storage-context")) return stubFile;
    if (id.includes("@tanstack/react-start/server")) return stubFile;
    if (id.includes("start-server-functions")) return stubFile;
    const cleaned = id.split("?")[0];
    if (/\.server(\.[cm]?[jt]sx?)?$/.test(cleaned)) return stubFile;
    if (/\.functions(\.[cm]?[jt]sx?)?$/.test(cleaned)) return stubFile;
    if (cleaned.endsWith("/server.ts") || cleaned.endsWith("/server.js")) return stubFile;
    if (cleaned.includes("push-send.functions")) return stubFile;
    if (cleaned.includes("student.server")) return stubFile;
    if (cleaned.includes("auth.functions")) return stubFile;
    return null;
  }

  return {
    name: "capacitor-alias-stubs",
    enforce: "pre",
    resolveId(id) {
      const target = shouldStub(id);
      if (target && fs.existsSync(target)) return target;
      if (id.startsWith("@/") && (id.includes(".server") || id.includes(".functions"))) {
        if (fs.existsSync(stubFile)) return stubFile;
      }
      return null;
    },
  };
}

export default defineConfig(({ mode }) => {
  // Merge: process.env (CI secrets) > Vite loadEnv > committed .env file
  const fromVite = loadEnv(mode, rootDir, "");
  const fromFile = readDotEnvFile(path.join(rootDir, ".env"));

  const supabaseUrl =
    process.env.VITE_SUPABASE_URL ||
    fromVite.VITE_SUPABASE_URL ||
    fromFile.VITE_SUPABASE_URL ||
    fromFile.SUPABASE_URL ||
    "";
  const publishable =
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    fromVite.VITE_SUPABASE_PUBLISHABLE_KEY ||
    fromFile.VITE_SUPABASE_PUBLISHABLE_KEY ||
    fromFile.SUPABASE_PUBLISHABLE_KEY ||
    "";
  const anon =
    process.env.VITE_SUPABASE_ANON_KEY ||
    fromVite.VITE_SUPABASE_ANON_KEY ||
    fromFile.VITE_SUPABASE_ANON_KEY ||
    fromFile.SUPABASE_ANON_KEY ||
    publishable;
  const projectId =
    process.env.VITE_SUPABASE_PROJECT_ID ||
    fromVite.VITE_SUPABASE_PROJECT_ID ||
    fromFile.VITE_SUPABASE_PROJECT_ID ||
    fromFile.SUPABASE_PROJECT_ID ||
    "";

  if (!supabaseUrl || !(publishable || anon)) {
    console.error(
      "[vite.capacitor] FATAL: missing VITE_SUPABASE_URL or publishable/anon key. Login will fail in APK.",
    );
  } else {
    console.log(
      "[vite.capacitor] Supabase URL baked:",
      supabaseUrl,
      "project:",
      projectId || "(unknown)",
    );
  }

  const clientKey = publishable || anon;

  return {
    base: "./",
    root: rootDir,
    envDir: rootDir,
    plugins: [capacitorAliases(), react(), tailwindcss(), tsconfigPaths()],
    resolve: {
      alias: {
        "@": path.resolve(rootDir, "src"),
      },
      conditions: ["import", "module", "browser", "default"],
      mainFields: ["browser", "module", "main"],
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "import.meta.env.SSR": "false",
      "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(supabaseUrl),
      "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(clientKey),
      "import.meta.env.VITE_SUPABASE_ANON_KEY": JSON.stringify(anon || clientKey),
      "import.meta.env.VITE_SUPABASE_PROJECT_ID": JSON.stringify(projectId),
    },
    build: {
      outDir: "dist-capacitor",
      emptyOutDir: true,
      sourcemap: false,
      cssCodeSplit: false,
      target: "es2020",
      commonjsOptions: { transformMixedEsModules: true },
      rollupOptions: {
        input: path.resolve(rootDir, "src/capacitor-main.tsx"),
        output: {
          entryFileNames: "capacitor-app.js",
          chunkFileNames: "cap-[name]-[hash].js",
          assetFileNames: "cap-[name]-[hash][extname]",
        },
        onwarn(warning, warn) {
          if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
          if (String(warning.message || "").includes("externalized for browser")) return;
          warn(warning);
        },
      },
    },
    optimizeDeps: {
      include: ["react", "react-dom", "@tanstack/react-router", "@tanstack/react-query"],
    },
  };
});
