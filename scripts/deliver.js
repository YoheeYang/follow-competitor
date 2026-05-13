#!/usr/bin/env node
/**
 * follow-competitor — delivery
 * Reads ~/.follow-competitor/config.json + .env
 *
 * Methods:
 *   stdout — print digest to stdout
 *   feishu_webhook — custom bot incoming webhook (simplest)
 *   feishu_app — tenant app: tenant_access_token + im/v1/messages (needs chat id)
 *
 * Legacy: delivery.method "feishu" is treated as feishu_webhook.
 *
 * Usage:
 *   node deliver.js --file /path/to/digest.md
 *   cat digest.md | node deliver.js
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { config as loadEnv } from 'dotenv';

const USER_DIR = process.env.FOLLOW_COMPETITOR_USER_DIR
  ? process.env.FOLLOW_COMPETITOR_USER_DIR
  : join(homedir(), '.follow-competitor');
const CONFIG_PATH = join(USER_DIR, 'config.json');
const ENV_PATH = join(USER_DIR, '.env');

const TEXT_CHUNK = 15000;

function normalizeDeliveryMethod(config) {
  const m = config.delivery?.method || 'stdout';
  if (m === 'feishu') return 'feishu_webhook';
  return m;
}

function feishuApiBase(config) {
  const b = config.delivery?.feishuApiBase || process.env.FEISHU_API_BASE || 'https://open.feishu.cn';
  return b.replace(/\/$/, '');
}

async function readDigestText() {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    return readFile(args[fileIdx + 1], 'utf-8');
  }
  const msgIdx = args.indexOf('--message');
  if (msgIdx !== -1 && args[msgIdx + 1]) {
    return args[msgIdx + 1];
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function sendFeishuWebhook(webhookUrl, text) {
  let offset = 0;
  let part = 1;
  const total = Math.ceil(text.length / TEXT_CHUNK) || 1;
  while (offset < text.length) {
    const slice = text.slice(offset, offset + TEXT_CHUNK);
    offset += TEXT_CHUNK;
    const body = {
      msg_type: 'text',
      content: {
        text: total > 1 ? `[Part ${part}/${total}]\n${slice}` : slice,
      },
    };
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`Feishu webhook HTTP ${res.status}: ${raw.slice(0, 500)}`);
    }
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`Feishu webhook non-JSON: ${raw.slice(0, 200)}`);
    }
    if (json.code !== 0) {
      throw new Error(`Feishu error: ${json.msg || JSON.stringify(json)}`);
    }
    part += 1;
  }
}

async function getTenantAccessToken(apiBase, appId, appSecret) {
  const url = `${apiBase}/open-apis/auth/v3/tenant_access_token/internal`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await res.json();
  if (data.code !== undefined && data.code !== 0) {
    throw new Error(`Feishu tenant token failed: ${JSON.stringify(data).slice(0, 400)}`);
  }
  if (!data.tenant_access_token) {
    throw new Error(`Feishu tenant token missing: ${JSON.stringify(data).slice(0, 400)}`);
  }
  return data.tenant_access_token;
}

async function sendFeishuAppMessage(apiBase, token, receiveIdType, receiveId, text) {
  let offset = 0;
  let part = 1;
  const total = Math.ceil(text.length / TEXT_CHUNK) || 1;
  const q = new URLSearchParams({ receive_id_type: receiveIdType });
  const url = `${apiBase}/open-apis/im/v1/messages?${q}`;

  while (offset < text.length) {
    const slice = text.slice(offset, offset + TEXT_CHUNK);
    offset += TEXT_CHUNK;
    const body = {
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({
        text: total > 1 ? `[Part ${part}/${total}]\n${slice}` : slice,
      }),
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`Feishu im message non-JSON: ${raw.slice(0, 300)}`);
    }
    if (data.code !== 0) {
      throw new Error(`Feishu im message: ${data.msg || raw.slice(0, 400)}`);
    }
    part += 1;
  }
}

async function main() {
  loadEnv({ path: ENV_PATH });
  const text = (await readDigestText()).trim();
  if (!text) {
    console.error('deliver.js: empty input');
    process.exit(1);
  }

  let config = { delivery: { method: 'stdout' } };
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
    } catch {
      /* ignore */
    }
  }

  const method = normalizeDeliveryMethod(config);

  if (method === 'stdout') {
    process.stdout.write(text + '\n');
    return;
  }

  if (method === 'feishu_webhook') {
    const webhookUrl =
      config.delivery?.feishuWebhookUrl ||
      process.env.FEISHU_WEBHOOK_URL;
    if (!webhookUrl) {
      console.error(
        'Missing webhook URL: set delivery.feishuWebhookUrl in config.json or FEISHU_WEBHOOK_URL in .env',
      );
      process.exit(1);
    }
    await sendFeishuWebhook(webhookUrl, text);
    return;
  }

  if (method === 'feishu_app') {
    const appId = process.env.FEISHU_APP_ID || config.delivery?.feishuAppId;
    const appSecret = process.env.FEISHU_APP_SECRET || config.delivery?.feishuAppSecret;
    const receiveId =
      config.delivery?.feishuReceiveId || config.delivery?.feishuChatId;
    const receiveIdType = config.delivery?.feishuReceiveIdType || 'chat_id';

    if (!receiveId) {
      console.error(
        'feishu_app: set delivery.feishuReceiveId (or legacy feishuChatId) to the target chat/user open_id.',
      );
      process.exit(1);
    }
    if (!appId || !appSecret) {
      console.error(
        'feishu_app: set FEISHU_APP_ID and FEISHU_APP_SECRET in .env (recommended), or delivery.feishuAppId / feishuAppSecret in config.json.',
      );
      process.exit(1);
    }

    const apiBase = feishuApiBase(config);
    const token = await getTenantAccessToken(apiBase, appId, appSecret);
    await sendFeishuAppMessage(apiBase, token, receiveIdType, receiveId, text);
    return;
  }

  console.error(`Unknown delivery.method: ${method}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
