#!/usr/bin/env node
/**
 * Run a test command under a hard external watchdog.
 *
 * Why: vitest's per-test `testTimeout` runs a timer in the SAME process/event
 * loop as the test. It catches async hangs (a test awaiting a promise that
 * never settles) but CANNOT interrupt a synchronous, native-blocking hang (a
 * FinalizationRegistry finalizer deadlocking inside a native/wasm call). That
 * keeps the worker's event loop — and vitest's own timeout timer — frozen
 * forever, so the CI/`npm test` process never exits.
 *
 * This wrapper is the hard guarantee: it spawns the command, monitors it, and
 * on expiry force-kills the whole process tree (child + descendants) so CI
 * moves on with a visible failure instead of hanging forever.
 *
 * Policy: tests are capped at 5 minutes each (see vitest.config.ts
 * testTimeout). This watchdog is the outer guarantee for the process: a run
 * that exceeds the budget is treated as a hang and force-killed, exit code 2.
 *
 * Usage:
 *   node scripts/run-tests-with-watchdog.mjs --budget-ms 300000 -- npm run test
 *   node scripts/run-tests-with-watchdog.mjs -- <cmd> [args...]
 *
 * Exit codes:
 *   0  child exited 0 within budget
 *   1  child exited non-zero (its status is surfaced)
 *   2  budget exhausted — the child was force-killed (hang detected)
 *   3  usage error
 */
import { spawn, execSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT_PATH = resolve(__dirname, '..')

// --- parse args --------------------------------------------------------------
const SEP = process.argv.indexOf('--')
if (SEP === -1 || SEP === 0) {
  console.error('usage: run-tests-with-watchdog.mjs [--budget-ms <ms>] [--cwd <dir>] -- <cmd> [args...]')
  process.exit(3)
}
const flags = process.argv.slice(1, SEP)
const cmd = process.argv.slice(SEP + 1)
if (cmd.length === 0) {
  console.error('usage: run-tests-with-watchdog.mjs [--budget-ms <ms>] [--cwd <dir>] -- <cmd> [args...]')
  process.exit(3)
}

let budgetMs = 5 * 60 * 1000 // default: 5 minutes — no test may run longer
let cwd = ROOT_PATH
for (let i = 0; i < flags.length; i++) {
  const a = flags[i]
  if (a === '--budget-ms') {
    const v = Number(flags[++i])
    if (!Number.isFinite(v) || v <= 0) {
      console.error('invalid --budget-ms')
      process.exit(3)
    }
    budgetMs = v
  } else if (a === '--cwd') {
    if (i + 1 >= flags.length) {
      console.error('--cwd needs a value')
      process.exit(3)
    }
    cwd = resolve(ROOT_PATH, flags[++i])
  }
}
console.error(`[watchdog] budget=${budgetMs}ms(${Math.round(budgetMs / 1000)}s) cwd=${cwd}; cmd=${cmd.join(' ')}`)

// --- spawn -------------------------------------------------------------------
const child = spawn(cmd[0], cmd.slice(1), {
  cwd,
  stdio: 'inherit',
  shell: process.platform === 'win32', // npm / node cmd 需要 shell；命令本身是 .cmd/.exe
})

let settled = false

function killTreeNow() {
  if (child.pid == null) return
  try {
    if (process.platform === 'win32') {
      // taskkill /T /F 连后代一起杀；比 child.kill 可靠得多.
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    } else {
      // POSIX: 让主管进程退出，子进程随后随会话结束
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* */ }
    }
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  } catch { /* taskkill 已无进程时忽略 */ }
}

let timer = null
timer = setTimeout(() => {
  settled = true
  console.error(`[watchdog] budget ${budgetMs}ms exceeded — killing hung test process tree (${child.pid ?? 'unknown'}).`)
  killTreeNow()
  process.exitCode = 2
  // 兜底：若 2s 后仍没退出则强制退出（绝不无限挂）。
  setTimeout(() => process.exit(2), 2000)
}, budgetMs)

function end(code) {
  if (settled) return
  settled = true
  if (timer) clearTimeout(timer)
  process.exit(code)
}

child.on('exit', (code, signal) => {
  console.error(`[watchdog] child exit code=${code ?? 'null'} signal=${signal ?? ''}`)
  // 超时路径已触发时，child exit 事件随后而来；保持 exitCode=2，不覆盖成 0.
  if (settled) return
  end(code == null ? 1 : code)
})

child.on('error', (err) => {
  console.error(`[watchdog] spawn error: ${err.message}`)
  end(1)
})

process.on('exit', (code) => {
  if (!settled) {
    // 进程被外部信号结束时确保子进程不留.
    try { killTreeNow() } catch { /* */ }
  }
})