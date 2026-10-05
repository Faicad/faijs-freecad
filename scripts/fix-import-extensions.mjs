/**
 * Post-build script: add .js extensions to relative import paths in dist/.
 *
 * tsc with moduleResolution: "bundler" does not require .js extensions
 * in source, and does not add them to output. But Node.js ESM requires
 * explicit file extensions. This script walks every .js and .d.ts file
 * in dist/ and rewrites relative import/export paths:
 *
 * - If the path points to a file (e.g. './lang/types' → './lang/types.js'),
 *   append '.js'.
 * - If the path points to a directory (e.g. './browser-host' →
 *   './browser-host/index.js'), append '/index.js'.
 *
 * Skips:
 *   - Bare module specifiers (e.g. 'occt-wasm', 'three')
 *   - Already-extensioned paths (e.g. './types.js')
 *   - Absolute paths / URLs
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

// dist 目录：默认根 dist（脚本位置上溯两级）；也可传参数（workspace 包各自调，
// 如 `node ../../scripts/fix-import-extensions.mjs dist`，cwd=包目录）。
const distDir = process.argv[2]
  ? join(process.cwd(), process.argv[2])
  : join(fileURLToPath(import.meta.url), '..', '..', 'dist')

/** Recursively collect all .js and .d.ts files under a directory */
function collectFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectFiles(full))
    } else {
      const ext = extname(entry.name)
      if (ext === '.js' || ext === '.ts') {
        files.push(full)
      }
    }
  }
  return files
}

/**
 * Resolve a relative import path to its actual file path in dist.
 * Returns the corrected path with .js extension or /index.js.
 */
function resolveImportPath(importPath, fromFile) {
  const fromDir = dirname(fromFile)
  const fullPath = join(fromDir, importPath)

  // Case 1: path.js already exists (file)
  if (existsSync(fullPath + '.js')) {
    return importPath + '.js'
  }

  // Case 2: path is a directory, path/index.js exists
  const indexPath = join(fullPath, 'index.js')
  if (existsSync(indexPath)) {
    // Ensure no trailing slash in importPath
    const cleanPath = importPath.replace(/\/$/, '')
    return cleanPath + '/index.js'
  }

  // Case 3: path itself is a .js file (e.g. './browser.js')
  if (existsSync(fullPath)) {
    return importPath
  }

  // Fallback: just append .js
  return importPath + '.js'
}

/**
 * Rewrite relative import/export specifiers to include .js extension.
 * Works on both .js and .d.ts files.
 */
function fixImports(content, filePath) {
  // Match: from './relative/path'  or  from "../relative/path"
  // Also match: import('./relative/path')
  // Also match: export { ... } from './relative/path'
  // Skip paths that already end with .js, .json, .mjs, .cjs, .ts, .d.ts
  const pattern =
    /(from\s+|import\s*\(\s*)(['"])(\.{1,2}\/[^'"]+?)(['"])/g

  let out = content.replace(pattern, (match, prefix, q1, path, q2) => {
    // Already has an extension?
    if (/\.(js|mjs|cjs|json)$/.test(path)) return match
    // Resolve to actual file
    const resolved = resolveImportPath(path, filePath)
    return `${prefix}${q1}${resolved}${q2}`
  })

  // §7.5: worker URL 在源码里写 .ts 字面量（源码模式可解析），build 产物重写回 .js
  out = out.replace(
    /(new URL\(\s*['"])(\.{1,2}\/[^'"]+?)\.ts(['"])/g,
    '$1$2.js$3',
  )

  return out
}

function main() {
  const files = collectFiles(distDir)
  let fixed = 0
  for (const file of files) {
    const src = readFileSync(file, 'utf-8')
    const out = fixImports(src, file)
    if (out !== src) {
      writeFileSync(file, out, 'utf-8')
      fixed++
    }
  }
  console.log(`Fixed import extensions in ${fixed} files (out of ${files.length} total)`)
}

main()
