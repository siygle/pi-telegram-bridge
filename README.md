# 📱 pi-telegram-bridge

A [pi coding agent](https://github.com/nickarino/pi-coding-agent) extension that bridges Telegram to your local pi session — chat with your AI coding assistant from anywhere.

## Features

- 💬 **Two-way messaging** — Send messages from Telegram, get responses back
- 🖼️ **Image support** — Send photos for vision/analysis
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
  "autoConnect": true
}
```

| Option | Env Variable | Description |
|--------|-------------|-------------|
| `telegram.token` | `PI_TELEGRAM_TOKEN` | Bot token from BotFather |
| `telegram.stream` | `PI_TELEGRAM_STREAM` | Enable streaming responses (`true`/`false`) |
| `telegram.streamThrottleMs` | `PI_TELEGRAM_STREAM_THROTTLE` | Minimum ms between stream edits (default: 1500) |
| `auth.trustedUsers` | `PI_TELEGRAM_TRUSTED_USERS` | Comma-separated Telegram user IDs |
| `autoConnect` | `PI_TELEGRAM_AUTO_CONNECT` | Auto-connect on pi startup |

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
