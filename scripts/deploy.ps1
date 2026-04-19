<#
.SYNOPSIS
  一键部署静态博客到 github pages
#>

Write-Host "🚀 开始准备部署流程..." -ForegroundColor Cyan

# 1. 构建项目
Write-Host "📦 1/3 正在执行静态全量构建..." -ForegroundColor Yellow
npm run build

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ 构建失败！请检查代码或终端报错。" -ForegroundColor Red
    exit 1
}

# 2. 部署逻辑
Write-Host "🌐 2/3 将 dist 目录发布至 Github Pages..." -ForegroundColor Yellow
# 这里假设用户使用 git worktree 或者类似的 gh-pages 模块，
# 因为原先项目没有配置相关的发布脚本，我们推荐直接使用 npm 包 gh-pages
# npx gh-pages -d dist

npx gh-pages -d dist

if ($LASTEXITCODE -ne 0) {
    Write-Host "⚠️ 注意：执行 npx gh-pages 失败。如果你的机器没有安装，请先执行 `npm install -D gh-pages` 或者配置自动化的 Github Actions Workflow。" -ForegroundColor Red
    exit 1
}

Write-Host "✅ 3/3 部署已推送到 gh-pages 分支（或发布操作完成）。大概需等待 1-2 分钟生效。" -ForegroundColor Green
