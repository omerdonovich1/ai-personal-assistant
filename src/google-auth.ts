import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { AddressInfo } from "net";
import { readFile, writeFile } from "fs/promises";
import { createServer } from "http";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const CREDENTIALS_PATH = join(ROOT, "credentials.json");
const TOKEN_PATH = join(ROOT, "token.json");

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];

interface InstalledCredentials {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
}

let _cachedClient: OAuth2Client | null = null;

async function bootstrapFromEnv(): Promise<void> {
  const credEnv = process.env.GOOGLE_CREDENTIALS_JSON;
  if (credEnv) {
    try { await readFile(CREDENTIALS_PATH, "utf-8"); } catch { await writeFile(CREDENTIALS_PATH, credEnv); }
  }
  const tokenEnv = process.env.GOOGLE_TOKEN_JSON;
  if (tokenEnv) {
    try { await readFile(TOKEN_PATH, "utf-8"); } catch { await writeFile(TOKEN_PATH, tokenEnv); }
  }
}

export async function getAuthClient(): Promise<OAuth2Client> {
  if (_cachedClient) return _cachedClient;

  await bootstrapFromEnv();

  let raw: string;
  try {
    raw = await readFile(CREDENTIALS_PATH, "utf-8");
  } catch {
    throw new Error(
      `credentials.json not found at ${CREDENTIALS_PATH}.\n` +
        "Download a Desktop OAuth2 client JSON from Google Cloud Console and place it there."
    );
  }

  const parsed = JSON.parse(raw) as { installed?: InstalledCredentials; web?: InstalledCredentials };
  const creds = parsed.installed ?? parsed.web;
  if (!creds) throw new Error("credentials.json has no 'installed' or 'web' key.");

  const { client_id, client_secret } = creds;

  // We'll assign the real redirect URI after the server binds to a free port.
  // Pass a placeholder — it's overridden in runAuthFlow before any API call.
  const client = new google.auth.OAuth2(client_id, client_secret) as OAuth2Client;

  // Persist token refreshes to disk automatically
  client.on("tokens", async (tokens) => {
    const merged = { ...client.credentials, ...tokens };
    await writeFile(TOKEN_PATH, JSON.stringify(merged, null, 2));
  });

  // Try loading a saved token
  try {
    const tokenRaw = await readFile(TOKEN_PATH, "utf-8");
    client.setCredentials(JSON.parse(tokenRaw));
    _cachedClient = client;
    return client;
  } catch {
    // No token yet — run the interactive flow
  }

  await runAuthFlow(client, client_id, client_secret);
  _cachedClient = client;
  return client;
}

async function runAuthFlow(
  client: OAuth2Client,
  clientId: string,
  clientSecret: string
): Promise<void> {
  // Bind on port 0 so the OS picks a free port — no more EADDRINUSE
  const { code, port } = await captureCodeViaLocalServer(clientId, clientSecret);

  // Exchange with the redirect URI that matches what we advertised in the auth URL
  const redirectUri = `http://localhost:${port}`;
  const exchangeClient = new google.auth.OAuth2(clientId, clientSecret, redirectUri) as OAuth2Client;
  const { tokens } = await exchangeClient.getToken(code);

  client.setCredentials(tokens);
  await writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2));

  console.error("✓ Authentication successful — token saved to token.json\n");
}

function captureCodeViaLocalServer(
  clientId: string,
  clientSecret: string
): Promise<{ code: string; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (code) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<html><body style='font-family:sans-serif;padding:2rem'>" +
            "<h2>✓ Authentication successful!</h2>" +
            "<p>You can close this tab and return to your terminal.</p>" +
            "</body></html>"
        );
        // Capture port from closure BEFORE closing the server (address() returns null after close)
        const port = boundPort;
        server.close();
        resolve({ code, port });
      } else {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<html><body><h2>Authentication failed: ${error ?? "unknown"}</h2></body></html>`);
        server.close();
        reject(new Error(`OAuth2 error: ${error ?? "unknown"}`));
      }
    });

    // port 0 = OS picks any free port
    // Capture the port in the listen callback so it's available in the request handler closure
    let boundPort: number;
    server.listen(0, () => {
      boundPort = (server.address() as AddressInfo).port;
      const redirectUri = `http://localhost:${boundPort}`;

      // Temporary client just for generating the auth URL with the correct redirect
      const tempClient = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
      const authUrl = tempClient.generateAuthUrl({
        access_type: "offline",
        scope: SCOPES,
        prompt: "consent",
      });

      console.error("\n╔══════════════════════════════════════════════════════════════╗");
      console.error("║          Google OAuth2 — First-time Authentication           ║");
      console.error("╚══════════════════════════════════════════════════════════════╝");
      console.error("\nOpen this URL in your browser:\n");
      console.error(authUrl);
      console.error(`\nWaiting for redirect on http://localhost:${boundPort} ...\n`);
    });

    server.on("error", reject);

    setTimeout(() => {
      server.close();
      reject(new Error("OAuth2 flow timed out after 5 minutes. Re-invoke the tool to retry."));
    }, 5 * 60 * 1000);
  });
}
