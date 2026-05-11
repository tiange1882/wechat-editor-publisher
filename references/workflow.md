# Workflow Notes

This skill is for the local free publishing path:

1. Polish the article.
2. Prepare `article-wechat.md` with frontmatter and local image paths.
3. Prepare cover and body images under `output/wechat/`.
4. Run dry-run preview:

```powershell
node .\publish-wechat-official.mjs article-wechat.md --cover output/wechat/wechat-cover.png --dry-run
```

5. Run official API upload:

```powershell
node .\publish-wechat-official.mjs article-wechat.md --cover output/wechat/wechat-cover.png
```

This workflow intentionally avoids md2wechat paid API mode and any `md2wechat_key`.
