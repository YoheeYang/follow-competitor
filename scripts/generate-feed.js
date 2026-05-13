#!/usr/bin/env node
/**
 * follow-competitor — central feed generator
 *
 * Mirrors follow-builders: this script runs in a trusted environment
 * (for example GitHub Actions) with X_BEARER_TOKEN / ASSEMBLYAI_API_KEY and
 * commits feed-x.json / feed-podcasts.json. Normal users run prepare.js, which
 * reads central feeds and does not need API keys.
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(SCRIPT_DIR, '..');
const SOURCES_PATH = join(SKILL_ROOT, 'sources.json');
const FEED_X_PATH = join(SKILL_ROOT, 'feed-x.json');
const FEED_PODCASTS_PATH = join(SKILL_ROOT, 'feed-podcasts.json');
const STATE_FEED_PATH = join(SKILL_ROOT, 'state-feed.json');
const X_API_BASE = 'https://api.x.com/2';
const ASSEMBLYAI_BASE = 'https://api.assemblyai.com';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return fallback;
  }
}

async function fetchXJson(url, bearerToken) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      'User-Agent': 'follow-competitor-feed-generator/1.0',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`X API HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
    },
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.text();
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtmlToText(html) {
  return decodeHtmlEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  );
}

function canonicalUrl(baseUrl, uri) {
  if (!uri) return null;
  try {
    return new URL(uri, baseUrl).href.split('#')[0];
  } catch {
    return null;
  }
}

function normalizeDate(isoLike) {
  if (!isoLike) return null;
  const s = String(isoLike).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) return `${s}Z`;
  return s;
}

function withinWindow(iso, windowDays) {
  const d = new Date(normalizeDate(iso) || iso);
  if (Number.isNaN(d.getTime())) return false;
  const start = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  return d.getTime() >= start && d.getTime() <= Date.now() + 24 * 60 * 60 * 1000;
}

function firstAudioUrl(html) {
  const patterns = [
    /https?:\/\/[^"'<>\s]+\.mp3[^"'<>\s]*/i,
    /https?:\/\/[^"'<>\s]+\.m4a[^"'<>\s]*/i,
    /https?:\/\/[^"'<>\s]+\.wav[^"'<>\s]*/i,
  ];
  for (const re of patterns) {
    const m = String(html || '').match(re);
    if (m) return decodeHtmlEntities(m[0]);
  }
  return null;
}

function extractPageTitle(html) {
  const h1 = String(html || '').match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  return h1 ? stripHtmlToText(h1[1]) : stripHtmlToText(String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
}

function parseMoodysPodcastPage(html, company, feed) {
  const rows = [];
  const seen = new Set();
  const linkRe = /<a\b[^>]*href=["']([^"']*\/insights\/podcasts\/[^"']+\.html)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRe.exec(html)) !== null) {
    const url = canonicalUrl(company.baseUrl || feed.listUrl, match[1]);
    if (!url || seen.has(url)) continue;
    if (feed.includePathPattern) {
      const path = new URL(url).pathname;
      if (!new RegExp(feed.includePathPattern, 'i').test(path)) continue;
    }
    const rawTitle = stripHtmlToText(match[2]);
    const title = rawTitle.replace(/^.*?See episode\s*/i, '').trim();
    if (!title || /see episode/i.test(title)) continue;
    seen.add(url);
    rows.push({
      companyId: company.id,
      name: company.displayName || company.id,
      title,
      url,
      publishedAt: null,
      excerpt: company.displayName || company.id,
      defaultTags: feed.defaultTags || [],
    });
  }
  return rows.slice(0, Number(feed.maxItems || 5));
}

function parseRssFeed(xml) {
  const episodes = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const block = itemMatch[1];
    const titleMatch =
      block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || block.match(/<title>([\s\S]*?)<\/title>/);
    const title = titleMatch ? decodeHtmlEntities(titleMatch[1]) : 'Untitled';
    const guidMatch =
      block.match(/<guid[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/guid>/) || block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
    const guid = guidMatch ? guidMatch[1].trim() : null;
    const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const publishedAt = pubDateMatch ? new Date(pubDateMatch[1].trim()).toISOString() : null;
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
    const link = linkMatch ? linkMatch[1].trim() : null;
    const enclosureMatch = block.match(/<enclosure\b[^>]*url=["']([^"']+)["'][^>]*>/i);
    const audioUrl = enclosureMatch ? decodeHtmlEntities(enclosureMatch[1]) : null;
    const descMatch =
      block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) ||
      block.match(/<description>([\s\S]*?)<\/description>/);
    const excerpt = descMatch ? stripHtmlToText(descMatch[1]).slice(0, 2000) : '';
    if (guid || link) episodes.push({ title, guid, publishedAt, link, audioUrl, excerpt });
  }
  return episodes;
}

async function fetchRssText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/rss+xml, application/xml, text/xml, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
    },
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  return res.text();
}

async function fetchAssemblyAiTranscript(audioUrl, apiKey) {
  const maxAttempts = Number(process.env.ASSEMBLYAI_POLL_ATTEMPTS || 20);
  const pollInterval = Number(process.env.ASSEMBLYAI_POLL_INTERVAL_MS || 15_000);
  const submit = await fetch(`${ASSEMBLYAI_BASE}/v2/transcript`, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_url: audioUrl }),
  });
  if (!submit.ok) {
    const text = await submit.text().catch(() => '');
    return { error: `submit HTTP ${submit.status}: ${text.slice(0, 400)}` };
  }
  const created = await submit.json();
  if (!created.id) return { error: 'submit response missing transcript id' };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(`${ASSEMBLYAI_BASE}/v2/transcript/${created.id}`, {
      headers: { Authorization: apiKey },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { error: `poll HTTP ${res.status}: ${text.slice(0, 400)}`, id: created.id };
    }
    const data = await res.json();
    if (data.status === 'completed') return { transcript: String(data.text || '').trim(), id: created.id };
    if (data.status === 'error') return { error: data.error || 'AssemblyAI transcription failed', id: created.id };
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, pollInterval));
  }
  return { error: `Timed out waiting for AssemblyAI transcript (${created.id})`, id: created.id };
}

async function fetchXContent(accounts, bearerToken, state, errors) {
  const results = [];
  const handles = accounts.map((a) => String(a.handle || '').replace(/^@/, '')).filter(Boolean);
  const userMap = {};

  for (let i = 0; i < handles.length; i += 100) {
    const batch = handles.slice(i, i + 100);
    try {
      const data = await fetchXJson(
        `${X_API_BASE}/users/by?usernames=${batch.join(',')}&user.fields=name,description,username`,
        bearerToken,
      );
      for (const user of data.data || []) {
        userMap[user.username.toLowerCase()] = {
          id: user.id,
          name: user.name,
          description: user.description || '',
        };
      }
      for (const err of data.errors || []) {
        errors.push(`X API: User not found: ${err.value || err.detail}`);
      }
    } catch (e) {
      errors.push(`X API: User lookup failed: ${e.message}`);
    }
  }

  for (const account of accounts) {
    const handle = String(account.handle || '').replace(/^@/, '');
    const user = userMap[handle.toLowerCase()];
    if (!user) continue;

    const windowDays = Number(account.windowDays || 3);
    const startTime = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    const maxResults = Math.max(5, Math.min(100, Number(account.maxResults || account.maxTweets || 10)));

    try {
      const data = await fetchXJson(
        `${X_API_BASE}/users/${user.id}/tweets?` +
          `max_results=${maxResults}` +
          `&tweet.fields=created_at,public_metrics,referenced_tweets,note_tweet` +
          `&exclude=retweets,replies` +
          `&start_time=${encodeURIComponent(startTime)}`,
        bearerToken,
      );

      const tweets = [];
      for (const t of data.data || []) {
        if (state.seenTweets[t.id]) continue;
        if (tweets.length >= Number(account.maxTweets || 5)) break;

        const text = (t.note_tweet?.text || t.text || '').replace(/\s+/g, ' ').trim();
        tweets.push({
          id: t.id,
          text,
          createdAt: t.created_at,
          url: `https://x.com/${handle}/status/${t.id}`,
          likes: t.public_metrics?.like_count || 0,
          reposts: t.public_metrics?.retweet_count || 0,
          replies: t.public_metrics?.reply_count || 0,
          isQuote: t.referenced_tweets?.some((r) => r.type === 'quoted') || false,
          quotedTweetId: t.referenced_tweets?.find((r) => r.type === 'quoted')?.id || null,
        });
        state.seenTweets[t.id] = Date.now();
      }

      if (tweets.length > 0) {
        results.push({
          source: 'x',
          companyId: account.companyId || handle.toLowerCase(),
          name: account.displayName || user.name || handle,
          handle,
          bio: user.description || '',
          windowDays: Number(account.windowDays || 3),
          defaultTags: account.defaultTags || [],
          tweets,
        });
      }
    } catch (e) {
      errors.push(`X API: Failed to fetch @${handle}: ${e.message}`);
    }
  }

  return results;
}

async function fetchPodcastContent(sources, assemblyAiKey, state, errors) {
  const results = [];
  if (!assemblyAiKey) {
    errors.push('ASSEMBLYAI_API_KEY not set; skipping podcast transcripts');
    return results;
  }
  if (!state.seenPodcasts) state.seenPodcasts = {};

  for (const company of sources.companies || []) {
    for (const feed of company.feeds || []) {
      if (!['moodys-podcast-page', 'podcast-rss'].includes(feed.parser)) continue;
      let rows = [];
      try {
        if (feed.parser === 'podcast-rss') {
          const xml = await fetchRssText(feed.listUrl);
          rows = parseRssFeed(xml).map((ep) => ({
            companyId: company.id,
            name: company.displayName || company.id,
            title: ep.title,
            url: ep.link || feed.listUrl,
            publishedAt: ep.publishedAt,
            excerpt: ep.excerpt || company.displayName || company.id,
            audioUrl: ep.audioUrl,
            defaultTags: feed.defaultTags || [],
          }));
        } else {
          const html = await fetchText(feed.listUrl);
          rows = parseMoodysPodcastPage(html, company, feed);
        }
      } catch (e) {
        errors.push(`Podcast: failed to fetch ${company.id}/${feed.id}: ${e.message}`);
        continue;
      }
      if (feed.maxItems) rows = rows.slice(0, Number(feed.maxItems));

      for (const row of rows) {
        if (state.seenPodcasts[row.url]) continue;
        if (row.publishedAt && !withinWindow(row.publishedAt, Number(feed.windowDays || 14))) continue;
        try {
          let audioUrl = row.audioUrl;
          if (!audioUrl) {
            const pageHtml = await fetchText(row.url);
            row.title = extractPageTitle(pageHtml) || row.title;
            audioUrl = firstAudioUrl(pageHtml);
          }
          if (!audioUrl) {
            errors.push(`Podcast: no audio URL found for "${row.title}"`);
            continue;
          }
          const transcript = await fetchAssemblyAiTranscript(audioUrl, assemblyAiKey);
          state.seenPodcasts[row.url] = Date.now();
          if (transcript.error) {
            errors.push(`Podcast: AssemblyAI error for "${row.title}": ${transcript.error}`);
            continue;
          }
          if (!transcript.transcript) continue;
          results.push({
            source: 'podcast',
            companyId: row.companyId,
            name: row.name,
            title: row.title,
            url: row.url,
            publishedAt: row.publishedAt,
            excerpt: row.excerpt,
            audioUrl,
            transcript: transcript.transcript,
            transcriptSource: 'assemblyai',
            assemblyAiTranscriptId: transcript.id,
            defaultTags: row.defaultTags || [],
          });
        } catch (e) {
          errors.push(`Podcast: failed to process "${row.title}": ${e.message}`);
        }
      }
    }
  }

  return results;
}

async function main() {
  const bearerToken = process.env.X_BEARER_TOKEN;
  const assemblyAiKey = process.env.ASSEMBLYAI_API_KEY;

  const sources = await loadJson(SOURCES_PATH, { x_accounts: [] });
  const state = await loadJson(STATE_FEED_PATH, { seenTweets: {}, seenPodcasts: {} });
  if (!state.seenTweets) state.seenTweets = {};
  if (!state.seenPodcasts) state.seenPodcasts = {};
  const errors = [];

  const x = bearerToken ? await fetchXContent(sources.x_accounts || [], bearerToken, state, errors) : [];
  if (!bearerToken) errors.push('X_BEARER_TOKEN not set; skipping X feed');
  const podcasts = await fetchPodcastContent(sources, assemblyAiKey, state, errors);

  const xFeed = {
    generatedAt: new Date().toISOString(),
    x,
    stats: {
      xAccounts: x.length,
      totalTweets: x.reduce((sum, a) => sum + a.tweets.length, 0),
    },
    errors: errors.length > 0 ? errors : undefined,
  };
  const podcastFeed = {
    generatedAt: xFeed.generatedAt,
    podcasts,
    stats: {
      podcastEpisodes: podcasts.length,
    },
    errors: errors.length > 0 ? errors : undefined,
  };

  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(state.seenTweets)) {
    if (ts < cutoff) delete state.seenTweets[id];
  }
  for (const [id, ts] of Object.entries(state.seenPodcasts)) {
    if (ts < cutoff) delete state.seenPodcasts[id];
  }
  state.lastGeneratedAt = xFeed.generatedAt;

  await writeFile(FEED_X_PATH, JSON.stringify(xFeed, null, 2) + '\n', 'utf-8');
  await writeFile(FEED_PODCASTS_PATH, JSON.stringify(podcastFeed, null, 2) + '\n', 'utf-8');
  await writeFile(STATE_FEED_PATH, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  console.error(`feed-x.json: ${xFeed.stats.xAccounts} accounts, ${xFeed.stats.totalTweets} tweets`);
  console.error(`feed-podcasts.json: ${podcastFeed.stats.podcastEpisodes} episodes`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
