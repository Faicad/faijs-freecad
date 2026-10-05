#!/usr/bin/env pwsh
param(
    [Parameter(Position = 0, HelpMessage = '"all" to log full output to ci.log. Default: direct console output.')]
    [string]$Mode
)

# NOTE: Must be 'Continue', NOT 'Stop'. The script checks $LASTEXITCODE explicitly
# after every npm/node call (see Step). With 'Stop', Windows PowerShell 5.1 turns
# *any* stderr line from a native command (npm writes "npm error ..." to stderr on
# failure) into a terminating NativeCommandError. That exception jumps out of Step
# BEFORE $script:failures.Add($Label) runs — so a failing step is never recorded and
# the final summary wrongly prints "All CI checks passed". Keep 'Continue' and rely
# on the explicit $LASTEXITCODE checks below.
$ErrorActionPreference = 'Continue'
# StrictMode hosts: $LASTEXITCODE only exists after the first native command.
# Initialise it so the first `if ($LASTEXITCODE -ne 0)` check doesn't throw.
$LASTEXITCODE = 0

# Decode external (Node) command stdout as UTF-8 instead of the system
# default GBK/CP936. Without this, vitest/eslint/tsc output is mis-decoded
# as GBK and re-encoded into the log as mojibake.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$ROOT = Split-Path -Parent $PSScriptRoot
Set-Location $ROOT

# Determine mode
$allMode = $false
if ($PSBoundParameters.ContainsKey('Mode')) {
    if ($Mode -ne 'all') {
        Write-Host "ERROR: Mode must be 'all', got '$Mode'" -ForegroundColor Red
        exit 1
    }
    $allMode = $true
}

if ($allMode) {
    $script:ciLogPath = Join-Path $ROOT 'ci.log'
}

$script:globalStart = Get-Date
$script:failures = [System.Collections.Generic.List[string]]::new()

function Step {
    param([string]$Label, [ScriptBlock]$Block)
    $start = Get-Date
    Write-Host "==> $Label"
    & $Block
    if ($LASTEXITCODE -ne 0) {
        if ($allMode) {
            $script:failures.Add($Label)
        } else {
            exit $LASTEXITCODE
        }
    }
    $elapsed = (Get-Date) - $start
    $total = (Get-Date) - $script:globalStart
    Write-Host "    ($($elapsed.TotalSeconds.ToString('0.0'))s / 累计 $($total.TotalSeconds.ToString('0.0'))s)" -ForegroundColor DarkGray
}

$ciMain = {
# standalone 单包仓库：lint -> typecheck -> build -> test（含 stderr 零容忍）-> pack。
# 参考 ../faijs/scripts/ci.ps1 的骨架（UTF-8、Continue $ErrorActionPreference、
# Step+$LASTEXITCODE、外部硬看门狗），按单包裁剪：无 workspaces / demo e2e / doc-sync 阶段。

Step -Label '1/5  npm run lint' -Block { npm run lint }

Step -Label '2/5  npm run typecheck' -Block { npm run typecheck }

Step -Label '3/5  npm run build' -Block {
    # build 产出 dist/（在 git 上被 ignore），fresh checkout 全靠此步；pack 阶段也依赖它。
    npm run build
}

Write-Host "==> 4/5  npm run test（外部硬看门狗；预算 5 分钟）"
$start3 = Get-Date
$tmpVitest = [System.IO.Path]::GetTempFileName()
$testBudgetMs = if ($env:FAIJS_TEST_BUDGET_MS) { [int]$env:FAIJS_TEST_BUDGET_MS } else { 300000 } # 5 分钟
# 硬看门狗：vitest 的 per-test testTimeout 无法中断同步原生死锁（事件循环被阻塞时
# 其计时器同样被冻结）。外层套进程级看门狗，超预算就杀进程树并判失败，CI 绝不被
# 一个死循环测试永久挂起（脚本见 scripts/run-tests-with-watchdog.mjs）。
node scripts/run-tests-with-watchdog.mjs --budget-ms $testBudgetMs -- npm run test 2>&1 | Tee-Object -FilePath $tmpVitest -Append
if ($LASTEXITCODE -ne 0) {
    if ($allMode) {
        $script:failures.Add('4/5  npm run test')
    } else {
        exit $LASTEXITCODE
    }
}

# Check for stderr — ANY stderr output fails CI (zero tolerance).
# Rule: If a test intentionally triggers an error condition, it must spy on
# console.warn/error within that test and assert the message was captured.
$stderrLines = [System.Collections.Generic.List[string]]::new()
$inStderr = $false
Get-Content $tmpVitest | ForEach-Object {
    if ($_ -match '^stderr \|') {
        $inStderr = $true
        $stderrLines.Add($_)
    } elseif ($inStderr) {
        if ($_ -match '^\s') {
            $stderrLines.Add($_)
        } else {
            $inStderr = $false
        }
    }
}
if ($stderrLines.Count -gt 0) {
    Write-Host "`nERROR: Tests produced stderr output — all test stderr must be resolved." -ForegroundColor Red
    $stderrLines | ForEach-Object { Write-Host $_ }
    if ($allMode) {
        $script:failures.Add('4/5  npm run test (stderr)')
    } else {
        exit 1
    }
}
Remove-Item $tmpVitest -ErrorAction SilentlyContinue
$total3 = (Get-Date) - $script:globalStart
Write-Host "    (累计 $($total3.TotalSeconds.ToString('0.0'))s)" -ForegroundColor DarkGray

Step -Label '5/5  npm pack（本地包可打包性）' -Block {
    npm pack
}
}

# Execute — pipe all streams (6=&1) to console; in allMode also persist to ci.log.
if ($allMode) {
    $sw = [System.IO.StreamWriter]::new($script:ciLogPath, $false, [System.Text.UTF8Encoding]::new($false))
    try {
        & $ciMain *>&1 | ForEach-Object {
            $_                       # keep native stream rendering on console
            $sw.WriteLine([string]$_)
        }
    } finally {
        $sw.Dispose()
    }
} else {
    & $ciMain
}

$total = (Get-Date) - $script:globalStart
if ($script:failures.Count -gt 0) {
    $summary = New-Object System.Collections.Generic.List[string]
    $summary.Add('')
    $summary.Add('============================================')
    $summary.Add('  FAILED STEPS:')
    foreach ($f in $script:failures) {
        $summary.Add("    - $f")
    }
    $summary.Add('============================================')
    $summary.Add("==> CI checks completed with $($script:failures.Count) failure(s) (总耗时 $($total.TotalSeconds.ToString('0.0'))s)")
    foreach ($l in $summary) { Write-Host $l -ForegroundColor Red }
    if ($allMode) {
        Add-Content -Path $script:ciLogPath -Value $summary -Encoding utf8
    }
    exit 1
} else {
    $msg = "==> All CI checks passed (总耗时 $($total.TotalSeconds.ToString('0.0'))s)"
    Write-Host $msg
    if ($allMode) {
        Add-Content -Path $script:ciLogPath -Value $msg -Encoding utf8
    }
}