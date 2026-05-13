#!/usr/bin/env node
/**
 * follow-competitor — prepare
 * Fetches listing pages (Sumsub Next.js __NEXT_DATA__), applies date windows,
 * URL dedupe + incremental seenUrls, article bodies for official/regulatory items, PDF text,
 * YouTube captions (multi-strategy).
 *
 * Usage:
 *   node prepare.js              # JSON to stdout, writes ~/.follow-competitor/last-batch.json
 *   node prepare.js --finalize   # merge last batch URLs into state.seenUrls
 *
 * Env (optional):
 *   YT_DLP_PATH — path to yt-dlp when not on PATH; enables subtitle download fallback.
 *   FOLLOW_COMPETITOR_DISABLE_YTDLP=1 — skip yt-dlp even if installed.
 *   POD2TXT_API_KEY — same as follow-builders `generate-feed.js`: RSS episode → pod2txt API
 *     transcript (reliable when `sources.json` company has `podcastRssUrl`).
 */

import { readFile, writeFile, mkdir, readdir, rm, mkdtemp } from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir, tmpdir } from 'os';
import { createRequire } from 'module';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');
const dotenv = require('dotenv');

async function loadYoutubeTranscript() {
  const mod = await import(
    new URL('./node_modules/youtube-transcript/dist/youtube-transcript.esm.js', import.meta.url)
  );
  return mod.fetchTranscript;
}

const SKILL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES_PATH = join(SKILL_ROOT, 'sources.json');
const PROMPTS_DIR = join(SKILL_ROOT, 'prompts');
const LOCAL_X_FEED_PATH = join(SKILL_ROOT, 'feed-x.json');
const LOCAL_PODCAST_FEED_PATH = join(SKILL_ROOT, 'feed-podcasts.json');
const DEFAULT_X_FEED_URL = 'https://raw.githubusercontent.com/YoheeYang/follow-competitor/main/feed-x.json';
const DEFAULT_PODCAST_FEED_URL = 'https://raw.githubusercontent.com/YoheeYang/follow-competitor/main/feed-podcasts.json';

const USER_DIR = process.env.FOLLOW_COMPETITOR_USER_DIR
  ? process.env.FOLLOW_COMPETITOR_USER_DIR
  : join(homedir(), '.follow-competitor');
const CONFIG_PATH = join(USER_DIR, 'config.json');
const STATE_PATH = join(USER_DIR, 'state.json');
const LAST_BATCH_PATH = join(USER_DIR, 'last-batch.json');

dotenv.config({ path: join(USER_DIR, '.env') });

const CATEGORY_RANK = {
  REGULATORY_TRACKING: 0,
  COMPETITOR_OFFICIAL: 1,
  COMPETITOR_PODCAST: 2,
  NEWS: 3,
  MEDIA: 4,
  PODCAST: 5,
};

const ARTICLE_LIKE_CATEGORIES = new Set([
  'COMPETITOR_OFFICIAL',
  'REGULATORY_TRACKING',
  'NEWS',
  'MEDIA',
]);

const PODCAST_CATEGORIES = new Set(['COMPETITOR_PODCAST', 'PODCAST']);

const POD2TXT_BASE = 'https://pod2txt.vercel.app/api';
const ASSEMBLYAI_BASE = 'https://api.assemblyai.com';

const KYC_RELEVANCE_RE =
  /\b(kyc|kyb|aml|cdd|edd|idv|identity|verification|verify|verifier|onboarding|due diligence|money laundering|financial crime|fraud|scam|risk|compliance|regulat|sanction|screening|monitoring|synthetic|deepfake|fake id|document|biometric|age assurance|bank|fintech|payment|crypto|vasp|igaming|gaming|casino|trust and safety)\b/i;

const IRRELEVANT_OFFICIAL_RE =
  /\b(world health day|mental health|well-?being|wellbeing|healthy habits|employee spotlight|team culture|life at|meet our|appoints|appointment|people news)\b/i;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const RSS_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return fallback;
  }
}

async function loadPrompt(name) {
  const p = join(PROMPTS_DIR, name);
  if (!existsSync(p)) return '';
  return readFile(p, 'utf-8');
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'follow-competitor/1.0',
      Accept: 'application/json,*/*',
      'Cache-Control': 'no-cache',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

async function loadCentralXFeed(url) {
  if (url) {
    try {
      const remote = await fetchJson(url);
      return { feed: remote, source: url, error: null };
    } catch (e) {
      const local = await loadJson(LOCAL_X_FEED_PATH, null);
      if (local) return { feed: local, source: LOCAL_X_FEED_PATH, error: `Remote X feed failed: ${e.message}` };
      return { feed: null, source: url, error: `Remote X feed failed: ${e.message}` };
    }
  }
  const local = await loadJson(LOCAL_X_FEED_PATH, null);
  return { feed: local, source: local ? LOCAL_X_FEED_PATH : null, error: local ? null : 'No X feed configured' };
}

async function loadCentralPodcastFeed(url) {
  if (url) {
    try {
      const remote = await fetchJson(url);
      return { feed: remote, source: url, error: null };
    } catch (e) {
      const local = await loadJson(LOCAL_PODCAST_FEED_PATH, null);
      if (local) return { feed: local, source: LOCAL_PODCAST_FEED_PATH, error: `Remote podcast feed failed: ${e.message}` };
      return { feed: null, source: url, error: `Remote podcast feed failed: ${e.message}` };
    }
  }
  const local = await loadJson(LOCAL_PODCAST_FEED_PATH, null);
  return { feed: local, source: local ? LOCAL_PODCAST_FEED_PATH : null, error: local ? null : 'No podcast feed configured' };
}

function parseNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
  if (!m) return null;
  return JSON.parse(m[1]);
}

/**
 * Sumsub listing URIs are not always the public canonical path (many /news/* and /spotlight/*
 * 404 unless prefixed with /media/…; bare /slug/ often lives under /blog/slug/).
 */
function sumsubCanonicalArticleUrl(baseUrl, uri, category) {
  if (!uri) return null;
  if (uri.startsWith('http')) return uri;
  const base = (baseUrl || 'https://sumsub.com').replace(/\/$/, '');
  const path = uri.startsWith('/') ? uri : `/${uri}`;

  if (category === 'PODCAST' && path.startsWith('/podcasts/')) {
    const slug = path.replace(/^\/podcasts\//, '').replace(/\/$/, '');
    return `${base}/blog/podcast/${slug}/`;
  }
  if (path.startsWith('/news/')) {
    const rest = path.replace(/^\/news\//, '');
    return `${base}/media/news/${rest.endsWith('/') ? rest : `${rest}/`}`;
  }
  if (path.startsWith('/spotlight/')) {
    const rest = path.replace(/^\/spotlight\//, '');
    return `${base}/media/spotlight/${rest.endsWith('/') ? rest : `${rest}/`}`;
  }
  if (path.startsWith('/media/') || path.startsWith('/blog/')) {
    return new URL(path, base).href;
  }
  if (/^\/[^/]+\/?$/.test(path)) {
    const slug = path.replace(/^\//, '').replace(/\/$/, '');
    return `${base}/blog/${slug}/`;
  }
  return new URL(path, base).href;
}

function normalizeDate(isoLike) {
  if (!isoLike) return null;
  const s = String(isoLike).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) {
    return `${s}Z`;
  }
  return s;
}

function parseLooseDate(text) {
  if (!text) return null;
  const match = String(text).match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),\s+(20\d{2})\b/i,
  );
  if (!match) return null;
  const parsed = new Date(`${match[1]} ${match[2]}, ${match[3]} 00:00:00 UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function withinWindow(iso, windowDays) {
  const d = new Date(normalizeDate(iso) || iso);
  if (Number.isNaN(d.getTime())) return false;
  const now = Date.now();
  const start = now - windowDays * 24 * 60 * 60 * 1000;
  return d.getTime() >= start && d.getTime() <= now + 24 * 60 * 60 * 1000;
}

function excerptFromNewsPost(post) {
  const a = post?.postCustom?.anonce;
  if (a && typeof a === 'string') return a.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return '';
}

function guestsLine(pod) {
  const guests = pod?.podcasts?.guests;
  if (!Array.isArray(guests) || guests.length === 0) return '';
  return guests
    .map((g) => g?.title)
    .filter(Boolean)
    .join('; ');
}

function parseNewsListing(html, company) {
  const data = parseNextData(html);
  const posts = data?.props?.pageProps?.posts;
  if (!Array.isArray(posts)) return [];
  return posts.map((post) => ({
    companyId: company.id,
    category: 'NEWS',
    title: post.title,
    uri: post.uri,
    publishedAt: normalizeDate(post.dateGmt),
    excerpt: excerptFromNewsPost(post),
  }));
}

function parseMediaListing(html, company) {
  const data = parseNextData(html);
  const pp = data?.props?.pageProps;
  if (!pp) return [];
  const latest = Array.isArray(pp.latestPost) ? pp.latestPost : [];
  const initial = Array.isArray(pp.initialPosts) ? pp.initialPosts : [];
  const byId = new Map();
  for (const post of [...latest, ...initial]) {
    if (!post?.id) continue;
    byId.set(post.id, {
      companyId: company.id,
      category: 'MEDIA',
      title: post.title,
      uri: post.uri,
      publishedAt: normalizeDate(post.dateGmt),
      excerpt: excerptFromNewsPost(post),
    });
  }
  return [...byId.values()];
}

function parsePodcastListing(html, company) {
  const data = parseNextData(html);
  const pods = data?.props?.pageProps?.podcasts;
  if (!Array.isArray(pods)) return [];
  return pods.map((p) => ({
    companyId: company.id,
    category: 'PODCAST',
    title: p.title,
    uri: p.uri,
    publishedAt: normalizeDate(p.date),
    excerpt: guestsLine(p),
  }));
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

function stripHtmlToText(html) {
  if (!html || typeof html !== 'string') return '';
  const noScript = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const text = noScript
    .replace(/<[^>]+>/g, ' ')
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
  return text;
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

function canonicalUrl(baseUrl, uri) {
  if (!uri) return null;
  try {
    return new URL(uri, baseUrl).href.split('#')[0];
  } catch {
    return null;
  }
}

function walkJson(value, visit) {
  if (!value || typeof value !== 'object') return;
  visit(value);
  if (Array.isArray(value)) {
    for (const child of value) walkJson(child, visit);
    return;
  }
  for (const child of Object.values(value)) walkJson(child, visit);
}

function jsonLdBlocks(html) {
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    try {
      blocks.push(JSON.parse(match[1]));
    } catch {
      /* ignore malformed JSON-LD */
    }
  }
  return blocks;
}

function parseGenericBlogListing(html, company, feed) {
  const rows = [];
  const seen = new Set();
  const baseUrl = company.baseUrl || feed.listUrl;
  const includeRe = feed.includePathPattern ? new RegExp(feed.includePathPattern, 'i') : null;
  const excludeRe = feed.excludePathPattern ? new RegExp(feed.excludePathPattern, 'i') : null;
  const includeTitleRe = feed.includeTitlePattern ? new RegExp(feed.includeTitlePattern, 'i') : null;
  const excludeTitleRe = feed.excludeTitlePattern ? new RegExp(feed.excludeTitlePattern, 'i') : null;

  function cleanAnchorTitle(raw) {
    let title = stripHtmlToText(raw);
    title = title
      .replace(/^Blog Posts\s+[A-Z][a-z]+\s+\d{1,2},\s+\d{4}\s+/i, '')
      .replace(/\s+View$/, '')
      .trim();
    if (/^(Read more|View|Get the Playbook|Try for free|Talk to us)$/i.test(title)) return '';
    return title.length > 220 ? `${title.slice(0, 217).trim()}...` : title;
  }

  function add(row) {
    const url = canonicalUrl(baseUrl, row.url || row.uri);
    if (!url || seen.has(url)) return;
    const title = decodeHtmlEntities(row.title || row.headline || '');
    if (includeTitleRe && !includeTitleRe.test(title)) return;
    if (excludeTitleRe && excludeTitleRe.test(title)) return;
    let path = '';
    try {
      path = new URL(url).pathname;
    } catch {
      return;
    }
    if (includeRe && !includeRe.test(path)) return;
    if (excludeRe && excludeRe.test(path)) return;
    seen.add(url);
    rows.push({
      companyId: company.id,
      category: 'ARTICLE',
      title,
      uri: url,
      publishedAt: normalizeDate(row.publishedAt || row.datePublished || row.dateModified),
      excerpt: decodeHtmlEntities(row.excerpt || row.description || ''),
    });
  }

  for (const block of jsonLdBlocks(html)) {
    walkJson(block, (node) => {
      const type = Array.isArray(node['@type']) ? node['@type'].join(' ') : node['@type'];
      if (!/(Article|BlogPosting|NewsArticle|Report)/i.test(String(type || ''))) return;
      add({
        url: node.url || node.mainEntityOfPage?.['@id'] || node.mainEntityOfPage,
        title: node.headline || node.name,
        publishedAt: node.datePublished || node.dateModified,
        excerpt: node.description,
      });
    });
  }

  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(html)) !== null) {
    const href = match[1];
    const url = canonicalUrl(baseUrl, href);
    if (!url || seen.has(url)) continue;
    let path = '';
    try {
      path = new URL(url).pathname;
    } catch {
      continue;
    }
    if (includeRe && !includeRe.test(path)) continue;
    if (!includeRe && !/(\/blog\/|\/resources\/|\/resource\/|\/news\/|\/latest-news\/)/i.test(path)) continue;
    if (excludeRe && excludeRe.test(path)) continue;
    if (/(\/page\/\d+\/?$|\/tag\/|\/tags\/|\/category\/|\/author\/|\/topic=|\/search|\/resources\/?$|\/blog\/?$)/i.test(url)) continue;
    const rawAnchorText = stripHtmlToText(match[2]);
    const publishedAt = parseLooseDate(rawAnchorText);
    const title = cleanAnchorTitle(match[2]);
    if (!title || title.length < 8) continue;
    if (includeTitleRe && !includeTitleRe.test(title)) continue;
    if (excludeTitleRe && excludeTitleRe.test(title)) continue;
    add({ url, title, publishedAt });
  }

  return rows.slice(0, Number(feed.maxItems || 8));
}

function extractGenericArticleText(html) {
  for (const block of jsonLdBlocks(html)) {
    let found = '';
    walkJson(block, (node) => {
      if (found) return;
      const type = Array.isArray(node['@type']) ? node['@type'].join(' ') : node['@type'];
      if (!/(Article|BlogPosting|NewsArticle|Report)/i.test(String(type || ''))) return;
      if (typeof node.articleBody === 'string') found = decodeHtmlEntities(node.articleBody);
      else if (typeof node.description === 'string') found = decodeHtmlEntities(node.description);
    });
    if (found.length > 200) return found;
  }

  const bodyMatch =
    html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i) ||
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : html;
  return stripHtmlToText(bodyHtml);
}

function extractPageTitle(html) {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const title = h1 ? stripHtmlToText(h1[1]) : stripHtmlToText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  return title
    .replace(/\s+[|–-]\s+(Trulioo|Persona|Jumio|Veriff|Sumsub).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractPagePublishedAt(html) {
  for (const block of jsonLdBlocks(html)) {
    let found = null;
    walkJson(block, (node) => {
      if (found) return;
      const type = Array.isArray(node['@type']) ? node['@type'].join(' ') : node['@type'];
      if (!/(Article|BlogPosting|NewsArticle|Report|PodcastEpisode)/i.test(String(type || ''))) return;
      found = node.datePublished || node.dateModified || node.uploadDate || null;
    });
    if (found) return normalizeDate(found);
  }

  const metaMatch =
    html.match(/<meta\b[^>]*(?:property|name)=["'](?:article:published_time|date|publishdate|pubdate|datePublished)["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:article:published_time|date|publishdate|pubdate|datePublished)["'][^>]*>/i);
  if (metaMatch?.[1]) return normalizeDate(metaMatch[1]);

  const timeMatch = html.match(/<time\b[^>]*datetime=["']([^"']+)["'][^>]*>/i);
  if (timeMatch?.[1]) return normalizeDate(timeMatch[1]);

  return parseLooseDate(stripHtmlToText(html).slice(0, 2000));
}

function extractSumsubArticleText(html) {
  const data = parseNextData(html);
  const content = data?.props?.pageProps?.post?.content;
  if (typeof content !== 'string' || !content.trim()) return '';
  return stripHtmlToText(content);
}

function extractArticleText(html) {
  return extractSumsubArticleText(html) || extractGenericArticleText(html);
}

function isRelevantOfficialItem(item) {
  if (!ARTICLE_LIKE_CATEGORIES.has(item.category)) return true;
  const haystack = [
    item.title,
    item.excerpt,
    item.articleText,
    item.pdfText,
    ...(Array.isArray(item.defaultTags) ? item.defaultTags : []),
  ]
    .filter(Boolean)
    .join(' ');

  if (IRRELEVANT_OFFICIAL_RE.test(haystack)) return false;
  return KYC_RELEVANCE_RE.test(haystack);
}

function isWithinConfiguredWindow(item) {
  if (!ARTICLE_LIKE_CATEGORIES.has(item.category)) return true;
  const windowDays = Number(item.feedWindowDays || 7);
  if (item.publishedAt) return withinWindow(item.publishedAt, windowDays);
  return item.acceptUndated !== false;
}

const YT_PATTERNS = [
  /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
  /youtube\.com\/watch\?[^\"']*v=([a-zA-Z0-9_-]{11})/,
  /youtu\.be\/([a-zA-Z0-9_-]{11})/,
];

function firstYoutubeId(html) {
  if (!html) return null;
  for (const re of YT_PATTERNS) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

function firstAudioUrl(html) {
  if (!html) return null;
  const patterns = [
    /https?:\/\/[^"'<>\s]+\.mp3[^"'<>\s]*/i,
    /https?:\/\/[^"'<>\s]+\.m4a[^"'<>\s]*/i,
    /https?:\/\/[^"'<>\s]+\.wav[^"'<>\s]*/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeHtmlEntities(m[0]);
  }
  return null;
}

/** Parse RSS `<item>` blocks (same shape as follow-builders `generate-feed.js`). */
function parseRssFeed(xml) {
  const episodes = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const block = itemMatch[1];
    const titleMatch =
      block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || block.match(/<title>([\s\S]*?)<\/title>/);
    const title = titleMatch ? titleMatch[1].trim() : 'Untitled';
    const guidMatch =
      block.match(/<guid[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/guid>/) || block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
    const guid = guidMatch ? guidMatch[1].trim() : null;
    const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const publishedAt = pubDateMatch ? new Date(pubDateMatch[1].trim()).toISOString() : null;
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
    const link = linkMatch ? linkMatch[1].trim() : null;
    const enclosureMatch = block.match(/<enclosure\b[^>]*url=["']([^"']+)["'][^>]*>/i);
    const audioUrl = enclosureMatch ? decodeHtmlEntities(enclosureMatch[1]) : null;
    if (guid) episodes.push({ title, guid, publishedAt, link, audioUrl });
  }
  return episodes;
}

function parsePodcastRssListing(xml, company, feed) {
  return parseRssFeed(xml).map((ep) => ({
    companyId: company.id,
    category: 'PODCAST',
    title: ep.title,
    uri: ep.link || feed.listUrl,
    publishedAt: ep.publishedAt,
    excerpt: company.displayName || company.id,
    podcastGuid: ep.guid,
    podcastRssUrl: feed.listUrl,
    audioUrl: ep.audioUrl,
  }));
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
    const title = rawTitle.replace(/^.*?See episode\s*/i, '').trim() || slugFromPodcastPageUrl(url);
    if (!title || /see episode/i.test(title)) continue;
    seen.add(url);
    rows.push({
      companyId: company.id,
      category: 'PODCAST',
      title,
      uri: url,
      publishedAt: null,
      excerpt: company.displayName || company.id,
    });
  }
  return rows.slice(0, Number(feed.maxItems || 5));
}

function parseRssArticleListing(xml, company) {
  return parseRssFeed(xml).map((ep) => ({
    companyId: company.id,
    category: 'ARTICLE',
    title: ep.title,
    uri: ep.link,
    publishedAt: ep.publishedAt,
    excerpt: '',
  }));
}

function parseYoutubeChannelFeed(xml, company) {
  const rows = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  let entryMatch;
  while ((entryMatch = entryRegex.exec(xml)) !== null) {
    const block = entryMatch[1];
    const videoId =
      block.match(/<yt:videoId>([\s\S]*?)<\/yt:videoId>/)?.[1]?.trim() ||
      block.match(/<id>yt:video:([\s\S]*?)<\/id>/)?.[1]?.trim();
    const title = decodeHtmlEntities(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] || 'Untitled');
    const publishedAt = normalizeDate(block.match(/<published>([\s\S]*?)<\/published>/)?.[1]);
    const link =
      block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/)?.[1] ||
      (videoId ? `https://www.youtube.com/watch?v=${videoId}` : null);
    if (!videoId || !link) continue;
    rows.push({
      companyId: company.id,
      category: 'PODCAST',
      title,
      uri: link,
      publishedAt,
      excerpt: company.displayName || company.id,
      youtubeVideoId: videoId,
      youtubeWatchUrl: `https://www.youtube.com/watch?v=${videoId}`,
    });
  }
  return rows;
}

async function fetchRssText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': RSS_USER_AGENT,
      Accept: 'application/rss+xml, application/xml, text/xml, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  return res.text();
}

/** Ported from follow-builders `scripts/generate-feed.js` — pod2txt async polling. */
async function fetchPod2txtTranscript(rssUrl, guid, apiKey) {
  const maxAttempts = 5;
  const pollInterval = 30_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(`${POD2TXT_BASE}/transcript`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedurl: rssUrl, guid, apikey: apiKey }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { error: `HTTP ${res.status}: ${text.slice(0, 400)}` };
    }

    const data = await res.json();

    if (data.status === 'ready' && data.url) {
      const txtRes = await fetch(data.url);
      if (!txtRes.ok) return { error: `Failed to fetch transcript text: HTTP ${txtRes.status}` };
      const transcript = await txtRes.text();
      return { transcript };
    }

    if (data.status === 'processing') {
      console.error(
        `      pod2txt: processing (attempt ${attempt}/${maxAttempts}), waiting ${pollInterval / 1000}s...`,
      );
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, pollInterval));
      }
      continue;
    }

    return { error: data.message || `Unexpected status: ${data.status}` };
  }

  return { error: 'Timed out waiting for transcript processing' };
}

async function fetchAssemblyAiTranscript(audioUrl, apiKey) {
  const maxAttempts = Number(process.env.ASSEMBLYAI_POLL_ATTEMPTS || 20);
  const pollInterval = Number(process.env.ASSEMBLYAI_POLL_INTERVAL_MS || 15_000);

  const submit = await fetch(`${ASSEMBLYAI_BASE}/v2/transcript`, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ audio_url: audioUrl, speech_models: ['universal-2'] }),
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
      return { error: `poll HTTP ${res.status}: ${text.slice(0, 400)}` };
    }
    const data = await res.json();
    if (data.status === 'completed') {
      return { transcript: String(data.text || '').trim(), id: created.id };
    }
    if (data.status === 'error') {
      return { error: data.error || 'AssemblyAI transcription failed', id: created.id };
    }
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, pollInterval));
  }

  return { error: `Timed out waiting for AssemblyAI transcript (${created.id})`, id: created.id };
}

function slugFromPodcastPageUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    return (parts[parts.length - 1] || '').toLowerCase();
  } catch {
    return '';
  }
}

function findRssEpisodeForPodcastItem(item, episodes) {
  const slug = slugFromPodcastPageUrl(item.url);
  const vid = item.youtubeVideoId;
  const title = (item.title || '').trim().toLowerCase();

  for (const ep of episodes) {
    if (!ep.guid) continue;
    const link = (ep.link || '').toLowerCase();
    const epTitle = (ep.title || '').trim().toLowerCase();
    if (vid && link.includes(vid)) return ep;
    if (slug && link.includes(slug)) return ep;
    if (title && epTitle === title) return ep;
    if (title && epTitle && epTitle.length > 12 && (title.includes(epTitle) || epTitle.includes(title))) {
      return ep;
    }
  }
  return null;
}

async function tryPdfText(url, maxBytes = 12_000_000) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`PDF GET ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) {
    return { text: '', error: `PDF too large (${buf.length} bytes)` };
  }
  const parsed = await pdfParse(buf);
  const text = (parsed.text || '').replace(/\s+/g, ' ').trim();
  return { text: text.slice(0, 80_000), error: null };
}

async function tryYoutubeTranscriptLib(videoId, fetchTranscript) {
  const attempts = [
    undefined,
    { lang: 'en' },
    { lang: 'en-US' },
    { lang: 'a.en' },
    { lang: 'zh-Hans' },
    { lang: 'zh' },
  ];
  const errors = [];
  for (const cfg of attempts) {
    try {
      const chunks = await fetchTranscript(videoId, cfg);
      if (!Array.isArray(chunks) || chunks.length === 0) continue;
      const text = chunks
        .map((c) => c.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) return { text: text.slice(0, 80_000), source: cfg?.lang || 'default' };
    } catch (e) {
      errors.push(`${cfg?.lang || 'default'}: ${e.message || String(e)}`);
    }
  }
  return { text: '', source: null, error: errors.slice(0, 3).join(' | ') };
}

function parseVttSrv3ToText(raw) {
  if (!raw) return '';
  const lines = raw.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (/^\d+$/.test(line.trim())) continue;
    if (line.includes('-->')) continue;
    if (line.startsWith('WEBVTT') || line.startsWith('NOTE')) continue;
    const t = line.replace(/<[^>]+>/g, '').trim();
    if (t) out.push(t);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

async function tryYtDlpAutoSubs(videoId) {
  if (process.env.FOLLOW_COMPETITOR_DISABLE_YTDLP === '1') {
    return { text: '', error: 'Skipped because FOLLOW_COMPETITOR_DISABLE_YTDLP=1.' };
  }
  const bin = process.env.YT_DLP_PATH || 'yt-dlp';
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const dir = await mkdtemp(join(tmpdir(), 'fc-yt-'));
  try {
    const outBase = join(dir, 'sub');
    await execFile(
      bin,
      [
        '--no-playlist',
        '--skip-download',
        '--write-auto-sub',
        '--write-sub',
        '--sub-langs',
        'en.*,en,zh-Hans.*,zh-Hans,all',
        '--sub-format',
        'srv3/best/vtt/best',
        '-o',
        outBase,
        videoUrl,
      ],
      { timeout: 120_000, windowsHide: true },
    );
    const files = await readdir(dir);
    const sub = files.find((f) => /\.(vtt|srv3|json3|ttml)$/i.test(f));
    if (!sub) return { text: '', error: 'yt-dlp completed but wrote no subtitle file.' };
    const raw = await readFile(join(dir, sub), 'utf-8');
    const text = parseVttSrv3ToText(raw);
    return { text: text.slice(0, 80_000), error: text ? null : 'yt-dlp subtitle file was empty after parsing.' };
  } catch (e) {
    return { text: '', error: e.code === 'ENOENT' ? 'yt-dlp not found on PATH; install yt-dlp or set YT_DLP_PATH.' : e.message };
  } finally {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function pushCentralXFeedItems(raw, feed, feedSource) {
  for (const account of feed?.x || []) {
    for (const t of account.tweets || []) {
      if (!t?.url || !t?.text) continue;
      if (t.createdAt && !withinWindow(t.createdAt, Number(account.windowDays || 3))) continue;
      raw.push({
        companyId: account.companyId || account.handle || account.name,
        category: 'REGULATORY_TRACKING',
        rawCategory: 'X',
        feedId: 'central_regulatory_x',
        sourceGroup: 'regulatory',
        sourceAuthority: 'regulator_social',
        defaultTags: account.defaultTags || [],
        title: `@${account.handle}: ${String(t.text).slice(0, 110)}${String(t.text).length > 110 ? '...' : ''}`,
        url: t.url,
        publishedAt: normalizeDate(t.createdAt),
        excerpt: t.text,
        assetType: 'social',
        tweetText: t.text,
        xHandle: account.handle,
        xAuthorName: account.name,
        xBio: account.bio || '',
        xMetrics: {
          likes: t.likes || 0,
          reposts: t.reposts || t.retweets || 0,
          replies: t.replies || 0,
        },
        centralFeedSource: feedSource,
      });
    }
  }
}

function pushCentralPodcastFeedItems(raw, feed, feedSource) {
  for (const p of feed?.podcasts || []) {
    if (!p?.url || !p?.title) continue;
    raw.push({
      companyId: p.companyId || p.seriesId || p.name || 'podcast',
      category: 'COMPETITOR_PODCAST',
      rawCategory: 'PODCAST',
      feedId: 'central_podcast_feed',
      sourceGroup: 'podcast',
      sourceAuthority: 'central_transcript_feed',
      defaultTags: p.defaultTags || [],
      title: p.title,
      url: p.url,
      publishedAt: normalizeDate(p.publishedAt),
      excerpt: p.excerpt || p.name || '',
      assetType: 'audio',
      audioUrl: p.audioUrl,
      transcript: p.transcript,
      transcriptSource: p.transcriptSource || 'central-feed',
      assemblyAiTranscriptId: p.assemblyAiTranscriptId,
      centralFeedSource: feedSource,
    });
  }
}

function dedupeByUrlPreferCategory(items) {
  const best = new Map();
  for (const it of items) {
    const prev = best.get(it.url);
    if (!prev) {
      best.set(it.url, it);
      continue;
    }
    const rA = CATEGORY_RANK[it.category] ?? 99;
    const rB = CATEGORY_RANK[prev.category] ?? 99;
    if (rA < rB) best.set(it.url, it);
  }
  return [...best.values()];
}

async function main() {
  const finalize = process.argv.includes('--finalize');
  await mkdir(USER_DIR, { recursive: true });

  if (finalize) {
    const state = await loadJson(STATE_PATH, { seenUrls: [] });
    const batch = await loadJson(LAST_BATCH_PATH, null);
    if (!batch?.items) {
      console.error('No last-batch.json or empty items; nothing to finalize.');
      process.exit(1);
    }
    const seen = new Set(state.seenUrls || []);
    for (const it of batch.items) {
      if (it.url) seen.add(it.url);
    }
    state.seenUrls = [...seen];
    state.lastFinalizedAt = new Date().toISOString();
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
    process.stdout.write(JSON.stringify({ ok: true, seenCount: seen.size }, null, 2) + '\n');
    return;
  }

  const sources = await loadJson(SOURCES_PATH, { companies: [] });
  const config = await loadJson(CONFIG_PATH, {
    language: 'en',
    digestDepth: 'detailed',
    delivery: { method: 'stdout' },
    limits: {
      maxDetailFetchesPerRun: 35,
      maxYoutubeTranscriptsPerRun: 8,
      maxPod2txtEpisodesPerRun: 5,
      maxArticleTextChars: 120_000,
    },
  });
  const state = await loadJson(STATE_PATH, { seenUrls: [] });
  const seen = new Set(state.seenUrls || []);
  const errors = [];

  const limits = {
    maxDetailFetchesPerRun: config.limits?.maxDetailFetchesPerRun ?? 35,
    maxYoutubeTranscriptsPerRun: config.limits?.maxYoutubeTranscriptsPerRun ?? 8,
    maxPod2txtEpisodesPerRun: config.limits?.maxPod2txtEpisodesPerRun ?? 5,
    maxArticleTextChars: config.limits?.maxArticleTextChars ?? 120_000,
  };

  const prompts = {
    digest_intro: await loadPrompt('digest-intro.md'),
    summarize_items: await loadPrompt('summarize-items.md'),
  };

  const raw = [];
  const xFeedUrl = sources.centralFeeds?.regulatoryX || DEFAULT_X_FEED_URL;
  const centralX = await loadCentralXFeed(xFeedUrl);
  if (centralX.feed) {
    pushCentralXFeedItems(raw, centralX.feed, centralX.source);
  } else if (centralX.error) {
    errors.push(centralX.error);
  }
  const podcastFeedUrl = sources.centralFeeds?.podcasts || DEFAULT_PODCAST_FEED_URL;
  const centralPodcasts = await loadCentralPodcastFeed(podcastFeedUrl);
  if (centralPodcasts.feed) {
    pushCentralPodcastFeedItems(raw, centralPodcasts.feed, centralPodcasts.source);
  } else if (centralPodcasts.error) {
    errors.push(centralPodcasts.error);
  }

  for (const company of sources.companies || []) {
    const baseUrl = company.baseUrl || 'https://sumsub.com';
    for (const feed of company.feeds || []) {
      let rows = [];
      try {
        if (feed.parser === 'podcast-rss') {
          const xml = await fetchRssText(feed.listUrl);
          rows = parsePodcastRssListing(xml, company, feed);
        } else if (feed.parser === 'youtube-channel-rss') {
          const xml = await fetchRssText(feed.listUrl);
          rows = parseYoutubeChannelFeed(xml, company);
        } else if (feed.parser === 'rss-list') {
          const xml = await fetchRssText(feed.listUrl);
          rows = parseRssArticleListing(xml, company);
        } else {
          const html = await fetchText(feed.listUrl);
          if (feed.parser === 'sumsub-next-news') {
            rows = parseNewsListing(html, company);
          } else if (feed.parser === 'sumsub-next-media') {
            rows = parseMediaListing(html, company);
          } else if (feed.parser === 'sumsub-next-podcast') {
            rows = parsePodcastListing(html, company);
          } else if (feed.parser === 'generic-blog-list') {
            rows = parseGenericBlogListing(html, company, feed);
          } else if (feed.parser === 'moodys-podcast-page') {
            rows = parseMoodysPodcastPage(html, company, feed);
          } else {
            errors.push(`Unknown parser for ${company.id}/${feed.id || feed.listUrl}: ${feed.parser}`);
            continue;
          }
        }
      } catch (e) {
        errors.push(`Feed failed for ${company.id}/${feed.id || feed.listUrl}: ${e.message}`);
        continue;
      }
      if (feed.maxItems) rows = rows.slice(0, Number(feed.maxItems));
      const windowDays = Number(feed.windowDays) || 7;
      for (const row of rows) {
        if (!row.uri) continue;
        if (row.publishedAt && !withinWindow(row.publishedAt, windowDays)) continue;
        const url =
          feed.parser?.startsWith('sumsub-')
            ? sumsubCanonicalArticleUrl(baseUrl, row.uri, row.category)
            : canonicalUrl(baseUrl, row.uri);
        if (!url) continue;
        raw.push({
          companyId: row.companyId,
          category: feed.category || row.category,
          rawCategory: row.category,
          feedId: feed.id,
          sourceGroup: feed.sourceGroup || company.sourceGroup,
          sourceAuthority: feed.sourceAuthority || company.sourceAuthority,
          defaultTags: feed.defaultTags || [],
          title: row.title,
          url,
          publishedAt: row.publishedAt,
          feedWindowDays: windowDays,
          acceptUndated: feed.acceptUndated !== false,
          excerpt: row.excerpt || '',
          assetType: url.split('?')[0].toLowerCase().endsWith('.pdf') ? 'pdf' : 'web',
          ...(row.tweetText ? { tweetText: row.tweetText } : {}),
          ...(row.xHandle ? { xHandle: row.xHandle } : {}),
          ...(row.xAuthorName ? { xAuthorName: row.xAuthorName } : {}),
          ...(row.xBio ? { xBio: row.xBio } : {}),
          ...(row.xMetrics ? { xMetrics: row.xMetrics } : {}),
          ...(row.podcastGuid ? { podcastGuid: row.podcastGuid } : {}),
          ...(row.podcastRssUrl ? { podcastRssUrl: row.podcastRssUrl } : {}),
          ...(row.audioUrl ? { audioUrl: row.audioUrl } : {}),
          ...(row.youtubeVideoId ? { youtubeVideoId: row.youtubeVideoId } : {}),
          ...(row.youtubeWatchUrl ? { youtubeWatchUrl: row.youtubeWatchUrl } : {}),
        });
      }
    }
  }

  const windowed = dedupeByUrlPreferCategory(raw);
  let fresh = windowed.filter((it) => !seen.has(it.url));

  let detailFetches = 0;
  let ytDone = 0;

  for (const it of fresh) {
    if (!ARTICLE_LIKE_CATEGORIES.has(it.category)) continue;
    if (it.assetType === 'pdf') continue;
    if (detailFetches >= limits.maxDetailFetchesPerRun) break;
    detailFetches += 1;
    try {
      const pageHtml = await fetchText(it.url);
      const articleText = extractArticleText(pageHtml);
      if (!it.publishedAt) {
        const pagePublishedAt = extractPagePublishedAt(pageHtml);
        if (pagePublishedAt) it.publishedAt = pagePublishedAt;
      }
      if (articleText) {
        it.articleText = articleText.slice(0, limits.maxArticleTextChars);
        const pageTitle = extractPageTitle(pageHtml);
        if (pageTitle && ['ARTICLE', 'MEDIA', 'NEWS'].includes(it.rawCategory)) {
          it.title = pageTitle;
        }
      } else {
        it.articleFetchNote =
          'No post.content found in __NEXT_DATA__ (unexpected template or paywall).';
      }
    } catch (e) {
      it.articleError = e.message;
    }
  }

  const beforeWindowFilter = fresh.length;
  fresh = fresh.filter(isWithinConfiguredWindow);
  const filteredOutOfWindow = beforeWindowFilter - fresh.length;

  const beforeRelevanceFilter = fresh.length;
  fresh = fresh.filter(isRelevantOfficialItem);
  const filteredIrrelevant = beforeRelevanceFilter - fresh.length;

  for (const it of fresh) {
    if (it.assetType === 'pdf' && detailFetches < limits.maxDetailFetchesPerRun) {
      detailFetches += 1;
      try {
        const { text, error } = await tryPdfText(it.url);
        it.pdfText = text;
        if (error) it.pdfError = error;
      } catch (e) {
        it.pdfError = e.message;
      }
    }
  }

  /** follow-builders style: company.podcastRssUrl + POD2TXT_API_KEY → pod2txt */
  const pod2txtApiKey = process.env.POD2TXT_API_KEY;
  const assemblyAiApiKey = process.env.ASSEMBLYAI_API_KEY;
  const rssByCompany = new Map();
  for (const co of sources.companies || []) {
    const rss =
      typeof co.podcastRssUrl === 'string'
        ? co.podcastRssUrl.trim()
        : typeof co.transcriptRssUrl === 'string'
          ? co.transcriptRssUrl.trim()
          : '';
    if (!rss || !pod2txtApiKey) continue;
    try {
      const xml = await fetchRssText(rss);
      const episodes = parseRssFeed(xml);
      rssByCompany.set(co.id, episodes);
      console.error(`      RSS: loaded ${episodes.length} item(s) for company ${co.id}`);
    } catch (e) {
      rssByCompany.set(co.id, { fetchError: e.message });
      console.error(`      RSS fetch failed (${co.id}): ${e.message}`);
    }
  }

  let ytFetchTranscript = null;
  if (fresh.some((it) => PODCAST_CATEGORIES.has(it.category))) {
    try {
      ytFetchTranscript = await loadYoutubeTranscript();
    } catch {
      ytFetchTranscript = null;
    }
  }

  let pod2txtUsed = 0;

  for (const it of fresh) {
    if (!PODCAST_CATEGORIES.has(it.category)) continue;

    const company = (sources.companies || []).find((c) => c.id === it.companyId);
    const rssUrl =
      typeof it.podcastRssUrl === 'string'
        ? it.podcastRssUrl.trim()
        : typeof company?.podcastRssUrl === 'string'
          ? company.podcastRssUrl.trim()
          : typeof company?.transcriptRssUrl === 'string'
            ? company.transcriptRssUrl.trim()
            : '';
    const rssEpisodes = rssByCompany.get(it.companyId);

    if (
      rssUrl &&
      pod2txtApiKey &&
      (it.podcastGuid || Array.isArray(rssEpisodes)) &&
      pod2txtUsed < limits.maxPod2txtEpisodesPerRun
    ) {
      const ep = it.podcastGuid
        ? { guid: it.podcastGuid, link: it.url, title: it.title }
        : findRssEpisodeForPodcastItem(it, rssEpisodes);
      if (ep?.link) {
        const vidFromLink = firstYoutubeId(ep.link);
        if (vidFromLink) {
          it.youtubeVideoId = vidFromLink;
          it.youtubeWatchUrl = `https://www.youtube.com/watch?v=${vidFromLink}`;
        }
      }
      if (ep?.audioUrl) it.audioUrl = ep.audioUrl;
      if (ep) {
        pod2txtUsed += 1;
        const result = await fetchPod2txtTranscript(rssUrl, ep.guid, pod2txtApiKey);
        if (result.transcript) {
          it.transcript = result.transcript.slice(0, 80_000);
          it.transcriptSource = 'pod2txt';
          it.pod2txtGuid = ep.guid;
        } else if (result.error) {
          it.pod2txtError = result.error;
          it.transcriptAttempts = [...(it.transcriptAttempts || []), `pod2txt: ${result.error}`];
        }
      } else if (!ep && rssUrl) {
        it.transcriptAttempts = [...(it.transcriptAttempts || []), `pod2txt: no matching RSS episode in ${rssUrl}`];
      }
    }

    if (detailFetches >= limits.maxDetailFetchesPerRun) {
      it.transcriptNote = `${it.transcriptNote || ''} Skipped episode page fetch (maxDetailFetchesPerRun).`.trim();
      continue;
    }

    detailFetches += 1;
    try {
      const pageHtml = await fetchText(it.url);
      const pageTitle = extractPageTitle(pageHtml);
      if (pageTitle) it.title = pageTitle;
      const audioUrl = firstAudioUrl(pageHtml);
      if (audioUrl) it.audioUrl = audioUrl;
      const vid = firstYoutubeId(pageHtml) || it.youtubeVideoId;
      if (vid) {
        it.youtubeVideoId = vid;
        it.youtubeWatchUrl = `https://www.youtube.com/watch?v=${vid}`;
      }

      if (!it.transcript && it.audioUrl && assemblyAiApiKey) {
        const assembly = await fetchAssemblyAiTranscript(it.audioUrl, assemblyAiApiKey);
        if (assembly.transcript) {
          it.transcript = assembly.transcript.slice(0, 80_000);
          it.transcriptSource = 'assemblyai';
          it.assemblyAiTranscriptId = assembly.id;
        } else if (assembly.error) {
          it.transcriptAttempts = [...(it.transcriptAttempts || []), `assemblyai: ${assembly.error}`];
          if (assembly.id) it.assemblyAiTranscriptId = assembly.id;
        }
      } else if (!it.transcript && it.audioUrl && !assemblyAiApiKey) {
        it.transcriptAttempts = [...(it.transcriptAttempts || []), 'assemblyai: ASSEMBLYAI_API_KEY not set'];
      }

      if (!it.transcript && vid && ytFetchTranscript && ytDone < limits.maxYoutubeTranscriptsPerRun) {
        const lib = await tryYoutubeTranscriptLib(vid, ytFetchTranscript);
        if (lib.text) {
          it.transcript = lib.text;
          it.transcriptSource = `youtube-transcript:${lib.source || 'ok'}`;
          ytDone += 1;
        } else if (lib.error) {
          it.transcriptAttempts = [...(it.transcriptAttempts || []), `youtube-transcript: ${lib.error}`];
        }
      }
      if (!it.transcript && vid) {
        const ytdlp = await tryYtDlpAutoSubs(vid);
        if (ytdlp.text) {
          it.transcript = ytdlp.text;
          it.transcriptSource = 'yt-dlp';
          ytDone += 1;
        } else if (ytdlp.error) {
          it.transcriptAttempts = [...(it.transcriptAttempts || []), `yt-dlp: ${ytdlp.error}`];
        }
      }
      if (!it.transcript) {
        const bits = [
          'No transcript yet.',
          pod2txtApiKey
            ? ''
            : 'Optional: set POD2TXT_API_KEY when a podcast/transcript RSS fallback is configured (same stack as follow-builders central feed).',
          assemblyAiApiKey
            ? ''
            : 'Optional: set ASSEMBLYAI_API_KEY when a podcast page or RSS exposes an audio URL.',
          'Also: youtube-transcript + optional yt-dlp on PATH / YT_DLP_PATH.',
          'YouTube Data API key alone cannot download captions without OAuth.',
        ].filter(Boolean);
        it.transcriptNote = bits.join(' ');
      }
    } catch (e) {
      it.detailError = e.message;
    }
  }

  const batch = {
    meta: {
      skill: 'follow-competitor',
      generatedAt: new Date().toISOString(),
    },
    config,
    prompts,
    items: fresh,
    stats: {
      listingRows: raw.length,
      afterDedupe: windowed.length,
      newItems: fresh.length,
      filteredOutOfWindow,
      filteredIrrelevant,
    },
    errors: errors.length > 0 ? errors : undefined,
  };

  state.lastPrepareAt = batch.meta.generatedAt;
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
  await writeFile(LAST_BATCH_PATH, JSON.stringify(batch, null, 2), 'utf-8');

  process.stdout.write(JSON.stringify(batch, null, 2) + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
