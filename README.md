# follow-competitor

从配置的公开网页（默认 Sumsub 媒体/新闻/播客列表）按时间窗抓取条目，由 **当前对话里宿主产品选用的模型** 将 JSON 素材写成 Markdown 竞品摘要，并通过 **飞书自建应用（Open API）** 或终端投递。

> **模型说明：**本 skill **不指定、不切换** 写摘要用的 LLM。Markdown 由 Cursor / Codex / OpenClaw 等 **当前会话所选模型** 生成；若要固定某模型，请在对应产品里切换聊天模型或 Agent 配置，而非改 `config.json`。

---

## 用什么话「唤醒」配置或运行？

在对话里直接说下面任意一类即可让 Agent 套用本 skill（具体取决于 Cursor 是否已加载该 skill；若未命中，可点名「按 follow-competitor 的 SKILL.md 执行」）：

| 场景 | 建议说法（中英文均可） |
|------|------------------------|
| **首次初始化 / 飞书应用配置** | 「配置 follow-competitor」「初始化竞品监控 skill」「设置飞书 app 发竞品摘要」「setup follow-competitor with Feishu app」 |
| **只改投递或语言** | 「改 follow-competitor 的飞书接收群」「把 digest 语言改成中文」 |
| **跑一次摘要** | 「跑竞品摘要」「执行 follow-competitor 抓取」「competitor digest」「/competitor」 |

**Agent 行为约定：**用户用「配置 follow-competitor」等**首次初始化**类语句唤醒时，**先展示下方「初始化要填什么」表格**（留空处请用户填写或二选一），**不要**用大段教程代替逐项确认。完整流程与边界见 [`SKILL.md`](SKILL.md)。

---

## 初始化要填什么（填空清单）

路径默认 **`~/.follow-competitor`**；可用环境变量 **`FOLLOW_COMPETITOR_USER_DIR`** 指向其他目录。

### 通用

| 项 | 用户填写 / 选择 |
|----|-----------------|
| 用户数据目录 | 默认 `~/.follow-competitor`，或：`________________` |
| `config.json` 模板 | 自 `config/config.example.json`（Webhook）或 `config/config.example.feishu-app.json`（应用）复制 |

### `config.json`（非密钥）

| 项 | 用户填写 / 选择 |
|----|-----------------|
| `delivery.method` | `stdout` / `feishu_webhook` / `feishu_app`：`______` |
| `language`（摘要语言） | `en` / `zh`：`______` |
| `digestDepth` | `simple` / `detailed`：`______` |
| `delivery.feishuApiBase`（飞书投递时） | `https://open.feishu.cn` 或 `https://open.larksuite.com`：`______` |
| `onboardingComplete` | 全部就绪后设为 `true` |

### 仅 `feishu_webhook`

| 项 | 用户填写 / 选择 |
|----|-----------------|
| `delivery.feishuWebhookUrl` **或** `.env` → `FEISHU_WEBHOOK_URL` | `________________` |

### 仅 `feishu_app`

| 项 | 用户填写 / 选择 |
|----|-----------------|
| `.env` → `FEISHU_APP_ID` | `________________` |
| `.env` → `FEISHU_APP_SECRET` | `________________` |
| 可选 `.env` → `FEISHU_API_BASE` | 不填则与 `delivery.feishuApiBase` 一致 |
| `delivery.feishuReceiveIdType` | 群一般为 `chat_id`：`______` |
| `delivery.feishuReceiveId`（如群 `oc_…`） | `________________` |
| 飞书开放平台（勾选/确认） | 机器人 + `im:message` / `im:message:send_as_bot`（以控制台为准）+ 发版 + **机器人已进群** |

### 可选

| 项 | 用户填写 / 选择 |
|----|-----------------|
| `platform` | `openclaw` / `other`：`______` |
| `timezone` / `frequency` / `deliveryTime`（或周报 `weeklyDay`） | `________________` |
| `limits.*` | 默认一般够用；若要改：`________________` |
| 监管 X 抓取 | 普通用户不需要 token；中央 `feed-x.json` 由 `scripts/generate-feed.js` 在 GitHub Actions 中用 repo secret `X_BEARER_TOKEN` 生成。需要你提供：目标 GitHub 仓库地址/权限、可写入 Actions Secret 的 `X_BEARER_TOKEN`、是否沿用 `sources.json` 里的 FATF/FinCEN 账号清单 |
| 播客文稿转写 | GitHub Secret → `ASSEMBLYAI_API_KEY`：`______`。GitHub Actions 会生成中央 `feed-podcasts.json`；日常 `prepare.js` 只读取 feed，不需要本地 key。备选本地 `.env` 仍可放 `ASSEMBLYAI_API_KEY` |

### 跑通后一步

| 项 | 说明 |
|----|------|
| `node prepare.js --finalize` | 成功投递后执行，写入 `state.seenUrls`，避免重复摘要 |

---

## 安装后执行顺序（速查）

1. `mkdir -p ~/.follow-competitor`（或你的 `FOLLOW_COMPETITOR_USER_DIR`）。  
2. 复制 `config/config.example*.json` → `~/.follow-competitor/config.json`，按 **「初始化要填什么」** 表格填空；字段说明见 [`config/config-schema.json`](config/config-schema.json)。  
3. `feishu_app` 时建 `~/.follow-competitor/.env` 写入 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`（勿提交 git）。  
4. 按 [`SKILL.md`](SKILL.md)：`prepare.js` → 写 Markdown → `deliver.js` → 成功后 `prepare.js --finalize`。  
5. Webhook / 开放平台操作细节：**仍以 [`SKILL.md`](SKILL.md) 的 Feishu option A/B 为准**。

---

## 正文抓取、链接与 YouTube 字幕

- **COMPETITOR_OFFICIAL：**`prepare.js` 会进入**可打开的 canonical 链接**，抽取正文得到 **`articleText`**，供模型做全文级摘要（不再只用列表摘要）。Sumsub 仍使用 `__NEXT_DATA__`；Trulioo / Jumio / Veriff 走通用 blog/RSS parser，窗口为 7 天。Persona 因自动抓取返回 403，暂不纳入。抓取层会过滤与 KYC / AML / KYB / IDV / fraud / compliance / regulatory 无关的官源内容，例如雇主品牌、员工健康、纯公司文化内容。
- **链接 404：**Sumsub 列表里的 `uri` 常见为 `/news/...`、`/spotlight/...` 或根路径 `/某slug/`，直接拼在 `sumsub.com` 根下会 404；脚本已按路径类型改写为 **`/media/news/...`、`/media/spotlight/...`、`/blog/...`** 等形式，摘要里请使用 JSON 中的 **`url`** 字段（已是修正后地址）。
- **REGULATORY_TRACKING：**FATF / FinCEN 按 `follow-builders` 模式走中央 feed：`scripts/generate-feed.js` 在可信环境用 **`X_BEARER_TOKEN`** 生成 `feed-x.json`，日常 `prepare.js` 只读取公开/本地 feed。JSON 中会包含 `tweetText`、`xHandle`、`xMetrics`，摘要只总结 tweet 内容，不额外生成销售话术。
- **YouTube / 播客文稿（对齐 follow-builders）：**`follow-builders` 的 `prepare-digest.js` 只消费中央 feed 里**已生成**的 `transcript`。`follow-competitor` 也采用中央化：GitHub Actions 运行 `scripts/generate-feed.js`，用 GitHub Secret **`ASSEMBLYAI_API_KEY`** 抓 Moody’s podcast 页，进入 episode 页提取 `.mp3/.m4a` 音频 URL，调用 AssemblyAI `/v2/transcript`，再写入 `feed-podcasts.json`。日常 `prepare.js` 优先读取中央 `feed-podcasts.json`；本地转写只作为 fallback。
- **分类口径：**当前只使用 **`COMPETITOR_OFFICIAL`**、**`COMPETITOR_PODCAST`**、**`REGULATORY_TRACKING`**。不再使用 `MARKET_SIGNAL`、`KYC_LONGFORM`、`SOCIAL_ALERT`。
- **回退链路：**优先 AssemblyAI 音频转写；未配置 AssemblyAI 或没有音频 URL 时，尝试 pod2txt；再尝试 **`youtube-transcript`** → 本机 **`yt-dlp`**（`PATH` 或 `YT_DLP_PATH`）。若仍无 transcript，则只能保留页面元数据；失败原因会写入 `transcriptAttempts`。
- **YouTube Data API Key：**官方下载字幕需 **OAuth**，API Key **不能**替代 pod2txt；当前不读取 `YOUTUBE_API_KEY`。

---

## 与 Cursor 项目技能同步

若本目录是主副本，安装到 Cursor 项目技能目录：

```bash
rsync -a --delete --exclude=node_modules \
  ./follow-competitor/ ./.cursor/skills/follow-competitor/
cd ./.cursor/skills/follow-competitor/scripts && npm install
```

更多说明见 [`INSTALL.md`](INSTALL.md)。
