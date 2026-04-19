# Personal Blog

当前项目使用 `D:\md` 作为唯一内容源，并通过本地发布台控制哪些笔记对读者公开。

## Current architecture

- Source notes: `D:\md`
- Shared gallery: `D:\md\图库`
- Publish state: `config/publish-state.json`
- Source config: `config/publishing.json`
- Publishing desk: `发布台.exe`
- Generated data: `src/generated/posts.json`
- Static output: `dist`
- Live site: `https://ma0xfly.github.io/`

## Common commands

```powershell
cd "E:\个人博客\personal-blog"
cmd /c npm install
cmd /c npm run build
cmd /c npm run check
cmd /c npm run manager
```

## Publishing desk

You can launch the desk by:

- double-clicking `发布台.exe`
- or running `cmd /c npm run manager`

Features:

- search by title / path / tag
- filter by top-level folder
- filter by published status
- filter by recent changes
- bulk publish / unpublish selected notes
- publish / unpublish current folder
- preview how many posts and assets will be published
- build / check / deploy from the same UI

## Build pipeline

`npm run build` will:

1. clean old output while preserving `dist/.git`
2. scan `D:\md`
3. read `publish-state.json`
4. copy only referenced assets
5. generate `src/generated/posts.json`
6. build the static site into `dist`

## Important files

- `config/publishing.json`
- `config/publish-state.json`
- `scripts/prepare-content.mjs`
- `scripts/publish-manager.mjs`
- `scripts/clean-output.mjs`
- `scripts/launch-manager.ps1`
- `scripts/build-manager-exe.ps1`
- `src/generated/posts.json`
- `src/generated/published-manifest.json`
