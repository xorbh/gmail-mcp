import { google, gmail_v1 } from "googleapis";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_DIR = path.join(__dirname, "..");

export function getConfigDir(): string {
  const idx = process.argv.indexOf("--config-dir");
  if (idx !== -1 && process.argv[idx + 1]) {
    return path.resolve(process.argv[idx + 1]);
  }
  return DEFAULT_CONFIG_DIR;
}

export function getGmailClient(configDir?: string): gmail_v1.Gmail {
  const dir = configDir || getConfigDir();
  const credentialsPath = path.join(dir, "credentials.json");
  const tokenPath = path.join(dir, "token.json");

  if (!fs.existsSync(credentialsPath)) {
    throw new Error(
      `Missing credentials.json in ${dir} — run 'npm run auth -- --config-dir ${dir}' first.`
    );
  }
  if (!fs.existsSync(tokenPath)) {
    throw new Error(
      `Missing token.json in ${dir} — run 'npm run auth -- --config-dir ${dir}' to authenticate.`
    );
  }

  const credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));
  const { client_id, client_secret } =
    credentials.installed || credentials.web;

  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    "http://localhost:3847/oauth2callback"
  );

  const tokens = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
  oauth2Client.setCredentials(tokens);

  // Auto-refresh token
  oauth2Client.on("tokens", (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    fs.writeFileSync(tokenPath, JSON.stringify(merged, null, 2));
  });

  return google.gmail({ version: "v1", auth: oauth2Client });
}

export function decodeBody(body: gmail_v1.Schema$MessagePartBody): string {
  if (!body.data) return "";
  return Buffer.from(body.data, "base64url").toString("utf-8");
}

export function extractMessageContent(
  payload: gmail_v1.Schema$MessagePart
): string {
  // Simple message with body
  if (payload.body?.data) {
    return decodeBody(payload.body);
  }

  // Multipart message
  if (payload.parts) {
    // Prefer text/plain, fall back to text/html
    const textPart = payload.parts.find((p) => p.mimeType === "text/plain");
    if (textPart?.body?.data) {
      return decodeBody(textPart.body);
    }
    const htmlPart = payload.parts.find((p) => p.mimeType === "text/html");
    if (htmlPart?.body?.data) {
      return decodeBody(htmlPart.body);
    }
    // Recursively check nested parts
    for (const part of payload.parts) {
      if (part.parts) {
        const content = extractMessageContent(part);
        if (content) return content;
      }
    }
  }

  return "";
}

export function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string
): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

export function createRawMessage(
  to: string,
  subject: string,
  body: string,
  from?: string,
  inReplyTo?: string,
  references?: string
): string {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
  ];
  if (from) lines.splice(1, 0, `From: ${from}`);
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  lines.push("", body);

  return Buffer.from(lines.join("\r\n")).toString("base64url");
}
