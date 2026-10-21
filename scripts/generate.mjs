// generate.mjs: work/digest.txt を材料に Gemini で記事を書き、work/article.md に出す。
// Claude Code のサブスクリプションが組織側で無効化されたため、
// ショート動画側と同じ Gemini API キーで生成する。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function buildPrompt() {
  const digest = readFileSync(join(ROOT, "work", "digest.txt"), "utf8");
  if (!digest.trim()) {
    throw new Error("work/digest.txt がないか空です");
  }
  const chunks = [readFileSync(join(ROOT, "prompts", "article.md"), "utf8")];
  for (const name of ["共通の言い回し.md", "style-reference.md", "first-post.md"]) {
    try {
      chunks.push(readFileSync(join(ROOT, "prompts", name), "utf8"));
    } catch {
      // 任意ファイル
    }
  }
  chunks.push("以下が材料テキストです。\n----------------------------------------\n" + digest);
  return chunks.join("\n\n");
}

function stripFence(text) {
  return text
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// 出典URLとNHK記事番号に日があるのに、本文へその日が無い稿は不合格。
// 日がURLに無い項目は、ここでも落とさない。
function missingPublicationDates(text) {
  const source = text.split(/##\s*7\./)[1] || "";
  const body = (text.split(/##\s*7\./)[0] || text).split("\n").slice(1).join("\n");
  const dates = new Set();
  for (const m of source.matchAll(/\/(\d{4})\/(\d{2})\/(\d{2})\//g)) {
    dates.add(`${Number(m[2])}月${Number(m[3])}日`);
  }
  for (const m of source.matchAll(/\/(\d{4})\/([a-z]{3})\/(\d{2})\//gi)) {
    const month = MONTHS[m[2].toLowerCase()];
    if (month) dates.add(`${month}月${Number(m[3])}日`);
  }
  for (const m of source.matchAll(/nd-(\d{4})(\d{2})(\d{2})/g)) {
    dates.add(`${Number(m[2])}月${Number(m[3])}日`);
  }
  return [...dates].filter((day) => !body.includes(day));
}

function trendNamesFromDigest() {
  let digest = "";
  try {
    digest = readFileSync(join(ROOT, "work", "digest.txt"), "utf8");
  } catch {
    return [];
  }
  const section = digest.split("==== Xのトレンド ====")[1] || "";
  return [...section.matchAll(/^\[タイトル\]\s+\d+\.\s+(.+)$/gm)]
    .slice(0, 5)
    .map((m) => m[1].trim().replace(/^#/, ""))
    .filter(Boolean);
}

function missingTrendTitles(text) {
  const body = (text.split(/##\s*7\./)[0] || text);
  return trendNamesFromDigest().filter((name) => !body.includes(name));
}

function trendPlacement(text) {
  if (trendNamesFromDigest().length === 0) return null;
  const body = text.split(/##\s*7\./)[0] || text;
  const trendAt = body.search(/##\s*Xのトレンド/);
  const ch5 = body.search(/##\s*5\./);
  const ch6 = body.search(/##\s*6\./);
  if (trendAt < 0 || !(ch5 < trendAt && trendAt < ch6)) {
    return "Xのトレンドが6章の前に無い";
  }
  const chapter5 = body.slice(ch5, trendAt);
  if (chapter5.includes("Xのトレンドとして")) return "Xのトレンドが5章にある";
  return null;
}

function plainEndings(text) {
  const body = (text.split(/##\s*6\./)[0] || text);
  const bad = [];
  for (const line of body.split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    if (/(?:だ|である|だろう)。$/.test(s)) bad.push(s.slice(0, 30));
  }
  return bad;
}

const MEDIA = "BBC|ガーディアン|NHK|日経新聞|タス通信|ロイター日本語版|ロイター|アルジャジーラ|CGTN|AP通信|アナドル通信|キーウ・インディペンデント|タイペイ・タイムズ";

function repeatedMedia(text) {
  const cut = text.search(/##\s*Xのトレンド|##\s*6\./);
  const body = cut > 0 ? text.slice(0, cut) : text;
  const re = new RegExp(`^(同じく|さらに)?(${MEDIA})`);
  let prev = "";
  let count = 0;
  for (const line of body.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    if (s.startsWith("#")) {
      prev = "";
      count = 0;
      continue;
    }
    const m = s.match(re);
    if (!m) {
      prev = "";
      count = 0;
      continue;
    }
    const prefix = m[1] || "";
    const name = m[2];
    if (name !== prev) {
      prev = name;
      count = 1;
      continue;
    }
    count += 1;
    if (count === 2 && prefix !== "同じく") return `${name}の2件目に同じくが無い`;
    if (count >= 3 && prefix !== "さらに") return `${name}の${count}件目にさらにが無い`;
  }
  return null;
}

function validate(text) {
  const first = text.split("\n", 1)[0] || "";
  if (!first.includes("世界情勢ブリーフ")) return "1行目がタイトル形式でない";
  if (/<invoke|<function/.test(text)) return "ツール呼び出しタグが混入";
  if ([...text].length < 2500) return "出力が短すぎる";
  if (/[\uAC00-\uD7AF\u3130-\u318F]/.test(text)) return "ハングルが混入";
  const missing = missingPublicationDates(text);
  if (missing.length) return `掲載日が本文に無い: ${missing.join("、")}`;
  const trends = missingTrendTitles(text);
  if (trends.length) return `Xのトレンドが本文に無い: ${trends.join("、")}`;
  const placed = trendPlacement(text);
  if (placed) return placed;
  const endings = plainEndings(text);
  if (endings.length) return `だ・である・だろうで終わっている: ${endings[0]}`;
  const media = repeatedMedia(text);
  if (media) return media;
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDemandError(msg) {
  return /high demand|try again later|unavailable|overloaded|resource exhausted|429|503/i.test(msg);
}

async function callGemini(env, prompt, model, withThinkingConfig) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const generationConfig = {
    temperature: 0.4,
    maxOutputTokens: 32768,
  };
  if (withThinkingConfig) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }
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
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  if (json.promptFeedback?.blockReason) {
    throw new Error(`安全フィルタで停止: ${json.promptFeedback.blockReason}`);
  }
  const candidate = json.candidates?.[0];
  const text = stripFence(
    (candidate?.content?.parts || [])
      .filter((part) => part.text && !part.thought)
      .map((part) => part.text)
      .join("")
  );
  if (!text) {
    throw new Error(`応答が空です (finish=${candidate?.finishReason || "none"})`);
  }
  return text;
}

async function main() {
  const env = loadEnv(join(ROOT, ".env"));
  if (!env.GEMINI_API_KEY) {
    console.error("エラー: .env に GEMINI_API_KEY がありません");
    process.exit(1);
  }
  const prompt = buildPrompt();
  const outPath = join(ROOT, "work", "article.md");
  const primary = env.GEMINI_MODEL || "gemini-3.6-flash";
  const models = [primary, "gemini-3.5-flash", "gemini-2.5-flash", "gemini-3.1-flash-lite"]
    .filter((model, index, all) => all.indexOf(model) === index);
  let lastErr = "";
  let useThinkingConfig = true;

  for (const model of models) {
    const tries = model === primary ? 2 : 1;
    for (let attempt = 1; attempt <= tries; attempt++) {
      if (attempt > 1 && isDemandError(lastErr)) {
        console.error(`混雑のため30秒待って再試行: ${model}`);
        await sleep(30000);
      }
      let text;
      try {
        text = await callGemini(env, prompt, model, useThinkingConfig);
      } catch (e) {
        const msg = e.message || String(e);
        if (useThinkingConfig && /thinking/i.test(msg)) {
          useThinkingConfig = false;
          attempt -= 1;
          continue;
        }
        lastErr = msg;
        console.error(`生成失敗 (${model} ${attempt}回目): ${msg}`);
        if (!isDemandError(msg)) break;
        continue;
      }
      const problem = validate(text);
      writeFileSync(outPath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
      if (problem) {
        lastErr = problem;
        console.error(`検証NG (${model} ${attempt}回目): ${problem}`);
        continue;
      }
      console.log(`記事を生成しました (${model}): ${outPath} (${Buffer.byteLength(text)} バイト)`);
      return;
    }
  }

  console.error(`エラー: 記事生成に失敗しました (${lastErr})`);
  process.exit(1);
}

main();
