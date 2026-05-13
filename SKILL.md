---
name: follow-competitor
description: >-
  Scheduled competitor-intel digest from configurable web sources (Sumsub The Sumsuber
  listings by default): fetches COMPETITOR_OFFICIAL / COMPETITOR_PODCAST /
  REGULATORY_TRACKING windows, incremental URL
  dedupe, optional PDF text and YouTube captions, then remixes into Markdown using the
  host product's currently selected model. Delivers via Feishu app (Open API), Feishu
  webhook, or stdout. Use when the user configures or runs follow-competitor, competitor
  digest, 竞品摘要, 配置 follow-competitor, 飞书 app 发摘要, Sumsub monitoring, or /competitor.
---

# follow-competitor

Track public competitor content hubs (starting with [Sumsub media](https://sumsub.com/media/), [news](https://sumsub.com/media/news/), and [podcast index](https://sumsub.com/blog/podcast/)), summarize **only** what the fetch pipeline puts in JSON, and deliver on a schedule or on demand.

**Skill root** = the directory containing this `SKILL.md` (used for `sources.json`, `prompts/`, and `scripts/`).

**User data directory** = `~/.follow-competitor` unless overridden by env `FOLLOW_COMPETITOR_USER_DIR` (handy for CI or sandbox tests).

---

## Source material: article bodies, PDFs, and video transcripts

- **COMPETITOR_OFFICIAL (Sumsub news/media + competitor official sources):** After building the listing, `prepare.js` fetches each **canonical article URL** and stores stripped body text as **`articleText`** for the LLM to summarize (not just the listing title/excerpt). Sumsub uses its Next.js post content; Trulioo / Jumio / Veriff use generic blog/RSS discovery with 7-day windows. Persona is intentionally excluded for now because automated fetches return 403. The prepare layer filters official content unrelated to KYC / AML / KYB / IDV / fraud / compliance / regulatory themes.
- **Canonical URLs (Sumsub):** Listing `uri` values are often **not** the public document path (e.g. `/news/slug/` 404s at site root). The script rewrites to working paths such as `/media/news/...`, `/media/spotlight/...`, `/blog/<slug>/` (bare single-segment paths), and `/blog/podcast/...` for podcasts.
- **PDFs:** `prepare.js` downloads `.pdf` URLs and extracts text with `pdf-parse` (length-capped). Scanned PDFs may yield little or no text.
- **REGULATORY_TRACKING:** FATF and FinCEN follow the **follow-builders central-feed pattern**. `scripts/generate-feed.js` runs in a trusted environment with `X_BEARER_TOKEN` and writes `feed-x.json`; normal users run `prepare.js`, which only reads the public/local feed and does **not** need X API credentials. Items include `tweetText`, `xHandle`, and metrics; the digest should summarize tweet content only, not generate sales scripts.
- **Podcast / YouTube transcripts:** The **follow-builders** skill’s `prepare-digest.js` only consumes **pre-built** podcast transcripts from a central JSON feed. `follow-competitor` follows that model: GitHub Actions runs `scripts/generate-feed.js` with `ASSEMBLYAI_API_KEY`, fetches Moody’s official podcast pages, extracts `.mp3` audio URLs, transcribes with AssemblyAI, and writes `feed-podcasts.json`. Normal `prepare.js` runs read that central feed first and do not need local transcript keys. Local AssemblyAI / pod2txt / YouTube caption fallbacks remain for manual runs. YouTube-only videos still fall back to: (1) **`youtube-transcript`**; (2) optional **`yt-dlp`** on `PATH` / `YT_DLP_PATH` (`FOLLOW_COMPETITOR_DISABLE_YTDLP=1` skips). **A plain YouTube Data API key cannot download captions** without OAuth. Transcript failures are recorded in `transcriptAttempts`.
- **Other embeds (Vimeo, etc.):** No universal transcript API here. Mention the URL and any HTML-visible description only.

---

## Markdown digest vs structured JSON

| Artifact | What it is | Who consumes it |
|----------|------------|-----------------|
| **Structured JSON** (`prepare.js` stdout) | Machine-readable batch: `items[]` with `category`, `url`, `title`, `publishedAt`, `excerpt`, optional **`articleText`** / `transcript` / `pdfText`, plus `config` (incl. `digestDepth`, `language`) and `prompts`. | The agent + optional downstream tools (dashboards, CRM, n8n). |
| **Markdown digest** | Human-readable report the agent writes **after** reading the JSON, following `prompts.digest_intro` + `prompts.summarize_items`. | Humans, Feishu threads, email paste, OpenClaw messages. |

Default workflow: **JSON → LLM remix → Markdown** → `deliver.js`.

---

## Which model writes the Markdown?

**This skill does not choose or pin a model.** The Markdown digest is written by **whatever chat/agent is hosting the skill** when it runs the remix step (e.g. Cursor’s current chat model, Codex’s model, or OpenClaw’s configured agent model). `prepare.js` is plain Node and does not call an LLM.

- **Cursor:** the model selected in the chat / Composer / Agent UI for that session.
- **Codex CLI / other hosts:** that product’s default or user-selected model for the agent run.
- **OpenClaw:** the agent model configured for the session that executes the cron or user message.

To “fix” a model for digests, change it in the **host product** (or the OpenClaw agent profile), not in `config.json`.

---

## Platform detection

Run:

```bash
which openclaw 2>/dev/null && echo "PLATFORM=openclaw" || echo "PLATFORM=other"
```

- **openclaw:** Prefer OpenClaw cron + channel delivery (same pattern as other skills: explicit `--channel` / `--to`, never `--channel last` when multiple channels exist).
- **other:** Cursor, Codex CLI, etc. Use Feishu (`feishu_webhook` / `feishu_app`) and/or `stdout`; system `crontab` may call `prepare.js | deliver.js` if you accept non-LLM piping limitations, or cron should invoke the agent with a message to run this skill end-to-end.

Persist `"platform": "openclaw"` or `"other"` in `~/.follow-competitor/config.json`.

---

## First run — onboarding

1. Ensure `mkdir -p ~/.follow-competitor`.
2. Copy a starter file to `~/.follow-competitor/config.json` and edit:
   - **`config/config.example.feishu-app.json`** — **飞书自建应用 + OpenAPI 发 IM**（`feishu_app`；推荐需要「应用发消息」的场景）
   - `config/config.example.json` — **群自定义机器人 Webhook**（`feishu_webhook`；仅需 Webhook URL）
   Field definitions: `config/config-schema.json`. **User-facing checklist and wake phrases:** see `README.md`.
3. Minimum fields: `language` (`en` | `zh`), `delivery.method`, `onboardingComplete: true` when finished.

**Agent:** When the user wakes the skill with phrases like **「配置 follow-competitor」** / **setup follow-competitor**, **first** paste or walk through the **fill-in tables** in `README.md` → **「初始化要填什么」** (method, language, Feishu IDs/secrets, etc.). Do **not** replace that step with long prose; point to `SKILL.md` Feishu option A/B only for details after the checklist.

### Feishu option A — `feishu_webhook`（推荐上手）

**需要的信息：**仅 **Webhook 地址**（一条 HTTPS URL）。

**怎么拿到：**飞书群 → 设置 → 群机器人 → 添加机器人 → **自定义机器人** → 复制 Webhook（形如 `https://open.feishu.cn/open-apis/bot/v2/hook/...`；国际版可能是 `https://open.larksuite.com/...`）。

**放在哪里（初始化）：**

- 推荐：`~/.follow-competitor/config.json` 里 `delivery.feishuWebhookUrl`（见 `config.example.json`）；或
- 备选：`~/.follow-competitor/.env` 中 `FEISHU_WEBHOOK_URL=...`（不把 URL 写进仓库时可用）

`deliver.js` 会优先用 config 里的 `feishuWebhookUrl`，否则读环境变量。

**不需要** `app_id` / `chat_id`（群由 Webhook 绑定；消息发到该群）。

### Feishu option B — `feishu_app`（自建应用发 IM）

**需要的信息：**

| 项 | 用途 | 建议存放 |
|----|------|----------|
| **App ID** | 开发者后台应用凭证 | `~/.follow-competitor/.env`：`FEISHU_APP_ID`（可在 config 写 `delivery.feishuAppId`，但不建议把密钥放 config） |
| **App Secret** | 换 `tenant_access_token` | **仅** `.env`：`FEISHU_APP_SECRET`（或 `delivery.feishuAppSecret`，强烈不推荐提交到 git） |
| **接收方 ID** | `im/v1/messages` 的 `receive_id` | `config.json`：`delivery.feishuReceiveId`（或兼容字段 `feishuChatId`，表示群 `chat_id` / `oc_xxx`） |
| **receive_id 类型** | 与 ID 类型一致 | `delivery.feishuReceiveIdType`：`chat_id`（群） / `open_id`（用户）等，默认 `chat_id` |
| **API 域名** | 国内 vs 国际 | `delivery.feishuApiBase`：`https://open.feishu.cn` 或 `https://open.larksuite.com`；也可用环境变量 `FEISHU_API_BASE` |

应用在飞书开放平台需开通 **机器人** 能力并申请 **`im:message` / `im:message:send_as_bot`**（或当前控制台等价权限），机器人须被拉进目标群（或对用户可发单聊）。

初始化时把 **非密钥**（`feishuReceiveId`、`feishuReceiveIdType`、`feishuApiBase`）放进 `config.json`，把 **App Secret** 放进 `.env` 即可完成配置。

### 增量抓取

URLs are remembered in `state.json`. New items = in rolling window **and** not in `seenUrls`. After a successful digest, run finalize (below).

---

## Content run (manual or cron preamble)

### Step 1 — Resolve paths

```bash
SKILL_ROOT="<absolute path to the folder containing this SKILL.md>"
USER_DIR="${FOLLOW_COMPETITOR_USER_DIR:-$HOME/.follow-competitor}"
```

### Step 2 — Fetch + build JSON (deterministic)

```bash
cd "$SKILL_ROOT/scripts" && node prepare.js 2>/dev/null
```

The script:

- Reads `$SKILL_ROOT/sources.json` plus central `feed-x.json` for regulatory tweets and `feed-podcasts.json` for podcast transcripts. Supported parsers include `sumsub-next-*`, `generic-blog-list`, `rss-list`, `podcast-rss`, `moodys-podcast-page`, and `youtube-channel-rss`.
- Writes `$USER_DIR/last-batch.json` and updates `$USER_DIR/state.json` timestamps (does **not** append `seenUrls` until finalize).

### Step 3 — Empty batch

If `stats.newItems === 0`, tell the user there is nothing new in the configured windows and stop.

### Step 4 — Remix (LLM)

Use the **host session’s current model** (see [Which model writes the Markdown?](#which-model-writes-the-markdown)). **Only use fields present in JSON items.** Follow `prompts.digest_intro` and `prompts.summarize_items`. Respect `config.language` (`en` or `zh`) and **`config.digestDepth`**: `simple` (short bullets) vs **`detailed`**. Detailed mode is source-type aware: **`COMPETITOR_OFFICIAL`** uses follow-builders-style blog remix with presales/commercial implications; **`REGULATORY_TRACKING`** summarizes regulator tweet content directly; **`COMPETITOR_PODCAST`** follows the podcast-remix pattern when transcript exists. Every item must keep its canonical `url`.

### Step 5 — Deliver

**stdout:** print the Markdown digest in chat.

**Feishu (`feishu_webhook` or `feishu_app`, legacy `feishu` = webhook):**

```bash
echo '<markdown digest>' > /tmp/fc-digest.md
cd "$SKILL_ROOT/scripts" && node deliver.js --file /tmp/fc-digest.md 2>/dev/null
```

If delivery fails, paste the digest in the terminal.

### Step 6 — Finalize incremental state

After the user confirms receipt (or you successfully posted to Feishu):

```bash
cd "$SKILL_ROOT/scripts" && node prepare.js --finalize 2>/dev/null
```

This merges all URLs from `last-batch.json` into `state.seenUrls`.

---

## Sources and classification

- Categories are **assigned from the feed** in `sources.json` (not inferred by the LLM).
- Active source categories: **`COMPETITOR_OFFICIAL`**, **`REGULATORY_TRACKING`**, **`COMPETITOR_PODCAST`**. `MARKET_SIGNAL`, `KYC_LONGFORM`, and `SOCIAL_ALERT` are intentionally not used.
- Default windows: Sumsub **news/media** = 3 days; Trulioo / Jumio / Veriff official sources = 7 days; FATF / FinCEN X = 3 days; podcasts = 14 days.
- Same canonical URL from two feeds dedupes with priority **REGULATORY_TRACKING > COMPETITOR_OFFICIAL > COMPETITOR_PODCAST**.

Add a competitor by appending a `companies[]` object with its own `feeds[]`. Reuse parser ids (`sumsub-next-news`, `sumsub-next-media`, `sumsub-next-podcast`) only when the site exposes the same Next.js `__NEXT_DATA__` shape; otherwise use `generic-blog-list` / `rss-list` or add a targeted parser in `scripts/prepare.js`.

For podcast transcripts, prefer an episode page or RSS item with an audio URL and `ASSEMBLYAI_API_KEY`; use `parser: podcast-rss` for real podcast RSS feeds (RSS `<guid>` → pod2txt / enclosure audio → AssemblyAI), `parser: moodys-podcast-page` for Moody’s official podcast pages, or `parser: youtube-channel-rss` only for direct YouTube channels.

---

## OpenClaw cron (reference)

Use an explicit channel and target (see OpenClaw docs). Message body should tell the agent to run **Step 2–6** of this skill with `$SKILL_ROOT` set to this skill’s absolute path.

---

## Codex CLI

Symlink or copy the skill directory to `~/.codex/skills/follow-competitor/` so Codex discovers it; behavior is identical—only the host path changes.

---

## Limits and tuning (`config.json`)

Optional `limits`:

- `maxDetailFetchesPerRun` (default 20) — caps episode page fetches + PDF downloads per run.
- `maxYoutubeTranscriptsPerRun` (default 5) — caps successful transcript pulls.

---

## Legal / etiquette

Respect Sumsub’s terms, robots directives, and reasonable request rates. This skill uses lightweight `fetch` + listing JSON; do not parallel-bomb the origin.
