#!/usr/bin/env node
import { readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();

const articlePath = path.resolve(cwd, process.argv[2] || "article-wechat.md");
const coverArg = process.argv.includes("--cover")
  ? process.argv[process.argv.indexOf("--cover") + 1]
  : null;
const dryRun = process.argv.includes("--dry-run");
const showHelp = process.argv.includes("--help") || process.argv.includes("-h");

if (showHelp) {
  console.log(`Usage:
  node publish-wechat-official.mjs [article.md] --cover output/wechat/wechat-cover.png
  node publish-wechat-official.mjs article-wechat.md --cover output/wechat/wechat-cover.png --dry-run

This script uses WeChat Official Account APIs directly:
- get access_token
- upload cover as permanent thumb material
- upload local body images for article content
- create a draft via /cgi-bin/draft/add
`);
  process.exit(0);
}

function fail(message, extra) {
  console.error(`\nERROR: ${message}`);
  if (extra) console.error(extra);
  process.exit(1);
}

function parseSimpleYaml(source) {
  const root = {};
  const stack = [{ indent: -1, value: root }];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, "  ");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^(\s*)([^:#]+):(?:\s*(.*))?$/);
    if (!match) continue;
    const indent = match[1].length;
    const key = match[2].trim();
    let value = (match[3] ?? "").trim();
    while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].value;
    if (!value) {
      parent[key] = {};
      stack.push({ indent, value: parent[key] });
      continue;
    }
    value = value.replace(/^['"]|['"]$/g, "");
    parent[key] = value;
  }
  return root;
}

async function loadConfig() {
  const candidates = [
    process.env.WECHAT_CONFIG,
    path.join(process.env.USERPROFILE || "", ".config", "md2wechat", "config.yaml"),
    path.join(process.env.HOME || "", ".config", "md2wechat", "config.yaml"),
    path.resolve(cwd, "wechat-config.yaml"),
  ].filter(Boolean);

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const config = parseSimpleYaml(await readFile(file, "utf8"));
    const appid = process.env.WECHAT_APPID || config.wechat?.appid || config.wechat?.appId || config.appid;
    const secret = process.env.WECHAT_SECRET || config.wechat?.secret || config.wechat?.appSecret || config.secret;
    if (appid && secret) return { appid, secret, file };
  }
  fail(
    "没有找到微信公众号 AppID/Secret。",
    `请先确认配置文件存在：%USERPROFILE%\\.config\\md2wechat\\config.yaml
或者临时设置环境变量 WECHAT_APPID / WECHAT_SECRET。`
  );
}

function parseFrontmatter(markdown) {
  if (!markdown.startsWith("---")) return { meta: {}, body: markdown };
  const end = markdown.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: markdown };
  const yaml = markdown.slice(3, end);
  const body = markdown.slice(end + 4).replace(/^\r?\n/, "");
  return { meta: parseSimpleYaml(yaml), body };
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong style="color:#111;font-weight:700;">$1</strong>')
    .replace(/`([^`]+)`/g, '<code style="background:#f6f6f6;border-radius:4px;padding:2px 4px;">$1</code>');
}

function mimeType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

async function toBlob(file) {
  const bytes = await readFile(file);
  return new Blob([bytes], { type: mimeType(file) });
}

async function wxFetch(url, options, label) {
  const res = await fetch(url, options);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    fail(`${label} 返回的不是 JSON。`, text.slice(0, 1000));
  }
  if (!res.ok || (json.errcode && json.errcode !== 0)) {
    throw new Error(`${label} failed: ${JSON.stringify(json)}`);
  }
  return json;
}

function explainWxError(error) {
  const message = String(error?.message || error);
  if (message.includes("40164")) {
    const ips = [...message.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)].map((m) => m[0]);
    const ipHint = ips.length ? `\n微信实际识别到的 IP 可能是：${[...new Set(ips)].join(", ")}` : "";
    return `微信返回 40164：当前电脑/网络出口 IP 不在公众号 API IP 白名单。到公众号后台「设置与开发 → 基本配置 → API IP白名单」添加当前公网 IP。${ipHint}\n微信原始返回：${message}`;
  }
  if (message.includes("40001") || message.includes("invalid credential")) {
    return "微信返回凭证错误：AppID 或 AppSecret 不正确，或 AppSecret 已被重置。";
  }
  if (message.includes("48001") || message.includes("api unauthorized")) {
    return "微信返回接口未授权：当前公众号可能未认证，或没有草稿/素材接口权限。你的后台截图显示“暂未认证”，这里尤其需要确认。";
  }
  if (message.includes("45009")) {
    return "微信返回调用频率限制：接口调用太频繁，稍后再试。";
  }
  return message;
}

async function getAccessToken(config) {
  const cachePath = path.resolve(cwd, ".wechat-access-token-cache.json");
  if (existsSync(cachePath)) {
    try {
      const cache = JSON.parse(await readFile(cachePath, "utf8"));
      if (cache.appid === config.appid && cache.access_token && Date.now() < cache.expires_at - 120_000) {
        return cache.access_token;
      }
    } catch {}
  }

  const url = new URL("https://api.weixin.qq.com/cgi-bin/token");
  url.searchParams.set("grant_type", "client_credential");
  url.searchParams.set("appid", config.appid);
  url.searchParams.set("secret", config.secret);
  const data = await wxFetch(url, {}, "获取 access_token");
  await writeFile(
    cachePath,
    JSON.stringify({
      appid: config.appid,
      access_token: data.access_token,
      expires_at: Date.now() + Number(data.expires_in || 7200) * 1000,
    }, null, 2),
    "utf8"
  );
  return data.access_token;
}

async function uploadBodyImage(accessToken, file) {
  const form = new FormData();
  form.append("media", await toBlob(file), path.basename(file));
  const url = `https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token=${encodeURIComponent(accessToken)}`;
  const data = await wxFetch(url, { method: "POST", body: form }, `上传正文图片 ${path.basename(file)}`);
  if (!data.url) throw new Error(`上传正文图片未返回 url: ${JSON.stringify(data)}`);
  return data.url;
}

async function uploadCoverThumb(accessToken, file) {
  const form = new FormData();
  form.append("media", await toBlob(file), path.basename(file));
  const url = `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${encodeURIComponent(accessToken)}&type=thumb`;
  const data = await wxFetch(url, { method: "POST", body: form }, `上传封面图 ${path.basename(file)}`);
  if (!data.media_id) throw new Error(`上传封面图未返回 media_id: ${JSON.stringify(data)}`);
  return data.media_id;
}

function resolveImagePath(src) {
  if (/^https?:\/\//i.test(src)) return src;
  return path.resolve(path.dirname(articlePath), src.replaceAll("/", path.sep));
}

async function markdownToWechatHtml(markdown, accessToken) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  const pending = [];

  async function flushParagraph() {
    if (!pending.length) return;
    html.push(`<p style="margin: 18px 0; line-height: 1.85; font-size: 16px; color: #2b2b2b;">${inlineMarkdown(pending.join(""))}</p>`);
    pending.length = 0;
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      await flushParagraph();
      continue;
    }

    const image = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (image) {
      await flushParagraph();
      const alt = image[1] || "";
      const src = image[2].trim();
      let url = src;
      if (!/^https?:\/\//i.test(src)) {
        const file = resolveImagePath(src);
        if (!existsSync(file)) fail(`找不到文中图片：${src}`, file);
        url = dryRun ? `LOCAL_IMAGE:${src}` : await uploadBodyImage(accessToken, file);
      }
      html.push(`<p style="margin: 22px 0; text-align:center;"><img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" style="max-width:100%;border-radius:6px;display:block;margin:0 auto;" /></p>`);
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      await flushParagraph();
      html.push(`<blockquote style="margin: 22px 0; padding: 12px 16px; border-left: 4px solid #111; background: #f7f7f7; color: #333; line-height: 1.8;">${inlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }

    const heading = line.match(/^(#{2,4})\s+(.+)$/);
    if (heading) {
      await flushParagraph();
      const level = heading[1].length;
      const size = level === 2 ? 22 : 19;
      html.push(`<h${level} style="margin: 30px 0 14px; font-size: ${size}px; line-height: 1.35; color:#111; font-weight:700;">${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    pending.push(line);
  }

  await flushParagraph();
  return `<section style="max-width: 677px; margin: 0 auto; padding: 0 6px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">\n${html.join("\n")}\n</section>`;
}

async function createDraft(accessToken, article) {
  const url = `https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${encodeURIComponent(accessToken)}`;
  return wxFetch(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ articles: [article] }),
    },
    "创建草稿"
  );
}

async function main() {
  if (!existsSync(articlePath)) fail(`找不到文章文件：${articlePath}`);
  const coverPath = coverArg
    ? path.resolve(cwd, coverArg)
    : path.resolve(path.dirname(articlePath), "output/wechat/wechat-cover.png");
  if (!existsSync(coverPath)) fail(`找不到封面图：${coverPath}`);

  const coverInfo = await stat(coverPath);
  if (coverInfo.size > 64 * 1024) {
    console.warn(`WARN: 封面图大小 ${(coverInfo.size / 1024).toFixed(1)}KB，微信 thumb 素材可能要求更小；如上传失败，请先压缩到 64KB 以内。`);
  }

  const raw = await readFile(articlePath, "utf8");
  const { meta, body } = parseFrontmatter(raw);

  const title = (meta.title || "").trim();
  if (!title) fail("文章 frontmatter 缺少 title。");
  if ([...title].length > 64) fail(`标题过长：${[...title].length} 字。建议控制在 64 字以内。`);

  const digest = (meta.digest || "").trim();
  if ([...digest].length > 120) console.warn(`WARN: 摘要 ${[...digest].length} 字，微信后台可能会截断。`);

  console.log(`使用文章：${articlePath}`);
  console.log(`使用封面：${coverPath}`);
  console.log(`标题：${title}`);
  console.log(`模式：${dryRun ? "dry-run（不上传）" : "正式创建草稿"}`);

  if (dryRun) {
    const html = await markdownToWechatHtml(body, "DRY_RUN_TOKEN");
    const out = path.resolve(cwd, "wechat-official-preview.html");
    await writeFile(out, html, "utf8");
    console.log(`已生成本地预览 HTML：${out}`);
    return;
  }

  const config = await loadConfig();
  console.log(`使用配置：${config.file}`);

  try {
    console.log("1/4 获取 access_token...");
    const accessToken = await getAccessToken(config);

    console.log("2/4 上传封面素材...");
    const thumbMediaId = await uploadCoverThumb(accessToken, coverPath);

    console.log("3/4 上传文中图片并生成 HTML...");
    const content = await markdownToWechatHtml(body, accessToken);
    await writeFile(path.resolve(cwd, "wechat-official-last-content.html"), content, "utf8");

    console.log("4/4 创建微信公众号草稿...");
    const result = await createDraft(accessToken, {
      title,
      author: meta.author || "",
      digest,
      content,
      content_source_url: meta.content_source_url || "",
      thumb_media_id: thumbMediaId,
      show_cover_pic: 0,
      need_open_comment: 0,
      only_fans_can_comment: 0,
    });

    console.log("\nSUCCESS: 草稿创建成功。");
    console.log(JSON.stringify(result, null, 2));
    console.log("请打开微信公众号后台草稿箱检查排版和图片。");
  } catch (error) {
    fail("微信官方接口调用失败。", explainWxError(error));
  }
}

main();
