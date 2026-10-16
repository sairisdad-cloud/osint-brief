// record_run.mjs: record/inbox の主張を1件取り、公開ページを集めて
// The Record の下書きを書き、dadarecord へ下書き投稿する。
// 世界情勢ブリーフの記事生成とは別。材料に無い事実は書かせない。
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INBOX = join(ROOT, "record", "inbox");
const DONE = join(ROOT, "record", "done");
const WORK = join(ROOT, "record", "work");
const LEDGER = join(ROOT, "record", "ledger.jsonl");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) osint-brief/1.0";
const MAX_PAGES = 6;
const PAGE_CHARS = 3200;

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
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
  return decodeEntities(s)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function claimKey(text) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, "")
    .slice(0, 400);
}

function listInbox() {
  mkdirSync(INBOX, { recursive: true });
  return readdirSync(INBOX)
    .filter((name) => name.endsWith(".md") && !name.startsWith("_") && !name.startsWith("."))
    .map((name) => ({ name, path: join(INBOX, name), mtime: statSync(join(INBOX, name)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);
}

function parseClaim(raw) {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const urls = [];
  const body = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("メモ:") || t.startsWith("メモ：")) continue;
    if (/^https?:\/\/\S+$/.test(t)) urls.push(t);
    else body.push(t);
  }
  return { text: body.join("\n").trim(), urls };
}

function loadLedger() {
  try {
    return readFileSync(LEDGER, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function hostScore(url) {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return 9;
  }
  if (/\.go\.jp$/.test(host) || host.endsWith(".gov") || /\.gov\.[a-z.]+$/.test(host)) return 0;
  if (host.endsWith(".ac.jp") || host.endsWith(".edu")) return 1;
  if (/who\.int$|nih\.gov$|cdc\.gov$|nature\.com$|science\.org$|reuters\.com$|bbc\.(com|co\.uk)$|apnews\.com$/.test(host)) return 2;
  if (host.endsWith("wikipedia.org") || host === "factcheckcenter.jp") return 3;
  if (
    host === "x.com" ||
    /^(x|twitter|facebook|instagram|tiktok|youtube|note|ameblo)\./.test(host) ||
    host.endsWith("hatenablog.com") ||
    host.endsWith("hatenadiary.com") ||
    host.endsWith("hateblo.jp") ||
    host.endsWith("ameblo.jp") ||
    host === "trilltrill.jp"
  ) {
    return 8;
  }
  return 4;
}

function keywords(text) {
  const words = text.match(/[一-龠々]{2,}|[ァ-ヶー]{3,}|[A-Za-z0-9]{3,}/g) || [];
  const uniq = [];
  for (const word of words) {
    if (!uniq.includes(word)) uniq.push(word);
    if (uniq.length >= 4) break;
  }
  return uniq.join(" ");
}

function skipHost(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host === "news.google.com") return false;
    return host === "duckduckgo.com" || host.endsWith(".duckduckgo.com") || host === "google.com" || host.endsWith(".google.com");
  } catch {
    return true;
  }
}

async function searchDuckDuckGo(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return [];
  const body = await res.text();
  const urls = [];
  for (const m of body.matchAll(/class="result__a" href="([^"]+)"/g)) {
    const href = decodeEntities(m[1]);
    const ud = href.match(/[?&]uddg=([^&]+)/);
    if (!ud) continue;
    try {
      urls.push(decodeURIComponent(ud[1]));
    } catch {
      // 壊れたリンクは捨てる
    }
  }
  return urls;
}

async function searchGoogleNews(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ja&gl=JP&ceid=JP:ja`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return [];
  const xml = await res.text();
  const urls = [];
  for (const block of xml.matchAll(/<item[\s\S]*?<\/item>/gi)) {
    const link = block[0].match(/<link>([^<]+)<\/link>/i);
    if (link) urls.push(decodeEntities(link[1].trim()));
  }
  return urls;
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(20000),
    redirect: "follow",
  });
  const finalUrl = res.url || url;
  if (!res.ok || skipHost(finalUrl) || new URL(finalUrl).hostname.replace(/^www\./, "") === "news.google.com") return null;
  const type = res.headers.get("content-type") || "";
  if (/pdf|image|video|audio/i.test(type)) return null;
  const html = await res.text();
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripHtml(titleMatch[1]).slice(0, 120) : finalUrl;
  const text = stripHtml(html).slice(0, PAGE_CHARS);
  if (text.length < 180) return null;
  return { url: finalUrl, title, text };
}

async function collectPages(claim) {
  const slice = claim.text.replace(/\s+/g, " ").slice(0, 80);
  const keys = keywords(claim.text);
  const found = [];
  const queries = [slice, keys ? `${keys} 公式` : `${slice} 公式`];
  for (const q of queries) {
    try {
      found.push(...(await searchDuckDuckGo(q)));
    } catch (e) {
      console.error(`検索をスキップ: ${e.message || e}`);
    }
  }
  try {
    found.push(...(await searchGoogleNews(slice)));
  } catch (e) {
    console.error(`ニュース検索をスキップ: ${e.message || e}`);
  }

  const ranked = [];
  const seen = new Set();
  const push = (url, pinned) => {
    if (!url || skipHost(url) || seen.has(url)) return;
    seen.add(url);
    ranked.push({ url, score: pinned ? -1 : hostScore(url) });
  };
  for (const url of claim.urls) push(url, true);
  for (const url of found) push(url, false);

  const fetched = [];
  const missed = [];
  let attempts = 0;
  for (const item of ranked) {
    if (attempts >= 8) break;
    if (hostScore(item.url) >= 8) continue;
    attempts += 1;
    try {
      const page = await fetchPage(item.url);
      if (!page) {
        missed.push(item.url);
        continue;
      }
      if (fetched.some((p) => p.url === page.url)) continue;
      fetched.push(page);
    } catch (e) {
      missed.push(item.url);
      console.error(`取得できず: ${item.url} (${e.message || e})`);
    }
  }

  const keyList = keys ? keys.split(" ") : [];
  const scored = fetched.map((page) => {
    const hay = `${page.title}\n${page.text}`;
    const hits = keyList.filter((word) => hay.includes(word)).length;
    return { page, hits, host: hostScore(page.url) };
  });
  scored.sort((a, b) => b.hits - a.hits || a.host - b.host);
  const matched = scored.filter((row) => row.hits > 0);
  const pages = (matched.length ? matched : scored).slice(0, MAX_PAGES).map((row) => row.page);
  return { pages, missed };
}

function buildMaterial(claim, pages, missed) {
  const blocks = [
    "主張:",
    claim.text,
    "",
    "届いたリンク（検証の記録ではない）:",
    claim.urls.length ? claim.urls.join("\n") : "なし",
    "",
    "取得できなかったURL:",
    missed.length ? missed.slice(0, 8).join("\n") : "なし",
    "",
  ];
  if (!pages.length) {
    blocks.push("記録:", "なし");
  } else {
    pages.forEach((page, i) => {
      blocks.push(`記録 ${i + 1}`, `URL: ${page.url}`, `題: ${page.title}`, page.text, "");
    });
  }
  return blocks.join("\n");
}

function buildPrompt(material, ledger) {
  const prompt = readFileSync(join(ROOT, "record", "prompts", "article.md"), "utf8");
  const recent = ledger
    .slice(-20)
    .map((row) => `- ${row.title}`)
    .join("\n");
  const prior = recent
    ? `すでに書いた題です。同じ主張の焼き直しは書かず、1行目を DUPLICATE とし、2行目に最も近い題だけを書いて終えてください。\n${recent}`
    : "まだ書いた記事はありません。";
  return `${prompt}\n\n# 既出\n${prior}\n\n# 材料\n${material}`;
}

function stripFence(text) {
  return text
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function allowedUrls(pages) {
  return new Set(pages.map((page) => page.url.replace(/\/$/, "")));
}

function validate(text, claim, pages) {
  const lines = text.split("\n");
  const title = (lines[0] || "").trim();
  if (!title || title.startsWith("#") || title === "DUPLICATE") return "1行目が題でない";
  if ([...title].length > 48) return "題が長すぎる";
  for (const h of [
    "## 1. 届いた主張",
    "## 2. 成り立つために必要なこと",
    "## 3. 記録が示していること",
    "## 4. どこで壊れるか",
    "## 5. まだ記録から言えないこと",
    "## 6. 出典",
  ]) {
    if (!text.includes(h)) return `見出しがない: ${h}`;
  }
  if (/妹|送り主|親族|私の姉|私の弟|私の兄/.test(text)) return "送り主や家族への言及がある";
  if (/<invoke|<function/.test(text)) return "ツール呼び出しタグが混入";
  if (/[\uAC00-\uD7AF\u3130-\u318F]/.test(text)) return "ハングルが混入";
  if ([...text].length < 500 && pages.length) return "出力が短すぎる";
  const allowed = allowedUrls(pages);
  for (const m of text.matchAll(/https?:\/\/[^\s)]+/g)) {
    const url = m[0].replace(/[.,。、]+$/, "").replace(/\/$/, "");
    if (!allowed.has(url)) return `材料にないURL: ${url}`;
  }
  return null;
}

async function callGemini(env, prompt) {
  const model = env.GEMINI_MODEL || "gemini-3.6-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const generationConfig = { temperature: 0.2, maxOutputTokens: 8192 };
  let withThinking = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (withThinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
    else delete generationConfig.thinkingConfig;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig,
        safetySettings: [
          "HARM_CATEGORY_HARASSMENT",
          "HARM_CATEGORY_HATE_SPEECH",
          "HARM_CATEGORY_SEXUALLY_EXPLICIT",
          "HARM_CATEGORY_DANGEROUS_CONTENT",
        ].map((category) => ({ category, threshold: "BLOCK_ONLY_HIGH" })),
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json.error?.message || `HTTP ${res.status}`;
      if (withThinking && /thinking/i.test(msg)) {
        withThinking = false;
        continue;
      }
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    const candidate = json.candidates?.[0];
    const text = stripFence(
      (candidate?.content?.parts || [])
        .filter((part) => part.text && !part.thought)
        .map((part) => part.text)
        .join("")
    );
    if (!text) throw new Error(`応答が空です (finish=${candidate?.finishReason || "none"})`);
    return text;
  }
  throw new Error("生成に失敗しました");
}

function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inlineHtml(s) {
  const parts = [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    parts.push(escapeHtml(s.slice(last, m.index)));
    parts.push(`<a href="${escapeHtml(m[2])}">${escapeHtml(m[1])}</a>`);
    last = m.index + m[0].length;
  }
  parts.push(escapeHtml(s.slice(last)));
  return parts.join("");
}

function bodyToHtml(md) {
  const html = [];
  let list = [];
  const flushList = () => {
    if (!list.length) return;
    html.push(`<ul>\n${list.map((li) => `<li>${inlineHtml(li)}</li>`).join("\n")}\n</ul>`);
    list = [];
  };
  for (const block of md.split(/\n{2,}/)) {
    const lines = block.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (lines.every((l) => l.startsWith("- "))) {
      list.push(...lines.map((l) => l.replace(/^- /, "")));
      continue;
    }
    flushList();
    for (const line of lines) {
      if (line.startsWith("## ")) html.push(`<h2>${inlineHtml(line.slice(3))}</h2>`);
      else if (line.startsWith("# ")) html.push(`<h2>${inlineHtml(line.slice(2))}</h2>`);
      else html.push(`<p>${inlineHtml(line)}</p>`);
    }
  }
  flushList();
  return html.join("\n");
}

async function postDraft(env, article) {
  const domain = env.RECORD_BLOG_DOMAIN || "dadarecord.hatenadiary.com";
  const newline = article.indexOf("\n");
  const title = (newline === -1 ? article : article.slice(0, newline)).replace(/^#+\s*/, "").trim();
  const body = newline === -1 ? "" : article.slice(newline + 1).trim();
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<entry xmlns="http://www.w3.org/2005/Atom" xmlns:app="http://www.w3.org/2007/app">
  <title>${escapeXml(title)}</title>
  <author><name>${escapeXml(env.HATENA_ID)}</name></author>
  <content type="text/html">${escapeXml(bodyToHtml(body))}</content>
  <app:control><app:draft>yes</app:draft></app:control>
</entry>`;
  const endpoint = `https://blog.hatena.ne.jp/${env.HATENA_ID}/${domain}/atom/entry`;
  const auth = Buffer.from(`${env.HATENA_ID}:${env.HATENA_API_KEY}`).toString("base64");
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      Authorization: `Basic ${auth}`,
    },
    body: xml,
  });
  if (res.status !== 200 && res.status !== 201) {
    const errText = await res.text();
    throw new Error(`投稿に失敗しました (HTTP ${res.status}) ${errText.slice(0, 300)}`);
  }
  return { title, location: res.headers.get("location") || "" };
}

function emptyHelp() {
  console.log("record/inbox に主張がありません。");
  console.log("届いた文面を .md で1件置いてから、scripts/record_run.sh を実行してください。");
  console.log("");
  console.log("ファイルの中身は、主張の文と、あればURLを1行に1つです。");
  console.log("送り主の名前は書かないでください。メモ: で始めた行は記事に渡しません。");
}

async function main() {
  const collectOnly = process.argv.includes("--collect-only");
  const files = listInbox();
  if (!files.length) {
    emptyHelp();
    return;
  }

  const file = files[0];
  const claim = parseClaim(readFileSync(file.path, "utf8"));
  if (!claim.text) {
    console.error(`エラー: 主張の文がありません (${file.name})`);
    process.exit(1);
  }

  const ledger = loadLedger();
  const key = claimKey(claim.text);
  const prior = ledger.find((row) => row.claim_key === key);
  if (prior) {
    console.log(`同じ主張が台帳にあります: ${prior.title}`);
    if (prior.entry_url) console.log(prior.entry_url);
    console.log("新規の下書きは作りません。inbox のファイルは残しています。");
    return;
  }

  console.log(`記録を集めています: ${file.name}`);
  const { pages, missed } = await collectPages(claim);
  console.log(`ページ ${pages.length} 件、取得できず ${missed.length} 件`);
  const material = buildMaterial(claim, pages, missed);
  mkdirSync(WORK, { recursive: true });
  writeFileSync(join(WORK, "material.txt"), material, "utf8");
  if (collectOnly) {
    console.log(`材料だけ書きました: ${join(WORK, "material.txt")}`);
    return;
  }
  if (!pages.length) {
    console.error("突き合わせるページが1件も取れませんでした。下書きは作りません。");
    process.exit(1);
  }

  const env = loadEnv(join(ROOT, ".env"));
  for (const name of ["GEMINI_API_KEY", "HATENA_ID", "HATENA_API_KEY"]) {
    if (!env[name]) {
      console.error(`エラー: .env に ${name} がありません`);
      process.exit(1);
    }
  }

  let prompt = buildPrompt(material, ledger);
  let text = "";
  let problem = "生成に失敗しました";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      text = await callGemini(env, prompt);
    } catch (e) {
      problem = e.message || String(e);
      console.error(`生成失敗 (${attempt}回目): ${problem}`);
      continue;
    }
    if (text.startsWith("DUPLICATE")) {
      const title = text.split("\n").map((s) => s.trim()).filter(Boolean)[1] || "(題なし)";
      console.log(`既出と判断しました: ${title}`);
      console.log("新規の下書きは作りません。文面が別の主張なら、inbox のファイルを書き換えて再実行してください。");
      return;
    }
    problem = validate(text, claim, pages);
    writeFileSync(join(WORK, "article.md"), text.endsWith("\n") ? text : `${text}\n`, "utf8");
    if (!problem) break;
    console.error(`検証NG (${attempt}回目): ${problem}`);
    prompt = `${buildPrompt(material, ledger)}\n\n前回の出力は使えません。理由: ${problem}\n材料にないURLや事実を足さず、指定の見出しで書き直してください。`;
    text = "";
  }
  if (!text || problem) {
    console.error(`エラー: 記事生成に失敗しました (${problem})`);
    process.exit(1);
  }

  const posted = await postDraft(env, text);
  const row = {
    at: new Date().toISOString(),
    title: posted.title,
    claim_key: key,
    claim: claim.text.slice(0, 240),
    entry_url: posted.location,
    source_file: file.name,
  };
  appendFileSync(LEDGER, `${JSON.stringify(row)}\n`, "utf8");
  mkdirSync(DONE, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  renameSync(file.path, join(DONE, `${stamp}-${file.name}`));
  console.log(`下書きを作りました: ${posted.title}`);
  if (posted.location) console.log(posted.location);
  if (files.length > 1) console.log(`inbox に残り ${files.length - 1} 件`);
}

main().catch((e) => {
  console.error(`エラー: ${e.message || e}`);
  process.exit(1);
});
