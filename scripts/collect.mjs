// collect.mjs: sources.json の全フィードを取得し、直近24時間分の記事を
// work/digest.txt にまとめる。依存パッケージなし(Node 18+ の標準fetchのみ)。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_ITEMS_PER_FEED = 15;
const MAX_SUMMARY_CHARS = 300;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30 * 1000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) osint-brief/1.0";

const CATEGORY_LABELS = {
  west: "西側メディア",
  east: "東側・非西側メディア",
  party: "当事国・現地メディア",
  sns: "SNS",
  japan: "日本・経済",
  voice: "追跡する発言",
  trend: "Xのトレンド",
};

// XMLの1要素の中身を取り出す(自前の軽量抽出。属性付きタグにも対応)
function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : "";
}

// Atomの<link href="...">形式にも対応してリンクを取り出す
function extractLink(xml) {
  const plain = extractTag(xml, "link");
  if (plain && !plain.startsWith("<")) return plain;
  const m = xml.match(/<link[^>]*href="([^"]+)"[^>]*\/?>(?:<\/link>)?/i);
  return m ? m[1] : plain;
}

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function stripHtml(s) {
  return decodeEntities(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// RSS2の<item>とAtomの<entry>の両方を配列で返す
function parseItems(xml) {
  const blocks = [
    ...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi),
    ...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi),
  ];
  return blocks.map((m) => {
    const b = m[1];
    const title = stripHtml(extractTag(b, "title"));
    const link = decodeEntities(extractLink(b));
    const dateStr =
      extractTag(b, "pubDate") ||
      extractTag(b, "dc:date") ||
      extractTag(b, "updated") ||
      extractTag(b, "published");
    const summaryRaw =
      extractTag(b, "description") ||
      extractTag(b, "summary") ||
      extractTag(b, "content");
    let summary = stripHtml(summaryRaw);
    if (summary.length > MAX_SUMMARY_CHARS) {
      summary = summary.slice(0, MAX_SUMMARY_CHARS) + "...";
    }
    const date = dateStr ? new Date(dateStr) : null;
    return { title, link, date, summary };
  });
}

async function fetchFeed(feed) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, {
      signal: ctrl.signal,
      headers: { "User-Agent": UA },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    if (!xml.trim()) throw new Error("空のレスポンス");
    const now = Date.now();
    const items = parseItems(xml)
      .filter((it) => it.title)
      .filter((it) => !it.date || now - it.date.getTime() <= WINDOW_MS)
      .slice(0, MAX_ITEMS_PER_FEED);
    return { feed, ok: true, items };
  } catch (e) {
    return { feed, ok: false, error: e.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function loadEnv(path) {
  const env = {};
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
  } catch {
    // .env が無くても RSS 収集は続ける
  }
  return env;
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
}

// 公開チャンネルのプレビュー https://t.me/s/名前 を読む。非公開は対象外。
async function fetchTelegram(channel) {
  const name = String(channel).replace(/^@/, "").replace(/^https?:\/\/t\.me\/s?\//, "").split(/[/?#]/)[0];
  const feed = { name: `Telegram @${name}`, category: "sns", url: `https://t.me/s/${name}` };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, {
      signal: ctrl.signal,
      headers: { "User-Agent": UA },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const now = Date.now();
    const items = html
      .split('class="tgme_widget_message_wrap')
      .slice(1)
      .map((block) => {
        const post = block.match(/data-post="([^"]+)"/);
        const time = block.match(/datetime="([^"]+)"/);
        const text = block.match(/js-message_text"[^>]*>([\s\S]*?)tgme_widget_message_date/);
        if (!post || !time || !text) return null;
        const date = new Date(time[1]);
        let summary = htmlToText(text[1]);
        if (!summary) return null;
        const title = summary.length > 80 ? `${summary.slice(0, 80)}...` : summary;
        if (summary.length > MAX_SUMMARY_CHARS) summary = `${summary.slice(0, MAX_SUMMARY_CHARS)}...`;
        return {
          title,
          link: `https://t.me/${post[1]}`,
          date,
          summary,
        };
      })
      .filter((it) => it && it.date && now - it.date.getTime() <= WINDOW_MS)
      .slice(-MAX_ITEMS_PER_FEED)
      .reverse();
    return { feed, ok: true, items };
  } catch (e) {
    return { feed, ok: false, error: e.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// アカウントごとに直近投稿を取る。まとめて検索すると、投稿の多いアカウントが
// 枠を埋め、政府や通信社の投稿が消える。X API の Bearer Token が .env にあるときだけ動く。
async function fetchXAccount(name, token, start, keep = 2) {
  const url = new URL("https://api.x.com/2/tweets/search/recent");
  url.searchParams.set("query", `from:${name} -is:retweet -is:reply`);
  url.searchParams.set("max_results", "10");
  url.searchParams.set("start_time", start);
  url.searchParams.set("tweet.fields", "created_at");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json().catch(() => ({}));
  if (res.status === 429) return { rateLimited: true, items: [] };
  if (!res.ok) {
    const detail = json.detail || json.title || json.error || `HTTP ${res.status}`;
    return { items: [], error: `${name}: ${String(detail).slice(0, 120)}` };
  }
  const items = [];
  for (const post of (json.data || []).slice(0, keep)) {
    const text = (post.text || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    items.push({
      username: name,
      title: text.length > 80 ? `${text.slice(0, 80)}...` : text,
      summary: text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS)}...` : text,
      link: `https://x.com/${name}/status/${post.id}`,
      date: post.created_at ? new Date(post.created_at) : new Date(),
    });
  }
  return { items };
}

async function fetchX(accounts, ignore, token, headline = []) {
  const skip = new Set((ignore || []).map((a) => String(a).replace(/^@/, "").toLowerCase()));
  const more = new Set((headline || []).map((a) => String(a).replace(/^@/, "").toLowerCase()));
  const names = accounts
    .map((a) => String(a).replace(/^@/, ""))
    .filter((name) => name && !skip.has(name.toLowerCase()));
  const feed = { name: "X", category: "sns", url: "https://api.x.com/2/tweets/search/recent" };
  if (!token) {
    return { feed, ok: false, error: "X_BEARER_TOKEN が未設定" };
  }
  if (names.length === 0) return { feed, ok: true, items: [] };

  const start = new Date(Date.now() - WINDOW_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
  const items = [];
  const errors = [];
  try {
    for (let i = 0; i < names.length; i += 4) {
      const batch = names.slice(i, i + 4);
      const results = await Promise.all(
        batch.map((name) => fetchXAccount(name, token, start, more.has(name.toLowerCase()) ? 8 : 2))
      );
      if (results.some((r) => r.rateLimited)) {
        errors.push("X APIの回数制限に達したため、残りのアカウントは次回に回します");
        break;
      }
      for (const r of results) {
        if (r.error) errors.push(r.error);
        items.push(...r.items);
      }
    }
    if (items.length === 0 && errors.length) {
      return { feed, ok: false, error: errors.slice(0, 3).join(" / ") };
    }
    if (errors.length) console.log(`Xの一部をスキップ: ${errors.slice(0, 3).join(" / ")}`);
    return { feed, ok: true, items };
  } catch (e) {
    return { feed, ok: false, error: e.message || String(e) };
  }
}

function jsonUnescape(s) {
  return JSON.parse(`"${s}"`);
}

function isRecentAgo(label) {
  if (!label) return false;
  if (/(分|時間)前/.test(label)) return true;
  const day = label.match(/(\d+)\s*日前/);
  return !!(day && Number(day[1]) <= 1);
}

function isShortClip(duration, label) {
  if (label && label.includes("ショート")) return true;
  if (!duration) return false;
  const parts = duration.split(":").map(Number);
  if (parts.some((n) => Number.isNaN(n))) return false;
  const sec = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
  return sec > 0 && sec < 180;
}

function parseChannelVideos(html) {
  const items = [];
  for (const part of html.split('"lockupViewModel":{').slice(1)) {
    const title = part.match(/"title":\{"content":"((?:\\.|[^"\\])*)"/);
    const ago = part.match(/"text":\{"content":"(\d+\s*(?:分|時間|日)前)"\}/);
    const id = part.match(/"videoId":"([A-Za-z0-9_-]{11})"/);
    const duration = part.match(/"text":"(\d+:\d+(?::\d+)?)"/);
    if (!title || !id || !ago) continue;
    items.push({
      title: jsonUnescape(title[1]),
      videoId: id[1],
      ago: ago[1],
      duration: duration ? duration[1] : "",
      label: "",
    });
  }
  return items;
}

function parseSearchVideos(html) {
  const items = [];
  for (const part of html.split('"videoRenderer":{').slice(1, 30)) {
    const id = part.match(/"videoId":"([A-Za-z0-9_-]{11})"/);
    const title = part.match(/"title":\{"runs":\[\{"text":"((?:\\.|[^"\\])*)"/);
    const label = part.match(/"accessibilityData":\{"label":"((?:\\.|[^"\\])*)"/);
    if (!id || !title) continue;
    const labelText = label ? jsonUnescape(label[1]) : "";
    const ago = (labelText.match(/(\d+\s*(?:分|時間|日)前)/) || [])[1] || "";
    items.push({
      title: jsonUnescape(title[1]),
      videoId: id[1],
      ago,
      duration: "",
      label: labelText,
    });
  }
  return items;
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": UA, "Accept-Language": "ja" },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// 佐藤優、井川意高など、名前を指定した発言だけを直近分残す。
async function fetchVoices(voices) {
  const feeds = [];
  for (const voice of voices || []) {
    const name = voice.name || "";
    const match = voice.match || name;
    const feed = { name, category: "voice", url: voice.news || "" };
    const items = [];
    const seen = new Set();
    const seenTitles = new Set();
    const errors = [];
    const push = (title, link, summary) => {
      const key = title.replace(/\s+-\s+[^-]+$/, "").trim();
      if (!title || !link || seen.has(link) || seenTitles.has(key)) return;
      if (!title.includes(match) && !(summary || "").includes(match)) return;
      seen.add(link);
      seenTitles.add(key);
      items.push({ title, link, summary: summary || "" });
    };
    if (voice.news) {
      try {
        const news = await fetchFeed({ name, category: "voice", url: voice.news });
        if (!news.ok) throw new Error(news.error);
        for (const it of news.items) {
          if (!it.title.includes(match)) continue;
          if (/\bvs\b/i.test(it.title)) continue;
          push(it.title, it.link, it.summary);
        }
      } catch (e) {
        errors.push(e.message || String(e));
      }
    }
    for (const ch of voice.youtubeChannels || []) {
      try {
        const html = await fetchText(`https://www.youtube.com/channel/${ch.id}/videos`);
        for (const v of parseChannelVideos(html)) {
          if (!isRecentAgo(v.ago) || isShortClip(v.duration, v.label)) continue;
          if (ch.requireMatch && !v.title.includes(match)) continue;
          const link = `https://www.youtube.com/watch?v=${v.videoId}`;
          const summary = `${ch.name}。${v.ago}。${name}の発言として扱う。`;
          if (ch.requireMatch) push(v.title, link, summary);
          else if (!seen.has(link)) {
            seen.add(link);
            items.push({ title: v.title, link, summary });
          }
        }
      } catch (e) {
        errors.push(`${ch.name}: ${e.message || e}`);
      }
    }
    if (voice.youtubeSearch) {
      try {
        const q = encodeURIComponent(voice.youtubeSearch);
        const html = await fetchText(`https://www.youtube.com/results?search_query=${q}&sp=EgIIAw%3D%3D`);
        for (const v of parseSearchVideos(html)) {
          if (!v.title.includes(match) || !isRecentAgo(v.ago) || isShortClip("", v.label)) continue;
          push(v.title, `https://www.youtube.com/watch?v=${v.videoId}`, `YouTube。${v.ago}。${name}の発言として扱う。`);
        }
      } catch (e) {
        errors.push(e.message || String(e));
      }
    }
    if (items.length === 0 && errors.length) {
      feeds.push({ feed, ok: false, error: errors.join(" / ") });
    } else {
      if (errors.length) console.log(`${name}の一部をスキップ: ${errors.join(" / ")}`);
      feeds.push({ feed, ok: true, items: items.slice(0, 8) });
    }
  }
  return feeds;
}


async function fetchXTrends(token, woeid = "23424856") {
  const feed = {
    name: "Xのトレンド（日本）",
    category: "trend",
    url: `https://api.x.com/2/trends/by/woeid/${woeid}`,
  };
  if (!token) return { feed, ok: false, error: "X_BEARER_TOKEN が未設定" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, {
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${token}`, "User-Agent": UA },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const items = (json.data || []).slice(0, 20).map((trend, index) => {
      const name = trend.trend_name || "";
      return {
        title: `${index + 1}. ${name}`,
        link: `https://x.com/search?q=${encodeURIComponent(name)}&src=trend_click&f=live`,
        summary: `日本のXトレンド、順位${index + 1}`,
      };
    });
    return { feed, ok: true, items };
  } catch (e) {
    return { feed, ok: false, error: e.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const sources = JSON.parse(readFileSync(join(ROOT, "sources.json"), "utf8"));
  const env = loadEnv(join(ROOT, ".env"));
  const results = await Promise.all(sources.feeds.map(fetchFeed));
  const telegram = Array.isArray(sources.telegram) ? sources.telegram : [];
  const xAccounts = Array.isArray(sources.xAccounts) ? sources.xAccounts : [];
  const snsResults = [];
  if (telegram.length) {
    snsResults.push(...(await Promise.all(telegram.map(fetchTelegram))));
  }
  if (xAccounts.length) {
    snsResults.push(await fetchX(xAccounts, sources.xIgnore || [], env.X_BEARER_TOKEN || "", sources.xHeadline || []));
  }
  const voiceResults = await fetchVoices(sources.voices || []);
  const trendResults = [await fetchXTrends(env.X_BEARER_TOKEN || "", sources.xTrendWoeid || "23424856")];

  console.log("=== フィード取得結果 ===");
  let okCount = 0;
  for (const r of results) {
    if (r.ok) {
      okCount++;
      console.log(`成功: ${r.feed.name} (${r.items.length}件)`);
    } else {
      console.log(`失敗: ${r.feed.name} (${r.error})`);
    }
  }
  console.log(`合計: ${okCount}/${results.length} フィード成功`);
  for (const r of snsResults) {
    if (r.ok) console.log(`成功: ${r.feed.name} (${r.items.length}件)`);
    else console.log(`失敗: ${r.feed.name} (${r.error})`);
  }
  for (const r of voiceResults) {
    if (r.ok) console.log(`成功: 発言 ${r.feed.name} (${r.items.length}件)`);
    else console.log(`失敗: 発言 ${r.feed.name} (${r.error})`);
  }
  for (const r of trendResults) {
    if (r.ok) console.log(`成功: ${r.feed.name} (${r.items.length}件)`);
    else console.log(`失敗: ${r.feed.name} (${r.error})`);
  }

  const allResults = results.concat(snsResults, voiceResults, trendResults);
  const totalItems = allResults.reduce((n, r) => n + (r.ok ? r.items.length : 0), 0);
  if (totalItems === 0) {
    console.error("エラー: 全フィードで記事が0件のため digest.txt を生成しません");
    process.exit(1);
  }

  const lines = [];
  const nowJst = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  lines.push(`収集日時(日本時間): ${nowJst}`);
  lines.push("以下は直近24時間の各メディアの記事一覧(タイトル・要約・URL)。");
  lines.push("");
  for (const cat of ["west", "east", "party", "sns", "japan", "voice", "trend"]) {
    lines.push(`==== ${CATEGORY_LABELS[cat]} ====`);
    for (const r of allResults) {
      if (!r.ok || r.feed.category !== cat) continue;
      lines.push(`--- ${r.feed.name} ---`);
      for (const it of r.items) {
        lines.push(`[タイトル] ${it.title}`);
        if (it.summary) lines.push(`[要約] ${it.summary}`);
        lines.push(`[URL] ${it.link}`);
        lines.push("");
      }
    }
    lines.push("");
  }

  mkdirSync(join(ROOT, "work"), { recursive: true });
  const outPath = join(ROOT, "work", "digest.txt");
  writeFileSync(outPath, lines.join("\n"), "utf8");
  console.log(`digest.txt を出力しました (${totalItems}件, ${outPath})`);

  // 全フィードの過半が失敗した場合は異常として非0終了(通知で気付けるようにする)
  if (okCount < results.length / 2) {
    console.error("エラー: 失敗フィードが過半数のため異常終了します");
    process.exit(1);
  }
}

if (process.argv.includes("--voices")) {
  const sources = JSON.parse(readFileSync(join(ROOT, "sources.json"), "utf8"));
  const voiceResults = await fetchVoices(sources.voices || []);
  for (const r of voiceResults) {
    console.log(r.ok ? `OK ${r.feed.name} ${r.items.length}件` : `NG ${r.feed.name} ${r.error}`);
    for (const it of r.items || []) console.log(`- ${it.title}\n  ${it.link}`);
  }
} else {
  main();
}
