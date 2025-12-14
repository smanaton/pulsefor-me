import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import net from "node:net";

const args = new Set(process.argv.slice(2));
const shouldWrite = args.has("--write") || args.has("--setup");
const shouldSyncConvex = args.has("--sync-convex") || args.has("--setup");
const shouldApply = args.has("--apply");

const envLocalPath = path.resolve(process.cwd(), ".env.local");
const localConvexBin = path.resolve(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "convex.cmd" : "convex"
);

const isEnvAssignmentLine = (line) =>
  /^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(line);

const upsertEnvVars = (existing, updates) => {
  const lines = existing.length ? existing.split(/\r?\n/) : [];
  const out = [];
  const remaining = new Set(Object.keys(updates));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!m) {
      out.push(line);
      continue;
    }

    const key = m[1];
    if (!(key in updates)) {
      out.push(line);
      continue;
    }

    out.push(`${key}=${updates[key]}`);
    remaining.delete(key);

    // If this key previously had a multi-line value (common mistake with PEM)
    // skip subsequent non-assignment lines.
    while (i + 1 < lines.length && lines[i + 1] && !isEnvAssignmentLine(lines[i + 1])) {
      i++;
    }
  }

  if (out.length && out[out.length - 1] !== "") {
    out.push("");
  }

  for (const key of remaining) {
    out.push(`${key}=${updates[key]}`);
  }

  out.push("");
  return out.join("\n");
};

const readEnvLocal = () => {
  try {
    return fs.readFileSync(envLocalPath, "utf8");
  } catch {
    return "";
  }
};

const isTcpReachable = (host, port, timeoutMs = 500) =>
  new Promise((resolve) => {
    const socket = new net.Socket();
    const onDone = (ok) => {
      try {
        socket.destroy();
      } catch {}
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => onDone(true));
    socket.once("timeout", () => onDone(false));
    socket.once("error", () => onDone(false));
    socket.connect(port, host);
  });

const getEnvVarFromEnvLocal = (content, key) => {
  const re = new RegExp(`^\\s*${key}=([^\\n\\r]*)`, "m");
  const m = content.match(re);
  if (!m) return null;
  let value = m[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  value = value.replace(/\\n/g, "\n");
  return value;
};

const keys = await generateKeyPair("RS256", { extractable: true });
const privateKey = await exportPKCS8(keys.privateKey);
const publicKey = await exportJWK(keys.publicKey);
const jwks = JSON.stringify({ keys: [{ use: "sig", ...publicKey }] });

const authSecret = crypto.randomBytes(32).toString("base64");
const adapterSecret = crypto.randomBytes(32).toString("hex");

const updates = {
  AUTH_SECRET: JSON.stringify(authSecret),
  CONVEX_AUTH_PRIVATE_KEY: JSON.stringify(privateKey),
  JWKS: JSON.stringify(jwks),
  CONVEX_AUTH_ADAPTER_SECRET: JSON.stringify(adapterSecret),
};

if (shouldWrite) {
  const existing = readEnvLocal();
  const next = upsertEnvVars(existing, updates);
  fs.writeFileSync(envLocalPath, next, "utf8");
  process.stdout.write(`Wrote auth values to ${envLocalPath}\n`);
} else if (!shouldSyncConvex) {
  process.stdout.write(`AUTH_SECRET=${updates.AUTH_SECRET}\n`);
  process.stdout.write(`CONVEX_AUTH_PRIVATE_KEY=${updates.CONVEX_AUTH_PRIVATE_KEY}\n`);
  process.stdout.write(`JWKS=${updates.JWKS}\n`);
  process.stdout.write(`CONVEX_AUTH_ADAPTER_SECRET=${updates.CONVEX_AUTH_ADAPTER_SECRET}\n`);
}

if (shouldSyncConvex) {
  const content = readEnvLocal();
  const convexUrl = getEnvVarFromEnvLocal(content, "NEXT_PUBLIC_CONVEX_URL");
  if (convexUrl) {
    try {
      const u = new URL(convexUrl);
      const host = u.hostname;
      const port = Number(u.port);
      if (host && Number.isFinite(port) && port > 0) {
        const ok = await isTcpReachable(host, port);
        if (!ok) {
          process.stderr.write(
            `Convex backend isn't reachable at ${convexUrl}. Start \`pnpm dev:all\` (or \`npx convex dev\`) and try again.\n`
          );
          process.exit(1);
        }
      }
    } catch {
      // ignore invalid URL
    }
  }

  const convexVars = [
    "CONVEX_AUTH_ADAPTER_SECRET",
    "OPENAI_API_KEY",
    "AI_BASE_URL",
    "AI_CHAT_MODEL",
    "AI_EMBEDDING_MODEL",
    "JWKS",
    "CONVEX_AUTH_PRIVATE_KEY",
    "AUTH_SECRET",
  ];
  const toSet = [];

  if (convexUrl && typeof convexUrl === "string") {
    const siteUrl = convexUrl.replace(/\.cloud$/, ".site");
    if (siteUrl !== convexUrl) {
      toSet.push(["CONVEX_SITE_URL", siteUrl]);
    }
  }

  for (const key of convexVars) {
    const v = getEnvVarFromEnvLocal(content, key);
    if (v !== null && v !== "") {
      toSet.push([key, v]);
    }
  }

  if (!toSet.length) {
    process.stdout.write("No Convex env vars found in .env.local to sync.\n");
  } else if (!shouldApply) {
    process.stdout.write("Convex env sync (dry-run). Run with --apply to execute:\n");
    for (const [key] of toSet) {
      process.stdout.write(`- ${key}\n`);
    }
  } else {
    for (const [key, value] of toSet) {
      const hasLocalConvexBin = fs.existsSync(localConvexBin);
      const bin = hasLocalConvexBin
        ? localConvexBin
        : process.platform === "win32"
          ? "npx.cmd"
          : "npx";
      const argv = hasLocalConvexBin
        ? ["env", "set", key, value]
        : ["convex", "env", "set", key, value];
      const r = spawnSync(
        bin,
        argv,
        {
          encoding: "utf8",
          shell: process.platform === "win32" && bin.toLowerCase().endsWith(".cmd"),
        }
      );
      if (r.error) {
        process.stderr.write(
          `Failed to run Convex CLI while setting ${key}: ${r.error.message}\n`
        );
        process.exit(1);
      }
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      if (r.status !== 0) {
        process.stderr.write(
          `Failed to set Convex env var ${key} (exit code ${r.status ?? "unknown"}).\n`
        );
        process.exit(r.status ?? 1);
      }
    }
  }
}
