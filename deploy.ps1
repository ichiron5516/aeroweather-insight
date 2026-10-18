# AeroWeather Insight を GitHub Pages に公開する（2026-10-18）
#   使い方：PowerShell で  cd C:\dev\aeroweather-insight  →  .\deploy.ps1
#   ・npm run build で dist を作り、gh-pages ブランチ用の別フォルダ（C:\dev\aw-gh-pages）に robocopy でそっくり写して push する
#     （gh-pages の npm パッケージは Cesium のファイルが多すぎて Windows で ENAMETOOLONG になるため使わない）
#   ・ソース（main ブランチ）の commit・push は別（下の「ソースの保存」）
$ErrorActionPreference = 'Stop'
$src  = 'C:\dev\aeroweather-insight'
$site = 'C:\dev\aw-gh-pages'
$repo = 'https://github.com/ichiron5516/aeroweather-insight.git'

Set-Location $src
if (-not (Select-String -Path .env.local -Pattern '^VITE_WX_PROXY=' -Quiet)) {
  Write-Warning '.env.local に VITE_WX_PROXY（Cloudflare Workers の中継の URL）がありません。公開サイトでは METAR・TAF・国際悪天・京都大学の GPV・AIP の URL 取り込みが使えません（GPV は Open-Meteo で動きます）'
}
Write-Host '--- ビルド（npm run build）'
npm run build
if ($LASTEXITCODE -ne 0) { throw 'ビルドに失敗しました' }

if (-not (Test-Path "$site\.git")) {
  Write-Host '--- gh-pages ブランチを取ってきます（初回だけ）'
  git clone --branch gh-pages --single-branch $repo $site
}
Set-Location $site
git pull --ff-only origin gh-pages

Write-Host '--- dist を写します'
robocopy "$src\dist" $site /MIR /XD .git /XF .nojekyll CNAME /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy でエラー（$LASTEXITCODE）" }
New-Item -ItemType File -Force .nojekyll | Out-Null

git add -A
$changes = git status --porcelain
if (-not $changes) { Write-Host '変更がないので公開し直しません'; Set-Location $src; exit 0 }
git commit -m ("deploy " + (Get-Date -Format 'yyyy-MM-dd HH:mm'))
git push origin gh-pages
Set-Location $src
Write-Host '--- 公開しました。数分で https://ichiron5516.github.io/aeroweather-insight/ に反映されます'
