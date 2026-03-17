import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Bot, InlineKeyboard, InputFile, GrammyError, HttpError } from "grammy";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Types ───────────────────────────────────────────────────────────────────

interface TelegramConfig {
  token?: string;
  stream?: boolean;
  streamThrottleMs?: number;
}

interface AuthConfig {
  trustedUsers?: string[];
}

interface BridgeConfig {
  telegram?: TelegramConfig;
  auth?: AuthConfig;
  autoConnect?: boolean;
}

interface PendingChat {
  chatId: string;
  username: string;
  userId: string;
}

interface StreamState {
  chatId: string;
  messageId?: number;
  lastText: string;
  lastEditTime: number;
  throttleTimer?: ReturnType<typeof setTimeout>;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(os.homedir(), ".pi", "telegram-bridge.json");
const LEGACY_CONFIG_PATH = path.join(os.homedir(), ".pi", "msg-bridge.json");

function loadConfig(): BridgeConfig {
  let config: BridgeConfig = {};

  // Auto-migrate from legacy config if new config doesn't exist
  if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(LEGACY_CONFIG_PATH)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_CONFIG_PATH, "utf-8"));
      config = {
        telegram: { token: legacy.telegram?.token, stream: false },
        auth: { trustedUsers: legacy.auth?.trustedUsers ?? [] },
        autoConnect: legacy.autoConnect ?? false,
      };
      saveConfig(config);
    } catch {}
  }

  // Load from file
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    } catch {}
  }

  // Env overrides
  if (process.env.PI_TELEGRAM_TOKEN) {
    config.telegram = { ...config.telegram, token: process.env.PI_TELEGRAM_TOKEN };
  }
  if (process.env.PI_TELEGRAM_STREAM !== undefined) {
    config.telegram = { ...config.telegram, stream: process.env.PI_TELEGRAM_STREAM === "true" };
  }
  if (process.env.PI_TELEGRAM_STREAM_THROTTLE) {
    config.telegram = { ...config.telegram, streamThrottleMs: parseInt(process.env.PI_TELEGRAM_STREAM_THROTTLE) };
  }
  if (process.env.PI_TELEGRAM_TRUSTED_USERS) {
    const users = process.env.PI_TELEGRAM_TRUSTED_USERS.split(",").map((id) => {
      const trimmed = id.trim();
      return trimmed.startsWith("telegram:") ? trimmed : `telegram:${trimmed}`;
    });
    config.auth = { ...config.auth, trustedUsers: users };
  }
  if (process.env.PI_TELEGRAM_AUTO_CONNECT !== undefined) {
    config.autoConnect = process.env.PI_TELEGRAM_AUTO_CONNECT === "true";
  }

  return config;
}

function saveConfig(config: BridgeConfig): void {
  const configDir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

// ─── Markdown → HTML ─────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function markdownToHtml(md: string): string {
  // Protect code blocks
  const codeBlocks: string[] = [];
  let result = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang, code) => {
    codeBlocks.push(`<pre>${escapeHtml(code.trimEnd())}</pre>`);
    return `__CODEBLOCK_${codeBlocks.length - 1}__`;
  });

  // Protect inline code
  const inlineCodes: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_match, code) => {
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `__INLINE_${inlineCodes.length - 1}__`;
  });

  // Escape HTML in remaining text
  result = escapeHtml(result);

  // Convert markdown formatting
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Convert headers to bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Restore code blocks and inline code
  result = result.replace(/__CODEBLOCK_(\d+)__/g, (_, idx) => codeBlocks[parseInt(idx)]);
  result = result.replace(/__INLINE_(\d+)__/g, (_, idx) => inlineCodes[parseInt(idx)]);

  return result;
}

// ─── Message Splitting ───────────────────────────────────────────────────────

function splitMessage(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to break at paragraph, then newline, then space
    let breakAt = remaining.lastIndexOf("\n\n", maxLen);
    if (breakAt < maxLen * 0.3) breakAt = remaining.lastIndexOf("\n", maxLen);
    if (breakAt < maxLen * 0.3) breakAt = remaining.lastIndexOf(" ", maxLen);
    if (breakAt < maxLen * 0.3) breakAt = maxLen;
    chunks.push(remaining.substring(0, breakAt));
    remaining = remaining.substring(breakAt).trimStart();
  }
  return chunks;
}

// ─── Message Helpers ─────────────────────────────────────────────────────────

function extractText(message: any): string {
  if (!message?.content) return "";
  return message.content
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text)
    .join("\n");
}

function hasToolCalls(message: any): boolean {
  return message?.content?.some((p: any) => p.type === "toolCall") ?? false;
}

function formatToolCalls(message: any): string {
  const toolCalls = message?.content?.filter((p: any) => p.type === "toolCall") ?? [];
  if (toolCalls.length === 0) return "";
  return toolCalls
    .map((tc: any) => {
      const name = tc.name || "tool";
      const args = tc.arguments || {};
      const argPairs = Object.entries(args)
        .map(([k, v]) => {
          const val = typeof v === "string" ? v : JSON.stringify(v);
          return `${k}=${val.length > 50 ? val.slice(0, 47) + "..." : val}`;
        })
        .join(", ");
      return `🔧 ${name} (${argPairs})`;
    })
    .join("\n");
}

// ─── Main Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let bot: Bot | null = null;
  let config: BridgeConfig = {};
  let latestCtx: ExtensionContext | null = null;
  let pendingChat: PendingChat | null = null;
  let streamState: StreamState | null = null;
  let isConnected = false;

  // ─── Bot Management ──────────────────────────────────────────────────────

  async function connectBot(): Promise<void> {
    if (isConnected || bot) return;

    const token = config.telegram?.token;
    if (!token) {
      latestCtx?.ui.notify("❌ Telegram token not configured", "error");
      return;
    }

    bot = new Bot(token);
    const trustedUsers = new Set(config.auth?.trustedUsers ?? []);

    // ─── Auth Middleware ────────────────────────────────────────────────
    bot.use(async (ctx, next) => {
      const userId = ctx.from?.id?.toString();
      if (!userId || !trustedUsers.has(`telegram:${userId}`)) {
        if (ctx.message) {
          await ctx.reply("⛔ Unauthorized. Your user ID: " + userId);
        }
        return;
      }
      await next();
    });

    // ─── Slash Commands ─────────────────────────────────────────────────

    bot.command("help", async (ctx) => {
      await ctx.reply(
        [
          "<b>📋 Available Commands</b>",
          "",
          "/new — New session",
          "/abort — Stop current generation",
          "/status — Show bot & agent status",
          "/model — Switch model (or /model &lt;name&gt;)",
          "/compact — Compact conversation",
          "/help — Show this help",
        ].join("\n"),
        { parse_mode: "HTML" },
      );
    });

    bot.command("new", async (ctx) => {
      if (!latestCtx) return;
      try {
        pi.sendUserMessage("/tg-new", { deliverAs: "steer" });
        await ctx.reply("🆕 Starting new session...");
      } catch (err: any) {
        await ctx.reply("❌ " + err.message);
      }
    });

    bot.command("abort", async (ctx) => {
      if (!latestCtx) return;
      if (latestCtx.isIdle()) {
        await ctx.reply("💤 Agent is already idle.");
        return;
      }
      latestCtx.abort();
      pendingChat = null;
      streamState = null;
      await ctx.reply("🛑 Generation aborted.");
    });

    bot.command("status", async (ctx) => {
      if (!latestCtx) {
        await ctx.reply("⚠️ Agent not ready.");
        return;
      }
      const model = latestCtx.model;
      const usage = latestCtx.getContextUsage();
      const idle = latestCtx.isIdle();
      const streaming = config.telegram?.stream ? "ON" : "OFF";

      const lines = [
        "<b>📊 Status</b>",
        "",
        `🤖 Model: <code>${model?.provider ?? "?"}/${model?.id ?? "?"}</code>`,
        `💬 State: ${idle ? "💤 Idle" : "⚡ Processing"}`,
        `📡 Streaming: ${streaming}`,
      ];

      if (usage) {
        const pct = ((usage.tokens / (model?.contextWindow ?? usage.tokens)) * 100).toFixed(1);
        lines.push(`📏 Context: ${usage.tokens.toLocaleString()} tokens (${pct}%)`);
      }

      await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
    });

    bot.command("model", async (ctx) => {
      const pattern = ctx.match?.trim();

      if (pattern) {
        // Direct model switch
        await switchModel(ctx, pattern);
      } else {
        // Show model picker
        const current = latestCtx?.model;
        const keyboard = new InlineKeyboard();
        const presets = [
          ["anthropic", "claude-sonnet-4-20250514", "Claude Sonnet 4"],
          ["anthropic", "claude-haiku-3-5-20241022", "Haiku 3.5"],
          ["google", "gemini-2.5-flash", "Gemini Flash"],
          ["google", "gemini-2.5-pro", "Gemini Pro"],
          ["openai", "gpt-4o", "GPT-4o"],
        ];
        for (let i = 0; i < presets.length; i++) {
          const [provider, id, label] = presets[i];
          const isCurrent = current?.provider === provider && current?.id?.includes(id.split("-").slice(0, 3).join("-"));
          keyboard.text(isCurrent ? `✅ ${label}` : label, `model:${provider}/${id}`);
          if (i % 2 === 1) keyboard.row();
        }

        await ctx.reply(
          `🤖 Current: <code>${current?.provider ?? "?"}/${current?.id ?? "?"}</code>\n\nSelect model or type <code>/model provider/name</code>:`,
          { parse_mode: "HTML", reply_markup: keyboard },
        );
      }
    });

    bot.command("compact", async (ctx) => {
      if (!latestCtx) return;
      latestCtx.compact({
        onComplete: () => sendTelegram(ctx.chat.id.toString(), "✅ Compaction complete."),
        onError: (err) => sendTelegram(ctx.chat.id.toString(), "❌ Compaction failed: " + err.message),
      });
      await ctx.reply("📦 Compacting conversation...");
    });

    // ─── Callback Queries (InlineKeyboard) ──────────────────────────────

    bot.callbackQuery(/^model:(.+)$/, async (ctx) => {
      const pattern = ctx.match![1];
      await ctx.answerCallbackQuery();
      await ctx.editMessageReplyMarkup(); // Remove keyboard
      await switchModel(ctx, pattern);
    });

    // ─── Reply Context Helper ───────────────────────────────────────────

    const REPLY_TRUNCATE_LENGTH = 200;

    async function extractReplyContext(ctx: any): Promise<string | null> {
      const reply = ctx.message?.reply_to_message;
      if (!reply) return null;

      const replyFrom = reply.from?.username || reply.from?.first_name || "unknown";
      const isBot = reply.from?.is_bot ?? false;
      const sender = isBot ? "🤖 pi" : `@${replyFrom}`;

      let content = "";
      if (reply.text) {
        content = reply.text;
      } else if (reply.caption) {
        content = reply.caption;
      } else if (reply.photo) {
        content = "[image]";
      } else {
        return null;
      }

      // Truncate bot's own messages to save tokens (already in conversation history)
      if (isBot && content.length > REPLY_TRUNCATE_LENGTH) {
        content = content.slice(0, REPLY_TRUNCATE_LENGTH).trimEnd() + "…(truncated)";
      }

      return `[💬 replying to ${sender}]: ${content}`;
    }

    // ─── Photo Messages ─────────────────────────────────────────────────

    bot.on("message:photo", async (ctx) => {
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      const file = await ctx.api.getFile(largest.file_id);

      if (!file.file_path) {
        await ctx.reply("❌ Could not download image.");
        return;
      }

      const url = `https://api.telegram.org/file/bot${config.telegram!.token}/${file.file_path}`;
      const response = await fetch(url);
      const buffer = Buffer.from(await response.arrayBuffer());
      const base64 = buffer.toString("base64");

      const username = ctx.from?.username || ctx.from?.first_name || "user";
      const caption = ctx.message.caption || "Please analyze this image.";

      const replyContext = await extractReplyContext(ctx);
      const textParts = replyContext
        ? `${replyContext}\n\n[📱 @${username} via telegram]: ${caption}`
        : `[📱 @${username} via telegram]: ${caption}`;

      setPendingChat(ctx);
      forwardToPi(
        [
          { type: "text" as const, text: textParts },
          { type: "image" as const, mimeType: "image/jpeg" as const, data: base64 },
        ],
      );
    });

    // ─── Text Messages ──────────────────────────────────────────────────

    bot.on("message:text", async (ctx) => {
      // Skip commands (already handled above)
      if (ctx.message.text.startsWith("/")) return;

      const username = ctx.from?.username || ctx.from?.first_name || "user";
      const text = ctx.message.text;

      const replyContext = await extractReplyContext(ctx);
      const message = replyContext
        ? `${replyContext}\n\n[📱 @${username} via telegram]: ${text}`
        : `[📱 @${username} via telegram]: ${text}`;

      setPendingChat(ctx);
      forwardToPi(message);
    });

    // ─── Error Handler ──────────────────────────────────────────────────

    bot.catch((err) => {
      const e = err.error;
      if (e instanceof GrammyError) {
        console.error("Grammy error:", e.description);
      } else if (e instanceof HttpError) {
        console.error("HTTP error:", e);
      } else {
        console.error("Bot error:", e);
      }
    });

    // ─── Start Bot ──────────────────────────────────────────────────────

    // Register commands menu in Telegram
    await bot.api.setMyCommands([
      { command: "new", description: "New session" },
      { command: "abort", description: "Stop generation" },
      { command: "status", description: "Show status" },
      { command: "model", description: "Switch model" },
      { command: "compact", description: "Compact conversation" },
      { command: "help", description: "Show help" },
    ]);

    bot.start({
      drop_pending_updates: true,
      onStart: () => {
        isConnected = true;
        latestCtx?.ui.setStatus("tg", "📱 Telegram connected");
        latestCtx?.ui.notify("📱 Telegram bot connected", "info");
      },
    });
  }

  async function disconnectBot(): Promise<void> {
    if (!bot) return;
    await bot.stop();
    bot = null;
    isConnected = false;
    latestCtx?.ui.setStatus("tg", undefined);
    latestCtx?.ui.notify("📱 Telegram bot disconnected", "info");
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  function setPendingChat(ctx: any): void {
    pendingChat = {
      chatId: ctx.chat.id.toString(),
      username: ctx.from?.username || ctx.from?.first_name || "user",
      userId: ctx.from?.id?.toString() || "",
    };
  }

  function forwardToPi(content: string | any[]): void {
    try {
      if (latestCtx?.isIdle()) {
        pi.sendUserMessage(content);
      } else {
        pi.sendUserMessage(content, { deliverAs: "followUp" });
      }
    } catch {
      try {
        pi.sendUserMessage(content, { deliverAs: "followUp" });
      } catch (err) {
        console.error("Failed to forward to pi:", err);
      }
    }
  }

  async function switchModel(ctx: any, pattern: string): Promise<void> {
    if (!latestCtx) return;

    let provider: string | undefined;
    let modelPattern: string;

    if (pattern.includes("/")) {
      [provider, modelPattern] = pattern.split("/", 2);
    } else {
      modelPattern = pattern;
    }

    // Try to find model
    const providers = provider ? [provider] : ["anthropic", "google", "openai", "deepseek"];
    let model: any = null;

    for (const p of providers) {
      model = latestCtx.modelRegistry.find(p, modelPattern);
      if (model) break;
    }

    if (!model) {
      const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;
      await sendTelegram(chatId.toString(), `❌ Model not found: ${pattern}`);
      return;
    }

    const success = await pi.setModel(model);
    const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;
    if (success) {
      await sendTelegram(chatId.toString(), `✅ Switched to <code>${model.provider}/${model.id}</code>`, "HTML");
    } else {
      await sendTelegram(chatId.toString(), `❌ No API key for ${model.provider}/${model.id}`);
    }
  }

  async function sendTelegram(chatId: string, text: string, parseMode?: "HTML" | "Markdown"): Promise<void> {
    if (!bot) return;

    const chunks = splitMessage(text, 4000);
    for (const chunk of chunks) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await bot.api.sendMessage(chatId, chunk, parseMode ? { parse_mode: parseMode } : {});
          break;
        } catch (err) {
          if (attempt === 2) {
            // Last attempt: try without formatting
            try {
              const plain = chunk.replace(/<[^>]+>/g, "");
              await bot.api.sendMessage(chatId, plain);
            } catch {
              console.error("Failed to send message after 3 retries:", err);
            }
          } else {
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          }
        }
      }
    }
  }

  async function sendTelegramHtml(chatId: string, markdown: string): Promise<void> {
    const html = markdownToHtml(markdown);
    await sendTelegram(chatId, html, "HTML");
  }

  // ─── Streaming ────────────────────────────────────────────────────────

  async function flushStream(): Promise<void> {
    if (!streamState || !bot) return;

    if (streamState.throttleTimer) {
      clearTimeout(streamState.throttleTimer);
      streamState.throttleTimer = undefined;
    }

    const displayText = streamState.lastText + " ▍";

    try {
      if (!streamState.messageId) {
        const msg = await bot.api.sendMessage(streamState.chatId, displayText);
        streamState.messageId = msg.message_id;
      } else {
        await bot.api.editMessageText(streamState.chatId, streamState.messageId, displayText);
      }
      streamState.lastEditTime = Date.now();
    } catch {
      // Ignore edit errors (message not modified, rate limit, etc.)
    }
  }

  async function finalizeStream(text: string): Promise<void> {
    if (!streamState || !bot) return;

    if (streamState.throttleTimer) {
      clearTimeout(streamState.throttleTimer);
      streamState.throttleTimer = undefined;
    }

    if (!text) {
      streamState = null;
      return;
    }

    try {
      if (!streamState.messageId) {
        // Never sent initial message, send final with HTML
        const html = markdownToHtml(text);
        try {
          await bot.api.sendMessage(streamState.chatId, html, { parse_mode: "HTML" });
        } catch {
          await bot.api.sendMessage(streamState.chatId, text);
        }
      } else if (text.length <= 4000) {
        // Edit existing message with HTML formatting
        const html = markdownToHtml(text);
        try {
          await bot.api.editMessageText(streamState.chatId, streamState.messageId, html, { parse_mode: "HTML" });
        } catch {
          try {
            await bot.api.editMessageText(streamState.chatId, streamState.messageId, text);
          } catch {
            // Message unchanged, that's fine
          }
        }
      } else {
        // Text too long for single message: delete streamed msg, send as chunks
        try {
          await bot.api.deleteMessage(streamState.chatId, streamState.messageId);
        } catch {}
        await sendTelegramHtml(streamState.chatId, text);
      }
    } catch (err) {
      console.error("Failed to finalize stream:", err);
      // Fallback: send as new message
      try {
        await sendTelegram(streamState.chatId, text);
      } catch {}
    }

    streamState = null;
  }

  // ─── Pi Events ────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    config = loadConfig();

    if (config.autoConnect && config.telegram?.token) {
      await connectBot();
    }
  });

  pi.on("turn_start", async (_event, ctx) => {
    latestCtx = ctx;
    if (!pendingChat || !bot) return;

    try {
      await bot.api.sendChatAction(pendingChat.chatId, "typing");
    } catch {}
  });

  pi.on("message_start", async (event, _ctx) => {
    if (!pendingChat || !config.telegram?.stream) return;
    if (event.message?.role !== "assistant") return;

    // Initialize stream state for new assistant message
    streamState = {
      chatId: pendingChat.chatId,
      lastText: "",
      lastEditTime: 0,
    };
  });

  pi.on("message_update", async (event, _ctx) => {
    if (!streamState || !config.telegram?.stream) return;

    const text = extractText(event.message);
    if (!text || text === streamState.lastText) return;

    streamState.lastText = text;

    const now = Date.now();
    const throttle = config.telegram?.streamThrottleMs ?? 1500;

    if (now - streamState.lastEditTime >= throttle) {
      await flushStream();
    } else if (!streamState.throttleTimer) {
      const delay = throttle - (now - streamState.lastEditTime);
      streamState.throttleTimer = setTimeout(() => flushStream(), delay);
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    latestCtx = ctx;
    if (!pendingChat) return;

    const message = event.message;
    const text = extractText(message);
    const toolCallsText = formatToolCalls(message);
    const hasPending = hasToolCalls(message);

    if (streamState) {
      // Streaming mode: finalize the streamed message
      await finalizeStream(text);

      // Send tool calls as separate message
      if (toolCallsText) {
        await sendTelegram(pendingChat.chatId, toolCallsText);
      }
    } else {
      // Non-streaming mode: send complete response
      const parts: string[] = [];
      if (text) parts.push(text);
      if (toolCallsText) parts.push(toolCallsText);

      if (parts.length > 0) {
        // Send text part with HTML formatting, tool calls as plain
        if (text && toolCallsText) {
          await sendTelegramHtml(pendingChat.chatId, text);
          await sendTelegram(pendingChat.chatId, toolCallsText);
        } else if (text) {
          await sendTelegramHtml(pendingChat.chatId, text);
        } else {
          await sendTelegram(pendingChat.chatId, toolCallsText);
        }
      }
    }

    // Clear pending chat when no more tool calls
    if (!hasPending) {
      pendingChat = null;
    }
  });

  // Detect images in tool results and send to Telegram
  pi.on("tool_execution_end", async (event, _ctx) => {
    if (!pendingChat || !bot) return;

    const result = event.result;
    if (!result?.content) return;

    for (const part of result.content as any[]) {
      if (part.type === "text" && typeof part.text === "string") {
        // Look for image file paths in text
        const imageRegex = /(?:^|\s)(\/[^\s]+\.(?:png|jpg|jpeg|gif|webp))/gi;
        let match;
        while ((match = imageRegex.exec(part.text)) !== null) {
          const filePath = match[1];
          if (fs.existsSync(filePath)) {
            try {
              await bot.api.sendPhoto(pendingChat.chatId, new InputFile(filePath));
            } catch (err) {
              console.error("Failed to send image:", err);
            }
          }
        }
      }
    }
  });

  pi.on("session_shutdown", async () => {
    await disconnectBot();
  });

  // ─── Pi Commands ──────────────────────────────────────────────────────

  pi.registerCommand("tg", {
    description: "Manage Telegram bridge (status|connect|disconnect|config)",
    handler: async (args, ctx) => {
      latestCtx = ctx;
      const [subcommand, ...rest] = (args || "").trim().split(/\s+/);

      switch (subcommand) {
        case "connect":
          config = loadConfig();
          await connectBot();
          break;

        case "disconnect":
          await disconnectBot();
          break;

        case "status":
          ctx.ui.notify(
            isConnected
              ? `📱 Telegram connected | Stream: ${config.telegram?.stream ? "ON" : "OFF"} | Trusted: ${config.auth?.trustedUsers?.length ?? 0} users`
              : "📱 Telegram disconnected",
            "info",
          );
          break;

        case "config":
          ctx.ui.notify(JSON.stringify(config, null, 2), "info");
          break;

        case "token": {
          const token = rest.join(" ").trim();
          if (!token) {
            ctx.ui.notify("Usage: /tg token <bot-token>", "warning");
            return;
          }
          config.telegram = { ...config.telegram, token };
          saveConfig(config);
          ctx.ui.notify("✅ Token saved. Use /tg connect to connect.", "success");
          break;
        }

        case "trust": {
          const userId = rest[0]?.trim();
          if (!userId) {
            ctx.ui.notify("Usage: /tg trust <user-id>", "warning");
            return;
          }
          const fullId = userId.startsWith("telegram:") ? userId : `telegram:${userId}`;
          if (!config.auth) config.auth = {};
          if (!config.auth.trustedUsers) config.auth.trustedUsers = [];
          if (!config.auth.trustedUsers.includes(fullId)) {
            config.auth.trustedUsers.push(fullId);
            saveConfig(config);
            ctx.ui.notify(`✅ Trusted user added: ${fullId}`, "success");
          } else {
            ctx.ui.notify(`Already trusted: ${fullId}`, "info");
          }
          break;
        }

        case "stream": {
          const value = rest[0]?.trim();
          if (value === "on" || value === "true") {
            config.telegram = { ...config.telegram, stream: true };
            saveConfig(config);
            ctx.ui.notify("✅ Streaming enabled", "success");
          } else if (value === "off" || value === "false") {
            config.telegram = { ...config.telegram, stream: false };
            saveConfig(config);
            ctx.ui.notify("✅ Streaming disabled", "success");
          } else {
            ctx.ui.notify(`Streaming: ${config.telegram?.stream ? "ON" : "OFF"}\nUsage: /tg stream on|off`, "info");
          }
          break;
        }

        default:
          ctx.ui.notify(
            [
              "📱 Telegram Bridge Commands:",
              "  /tg connect      — Connect bot",
              "  /tg disconnect   — Disconnect bot",
              "  /tg status       — Show status",
              "  /tg config       — Show config",
              "  /tg token <tok>  — Set bot token",
              "  /tg trust <id>   — Add trusted user",
              "  /tg stream on|off — Toggle streaming",
            ].join("\n"),
            "info",
          );
          break;
      }
    },
  });

  // Pi command for Telegram's /new
  pi.registerCommand("tg-new", {
    description: "New session (triggered from Telegram)",
    handler: async (_args, ctx) => {
      await ctx.newSession();
    },
  });
}
