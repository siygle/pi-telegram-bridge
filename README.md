# 📱 pi-telegram-bridge

A [pi coding agent](https://github.com/nickarino/pi-coding-agent) extension that bridges Telegram to your local pi session — chat with your AI coding assistant from anywhere.

## Features

- 💬 **Two-way messaging** — Send messages from Telegram, get responses back
- 🖼️ **Image support** — Send photos for vision/analysis
- 🎙️ **Voice / audio / video_note support** — Auto-transcribed via Groq Whisper (free tier) or OpenAI
- 📡 **Streaming mode** — Watch responses appear in real-time (optional)
- 🔐 **Auth control** — Whitelist trusted Telegram users by ID
- 🤖 **Model switching** — Change models on the fly via `/model`
- 💬 **Reply context** — Reply to messages to include context
- 📋 **Slash commands** — `/new`, `/abort`, `/status`, `/model`, `/compact`, `/help`

## Installation

1. **Clone into your pi extensions directory:**

   ```bash
   cd ~/.pi/agent/extensions
   git clone https://github.com/siygle/pi-telegram-bridge.git telegram-bridge
   cd telegram-bridge
   npm install
   ```

2. **Create a Telegram bot** via [@BotFather](https://t.me/BotFather) and get your bot token.

3. **Configure the bridge** (from within pi):

   ```
   /tg token <your-bot-token>
   /tg trust <your-telegram-user-id>
   /tg connect
   ```

   Or set environment variables:

   ```bash
   export PI_TELEGRAM_TOKEN="your-bot-token"
   export PI_TELEGRAM_TRUSTED_USERS="123456789"
   export PI_TELEGRAM_AUTO_CONNECT="true"
   ```

## Configuration

Config is stored in `~/.pi/telegram-bridge.json`:

```json
{
  "telegram": {
    "token": "your-bot-token",
    "stream": false,
    "streamThrottleMs": 1500
  },
  "auth": {
    "trustedUsers": ["telegram:123456789"]
  },
  "autoConnect": true,
  "stt": {
    "provider": "groq",
    "apiKey": "gsk_...",
    "model": "whisper-large-v3-turbo",
    "language": "zh"
  }
}
```

| Option | Env Variable | Description |
|--------|-------------|-------------|
| `telegram.token` | `PI_TELEGRAM_TOKEN` | Bot token from BotFather |
| `telegram.stream` | `PI_TELEGRAM_STREAM` | Enable streaming responses (`true`/`false`) |
| `telegram.streamThrottleMs` | `PI_TELEGRAM_STREAM_THROTTLE` | Minimum ms between stream edits (default: 1500) |
| `auth.trustedUsers` | `PI_TELEGRAM_TRUSTED_USERS` | Comma-separated Telegram user IDs |
| `autoConnect` | `PI_TELEGRAM_AUTO_CONNECT` | Auto-connect on pi startup |
| `stt.provider` | `PI_TELEGRAM_STT_PROVIDER` | `groq` (default), `openai`, or `none` |
| `stt.apiKey` | `PI_TELEGRAM_STT_API_KEY` / `GROQ_API_KEY` / `OPENAI_API_KEY` | API key for the STT provider |
| `stt.model` | `PI_TELEGRAM_STT_MODEL` | Default: `whisper-large-v3-turbo` (Groq) / `whisper-1` (OpenAI) |
| `stt.language` | `PI_TELEGRAM_STT_LANGUAGE` | Optional ISO-639-1 hint (e.g. `zh`, `en`) |
| `stt.baseUrl` | — | Override API base URL (for self-hosted/compatible endpoints) |

### Voice transcription

Send a voice message, audio file, or video_note in Telegram and the bridge will:

1. Download the file to `/tmp/pi-telegram-uploads/`
2. Transcribe via the configured STT provider (Groq by default)
3. Forward the transcript + file path to pi as:
   `[📱 @user via telegram][🎙️ voice, 12s, 48.3KB, file: /tmp/...]: <transcript>`

If STT is not configured, the file path is still forwarded so you can transcribe manually.

**Quick setup with Groq (free tier):**

```bash
export GROQ_API_KEY="gsk_..."   # get from https://console.groq.com/keys
```

The bridge auto-detects `GROQ_API_KEY` and defaults the provider to `groq` with `whisper-large-v3-turbo`. Free tier covers ~8h of audio/day — plenty for personal use.

## Commands

### In pi (TUI)

| Command | Description |
|---------|-------------|
| `/tg connect` | Connect the Telegram bot |
| `/tg disconnect` | Disconnect the bot |
| `/tg status` | Show connection status |
| `/tg config` | Show current config |
| `/tg token <tok>` | Set bot token |
| `/tg trust <id>` | Add a trusted user |
| `/tg stream on\|off` | Toggle streaming mode |

### In Telegram

| Command | Description |
|---------|-------------|
| `/new` | Start a new session |
| `/abort` | Stop current generation |
| `/status` | Show bot & agent status |
| `/model` | Switch model (interactive or `/model provider/name`) |
| `/compact` | Compact conversation history |
| `/help` | Show help |

## How It Works

1. The extension registers as a pi extension and starts a Telegram bot via [grammY](https://grammy.dev/)
2. Incoming Telegram messages are forwarded to the pi agent as user messages
3. Agent responses (from `turn_end` events) are sent back to Telegram with HTML formatting
4. Images from tool results (e.g., generated posters, screenshots) are automatically sent to Telegram
5. Unauthorized users are rejected with their user ID displayed (for easy whitelisting)

## Design Notes

- Memory architecture plan: [`docs/memory-architecture-plan.md`](docs/memory-architecture-plan.md)

## Requirements

- [pi coding agent](https://github.com/nickarino/pi-coding-agent) (v1.0+)
- Node.js 20+
- A Telegram bot token

## License

MIT
