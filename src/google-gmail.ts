import { google } from "googleapis";
import { getAuthClient } from "./google-auth.js";

export interface EmailSummary {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
}

function extractHeader(
  headers: Array<{ name?: string | null; value?: string | null }>,
  name: string
): string {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export async function getUnreadEmails(maxResults = 5): Promise<EmailSummary[]> {
  const auth = await getAuthClient();
  const gmail = google.gmail({ version: "v1", auth });

  // List unread inbox message IDs
  const listRes = await gmail.users.messages.list({
    userId: "me",
    q: "is:unread in:inbox",
    maxResults: Math.min(maxResults, 20),
  });

  const messages = listRes.data.messages ?? [];
  if (messages.length === 0) return [];

  // Fetch metadata (From, Subject, Date) in parallel
  const summaries = await Promise.all(
    messages.map(async (msg) => {
      const detail = await gmail.users.messages.get({
        userId: "me",
        id: msg.id!,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"],
      });

      const headers = detail.data.payload?.headers ?? [];
      return {
        id: msg.id ?? "",
        from: extractHeader(headers, "From"),
        subject: extractHeader(headers, "Subject"),
        snippet: detail.data.snippet ?? "",
        date: extractHeader(headers, "Date"),
      };
    })
  );

  return summaries;
}

export async function sendEmail(
  to: string,
  subject: string,
  body: string
): Promise<{ messageId: string; threadId: string }> {
  const auth = await getAuthClient();
  const gmail = google.gmail({ version: "v1", auth });

  const mime = [
    `From: omer.donovich@gmail.com`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    Buffer.from(body).toString("base64"),
  ].join("\r\n");

  const encoded = Buffer.from(mime)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encoded },
  });

  return {
    messageId: res.data.id ?? "",
    threadId: res.data.threadId ?? "",
  };
}
