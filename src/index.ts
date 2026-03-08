import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import {
  getGmailClient,
  getConfigDir,
  extractMessageContent,
  getHeader,
  createRawMessage,
} from "./gmail-client.js";

function getArg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const serverName = getArg("name", "gmail");
const gmail = getGmailClient();
const server = new McpServer({
  name: serverName,
  version: "1.0.0",
});

// --- Tools ---

server.tool(
  "gmail_get_profile",
  "Get the authenticated user's Gmail profile (email address, message/thread counts)",
  {},
  async () => {
    const res = await gmail.users.getProfile({ userId: "me" });
    return {
      content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
    };
  }
);

server.tool(
  "gmail_search",
  "Search Gmail messages using Gmail search syntax (e.g. from:, to:, subject:, is:unread, has:attachment, after:, before:)",
  {
    query: z.string().optional().describe("Gmail search query. If omitted, returns recent messages"),
    maxResults: z.number().optional().default(20).describe("Max messages to return (1-500)"),
    pageToken: z.string().optional().describe("Page token for pagination"),
  },
  async ({ query, maxResults, pageToken }) => {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: query || "",
      maxResults,
      pageToken,
    });

    const messages = res.data.messages || [];
    const results = await Promise.all(
      messages.map(async (msg) => {
        const detail = await gmail.users.messages.get({
          userId: "me",
          id: msg.id!,
          format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date"],
        });
        const headers = detail.data.payload?.headers;
        return {
          id: msg.id,
          threadId: msg.threadId,
          from: getHeader(headers, "From"),
          to: getHeader(headers, "To"),
          subject: getHeader(headers, "Subject"),
          date: getHeader(headers, "Date"),
          snippet: detail.data.snippet,
          labelIds: detail.data.labelIds,
        };
      })
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { messages: results, nextPageToken: res.data.nextPageToken },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "gmail_read_message",
  "Read the full content of a specific email message by ID",
  {
    messageId: z.string().describe("The message ID to read"),
  },
  async ({ messageId }) => {
    const res = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    const payload = res.data.payload!;
    const headers = payload.headers;
    const body = extractMessageContent(payload);

    // Get attachment info
    const attachments: { filename: string; mimeType: string; size: number; attachmentId?: string }[] = [];
    const collectAttachments = (parts: typeof payload.parts) => {
      for (const part of parts || []) {
        if (part.filename && part.filename.length > 0) {
          attachments.push({
            filename: part.filename,
            mimeType: part.mimeType || "unknown",
            size: part.body?.size || 0,
            attachmentId: part.body?.attachmentId || undefined,
          });
        }
        if (part.parts) collectAttachments(part.parts);
      }
    };
    collectAttachments(payload.parts);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              id: res.data.id,
              threadId: res.data.threadId,
              from: getHeader(headers, "From"),
              to: getHeader(headers, "To"),
              cc: getHeader(headers, "Cc"),
              subject: getHeader(headers, "Subject"),
              date: getHeader(headers, "Date"),
              labelIds: res.data.labelIds,
              body,
              attachments,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "gmail_read_thread",
  "Read all messages in a Gmail thread",
  {
    threadId: z.string().describe("The thread ID to read"),
  },
  async ({ threadId }) => {
    const res = await gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "full",
    });

    const messages = (res.data.messages || []).map((msg) => {
      const headers = msg.payload?.headers;
      return {
        id: msg.id,
        from: getHeader(headers, "From"),
        to: getHeader(headers, "To"),
        subject: getHeader(headers, "Subject"),
        date: getHeader(headers, "Date"),
        body: extractMessageContent(msg.payload!),
        labelIds: msg.labelIds,
      };
    });

    return {
      content: [
        { type: "text", text: JSON.stringify({ threadId, messages }, null, 2) },
      ],
    };
  }
);

server.tool(
  "gmail_download_attachment",
  "Download an email attachment to a local directory",
  {
    messageId: z.string().describe("The message ID containing the attachment"),
    attachmentId: z.string().describe("The attachment ID (from gmail_read_message results)"),
    filename: z.string().describe("The filename to save as"),
    downloadDir: z
      .string()
      .optional()
      .default("~/Downloads")
      .describe("Directory to save the file to (default: ~/Downloads)"),
  },
  async ({ messageId, attachmentId, filename, downloadDir }) => {
    const resolvedDir = downloadDir.replace(/^~/, process.env.HOME || "/tmp");
    if (!fs.existsSync(resolvedDir)) {
      fs.mkdirSync(resolvedDir, { recursive: true });
    }

    const res = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: attachmentId,
    });

    if (!res.data.data) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "No attachment data found" }) }],
      };
    }

    const buffer = Buffer.from(res.data.data, "base64url");
    const filePath = path.join(resolvedDir, filename);
    fs.writeFileSync(filePath, buffer);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { downloaded: true, path: filePath, size: buffer.length },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "gmail_send_message",
  "Send a new email message",
  {
    to: z.string().describe("Recipient email address"),
    subject: z.string().describe("Email subject"),
    body: z.string().describe("Email body (plain text)"),
  },
  async ({ to, subject, body }) => {
    const raw = createRawMessage(to, subject, body);
    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { sent: true, id: res.data.id, threadId: res.data.threadId },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "gmail_reply",
  "Reply to an existing email message",
  {
    messageId: z.string().describe("ID of the message to reply to"),
    body: z.string().describe("Reply body (plain text)"),
  },
  async ({ messageId, body }) => {
    // Get original message for threading headers
    const original = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Message-ID", "References"],
    });
    const headers = original.data.payload?.headers;
    const replyTo = getHeader(headers, "From");
    let subject = getHeader(headers, "Subject");
    if (!subject.toLowerCase().startsWith("re:")) {
      subject = `Re: ${subject}`;
    }
    const originalMessageId = getHeader(headers, "Message-ID");
    const references = getHeader(headers, "References");

    const raw = createRawMessage(
      replyTo,
      subject,
      body,
      undefined,
      originalMessageId,
      references ? `${references} ${originalMessageId}` : originalMessageId
    );

    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw, threadId: original.data.threadId! },
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { sent: true, id: res.data.id, threadId: res.data.threadId },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "gmail_create_draft",
  "Create a draft email",
  {
    to: z.string().describe("Recipient email address"),
    subject: z.string().describe("Email subject"),
    body: z.string().describe("Email body (plain text)"),
  },
  async ({ to, subject, body }) => {
    const raw = createRawMessage(to, subject, body);
    const res = await gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw } },
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { draftId: res.data.id, messageId: res.data.message?.id },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "gmail_list_labels",
  "List all Gmail labels (system and user-created)",
  {},
  async () => {
    const res = await gmail.users.labels.list({ userId: "me" });
    return {
      content: [
        { type: "text", text: JSON.stringify(res.data.labels, null, 2) },
      ],
    };
  }
);

server.tool(
  "gmail_modify_labels",
  "Add or remove labels from a message",
  {
    messageId: z.string().describe("The message ID to modify"),
    addLabelIds: z.array(z.string()).optional().describe("Label IDs to add"),
    removeLabelIds: z.array(z.string()).optional().describe("Label IDs to remove"),
  },
  async ({ messageId, addLabelIds, removeLabelIds }) => {
    const res = await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: {
        addLabelIds: addLabelIds || [],
        removeLabelIds: removeLabelIds || [],
      },
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { id: res.data.id, labelIds: res.data.labelIds },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "gmail_trash_message",
  "Move a message to the trash",
  {
    messageId: z.string().describe("The message ID to trash"),
  },
  async ({ messageId }) => {
    await gmail.users.messages.trash({ userId: "me", id: messageId });
    return {
      content: [{ type: "text", text: JSON.stringify({ trashed: true, messageId }) }],
    };
  }
);

server.tool(
  "gmail_mark_read",
  "Mark a message as read (removes UNREAD label)",
  {
    messageId: z.string().describe("The message ID to mark as read"),
  },
  async ({ messageId }) => {
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: { removeLabelIds: ["UNREAD"] },
    });
    return {
      content: [{ type: "text", text: JSON.stringify({ markedRead: true, messageId }) }],
    };
  }
);

// --- Start server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Gmail MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
