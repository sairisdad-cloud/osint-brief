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
  japan: "日本・経済",
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

async function main() {
  const sources = JSON.parse(readFileSync(join(ROOT, "sources.json"), "utf8"));
  const results = await Promise.all(sources.feeds.map(fetchFeed));

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

  const totalItems = results.reduce((n, r) => n + (r.ok ? r.items.length : 0), 0);
  if (totalItems === 0) {
    console.error("エラー: 全フィードで記事が0件のため digest.txt を生成しません");
    process.exit(1);
  }

  const lines = [];
  const nowJst = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  lines.push(`収集日時(日本時間): ${nowJst}`);
  lines.push("以下は直近24時間の各メディアの記事一覧(タイトル・要約・URL)。");
  lines.push("");
  for (const cat of ["west", "east", "party", "japan"]) {
    lines.push(`==== ${CATEGORY_LABELS[cat]} ====`);
    for (const r of results) {
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

main();
