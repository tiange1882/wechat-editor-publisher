---
name: wechat-editor-publisher
description: End-to-end Chinese WeChat Official Account article workflow. Use when Codex should polish or rewrite a公众号 article, adapt it for WeChat/Xiaohongshu-style publishing, create or organize cover and in-article images, convert Markdown to WeChat-compatible HTML, and create a WeChat draft through official WeChat APIs without paid md2wechat API keys. Triggers include 微信公众号, 草稿箱, 润色, 排版, 配图, 封面图, 存草稿, 上传草稿, and direct WeChat Official Account API publishing.
---

# WeChat Editor Publisher

## Workflow

Follow this order unless the user asks for only one part:

1. Edit the article as a top-tier Chinese copy editor.
   - Improve title, opening hook, rhythm, paragraph breaks, transitions, and ending.
   - Preserve the author voice unless the user asks for a new voice.
   - For opinion pieces, strengthen the central claim and remove repeated explanations.

2. Prepare publishing assets.
   - Create or organize a cover image and in-article images.
   - Keep exact Chinese text out of generated raster art when possible; prefer deterministic text overlays or existing editable layouts.
   - For Xiaohongshu, prepare vertical image cards separately from WeChat article assets.

3. Build article Markdown.
   - Use frontmatter:
     ```yaml
     ---
     title: "文章标题"
     author: ""
     digest: "128字以内摘要"
     ---
     ```
   - Use local image paths for cover and body images.
   - Avoid a duplicate body H1 when `title` is already in frontmatter.

4. Run local checks.
   - Generate a dry-run HTML preview before uploading.
   - Verify image paths exist and Chinese content is UTF-8.

5. Create the WeChat draft through official APIs.
   - Use `scripts/publish-wechat-official.mjs`.
   - Do not use `md2wechat_key`; this workflow intentionally avoids the paid md2wechat API.
   - Upload only after the user asks to create a draft.

## Script

Copy the bundled script into the project if it is not already present:

```powershell
Copy-Item "<skill-dir>\scripts\publish-wechat-official.mjs" ".\publish-wechat-official.mjs"
```

Dry-run preview:

```powershell
node .\publish-wechat-official.mjs article-wechat.md --cover output/wechat/wechat-cover.png --dry-run
```

Create draft:

```powershell
node .\publish-wechat-official.mjs article-wechat.md --cover output/wechat/wechat-cover.png
```

The script performs:

- `cgi-bin/token` access token request
- permanent thumb material upload for the cover
- `media/uploadimg` upload for body images
- Markdown-to-WeChat-safe HTML conversion
- `cgi-bin/draft/add` draft creation

## Configuration

Read WeChat credentials from one of these:

```text
%USERPROFILE%\.config\md2wechat\config.yaml
wechat-config.yaml
WECHAT_APPID / WECHAT_SECRET environment variables
```

Expected YAML:

```yaml
wechat:
  appid: wx...
  secret: your_wechat_app_secret
```

Never ask the user to paste secrets into chat. Ask them to edit the local config file.

## Common Failures

- `40164`: API IP whitelist mismatch. Ask the user to add the IP shown in the script error to `设置与开发 -> 基本配置 -> API IP白名单`.
- `40001`: wrong AppID/AppSecret, or secret was reset.
- `48001`: API unauthorized. Personal or unverified accounts may not have draft/material API permission.
- cover upload fails: compress the cover image below the WeChat thumb material size limit, commonly 64KB.

## GitHub Publishing Guidance

For a standalone public skill repository:

```powershell
Set-Location "D:\微信公众号编辑\wechat-editor-publisher"
git init
git add .
git commit -m "Add WeChat editor publisher skill"
git branch -M main
git remote add origin https://github.com/<your-user>/wechat-editor-publisher.git
git push -u origin main
```

For a multi-skill repository, put this folder under `skills/wechat-editor-publisher/`.
