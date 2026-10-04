# install.ps1 — dsh-aiwatch 一键安装（Windows）
#   打包 → 装进指定 dsh profile → 自检 → 打印重启指引
# 用法:  .\install.ps1                  （默认 profile = web）
#        .\install.ps1 -Profile myweb   （别的 profile 名）
# 若系统禁止运行脚本:  powershell -ExecutionPolicy Bypass -File .\install.ps1
param([string]$Profile = 'web')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host '== dsh-aiwatch 一键安装 ==' -ForegroundColor Cyan
Write-Host "仓库目录: $root"

# 0. 环境
foreach ($c in @('node','npm')) {
  if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { throw "缺少 $c，请先装 Node.js 18+" }
}
Write-Host ("node " + (node -v) + ' / npm ' + (npm -v))

# 1. 打包到"无空格"的临时目录
#    为什么必须打 tarball 而不是直接 add 源码目录：
#      ① 目录路径含空格时 Windows 会把参数在空格处拆碎（pnpm 报 - isn't supported）；
#      ② add 目录 = pnpm link(junction)，插件无法按"代码位置"反推 profile，凭据落不了盘。
$stage = Join-Path $env:TEMP 'dsh-aiwatch-pack'
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage | Out-Null
Push-Location $root
try { npm pack --pack-destination $stage --silent | Out-Null } finally { Pop-Location }
$tgz = Get-ChildItem $stage -Filter '*.tgz' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $tgz) { throw '打包失败：没有产出 tgz' }
Write-Host ("打包完成: " + $tgz.FullName) -ForegroundColor Green

# 2. 装进 profile
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
if (-not (Test-Path $profileDir)) { throw "找不到 profile 目录: $profileDir（用 -Profile 指定你的 profile 名）" }
Write-Host "安装到 profile: $profileDir"
& npx --yes '@deepseek-ai/dsh' plugin --profile $Profile add $tgz.FullName

# 3. 自检：本体在不在、监听脚本有没有随包带进来
$inst = Join-Path $profileDir 'node_modules\dsh-aiwatch'
if (Test-Path $inst) {
  Write-Host "已安装: $inst" -ForegroundColor Green
  if (Test-Path (Join-Path $inst 'tools\desktop-watch\watch-desktop.mjs')) {
    Write-Host '监听脚本已随包安装（不用手配路径）' -ForegroundColor Green
  } else {
    Write-Host '警告: 包里没有监听脚本，需要在设置卡片里手填 watcherScript' -ForegroundColor Yellow
  }
} else {
  Write-Host '警告: node_modules 里没看到 dsh-aiwatch，请看上面 dsh plugin add 的输出' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '== 下一步 ==' -ForegroundColor Cyan
Write-Host '1) 重启 dsh（host 端代码只在重启时重新加载）'
Write-Host '2) 打开插件详情页的「监听设置」卡片: 填要看的文件夹、录一个热键'
Write-Host '3) 在你想接收轨迹的会话里发一句: /aiwatch bind'