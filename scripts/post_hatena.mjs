// post_hatena.mjs: work/article.md を、はてなブログAtomPub APIで
// 下書き(draft=yes)として投稿する。
// 仕様は公式ドキュメントに準拠:
// https://developer.hatena.ne.jp/ja/documents/blog/apis/atom/
// - エンドポイント: POST https://blog.hatena.ne.jp/{はてなID}/{ブログID}/atom/entry
// - 認証: Basic認証(ユーザー名=はてなID、パスワード=APIキー)
// - 下書き: <app:control><app:draft>yes</app:draft></app:control>
// - 成功: 201 Created
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// .env を自前でパースする(依存パッケージなし。値はログに出さない)
function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function escapeXml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function main() {
  const env = loadEnv(join(ROOT, ".env"));
  for (const key of ["HATENA_ID", "HATENA_BLOG_DOMAIN", "HATENA_API_KEY"]) {
    if (!env[key]) {
      console.error(`エラー: .env に ${key} がありません`);
      process.exit(1);
    }
  }

  const article = readFileSync(join(ROOT, "work", "article.md"), "utf8").trim();
  if (!article) {
    console.error("エラー: work/article.md が空です");
    process.exit(1);
  }

  // 1行目をタイトル、残りを本文にする(先頭の見出し記号は取り除く)
  const newline = article.indexOf("\n");
  const title = (newline === -1 ? article : article.slice(0, newline))
    .replace(/^#+\s*/, "")
    .trim();
  const body = newline === -1 ? "" : article.slice(newline + 1).trim();

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<entry xmlns="http://www.w3.org/2005/Atom"
       xmlns:app="http://www.w3.org/2007/app">
  <title>${escapeXml(title)}</title>
  <author><name>${escapeXml(env.HATENA_ID)}</name></author>
  <content type="text/plain">${escapeXml(body)}</content>
  <app:control>
    <app:draft>yes</app:draft>
  </app:control>
</entry>`;

  const endpoint = `https://blog.hatena.ne.jp/${env.HATENA_ID}/${env.HATENA_BLOG_DOMAIN}/atom/entry`;
  const auth = Buffer.from(`${env.HATENA_ID}:${env.HATENA_API_KEY}`).toString("base64");

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      Authorization: `Basic ${auth}`,
    },
    body: xml,
  });

  if (res.status === 201) {
    const location = res.headers.get("location") || "(Locationヘッダなし)";
    console.log("下書き投稿に成功しました (201 Created)");
    console.log(`タイトル: ${title}`);
    console.log(`エントリURL: ${location}`);
  } else {
    const text = await res.text();
    console.error(`エラー: 投稿に失敗しました (HTTP ${res.status})`);
    console.error(text.slice(0, 500));
    process.exit(1);
  }
}

main();
