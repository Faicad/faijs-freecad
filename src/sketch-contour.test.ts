/**
 * cad.sketch — BREP planar-face construction from 2D contours.
 *
 * Verifies the M6 wiring primitive: a solved sketch contour (lines + arcs)
 * becomes a real planar face that Pad/Pocket/Extrusion/Revolution consume via
 * cad.extrude / cad.revolve. Tests run BREP-only (sketch has no mesh path).
 *
 * Run: npx vitest run src/api/sketch.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { CadRuntime } from '@faicad/faijs/cad-runtime/runtime'
import type { HostPorts } from '@faicad/faijs/cad-runtime/ports'
import { asPartName } from '@faicad/faijs/identity'
import { initOcctWasm } from '@faicad/faijs/occt-kernel/occtKernel'
import type { Shape } from '@faicad/faijs/mesh/types'
import type { Contour } from './contour.js'
import { createApiNamespace } from '@faicad/faijs/api/api-namespace'

beforeAll(async () => {
  await initOcctWasm()
}, 120000)

function defaultPorts(): HostPorts {
  return { events: { emit: () => {} } } as HostPorts
}

/** Execute `cad.sketch({contours})` in BREP mode and return the resulting face Shape. */
async function runSketch(contours: Contour[]): Promise<Shape> {
  return runCode(`let part0 = cad.sketch({ contours: ${JSON.stringify(contours)} })\n`, 'part0')
}

/** Execute arbitrary .fai.js code in BREP mode and return the named output Shape. */
async function runCode(code: string, part: string): Promise<Shape> {
  const rt = new CadRuntime(defaultPorts(), 'brep', { cad: createApiNamespace() })
  const result = await rt.execute(code)
  if (result.failedAt) {
    throw new Error(`execution failed at ${result.failedAt.callee}: ${result.failedAt.message}`)
  }
  const shape = result.outputs.get(asPartName(part))
  if (!shape) throw new Error(`no output for ${part}`)
  return shape as Shape
}

/** Signed volume of a triangulated mesh (1/6 · Σ det). */
function volume(s: Shape): number {
  const { positions, indices } = s
  let v6 = 0
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]! * 3
    const b = indices[i + 1]! * 3
    const c = indices[i + 2]! * 3
    const ux = positions[b]! - positions[a]!
    const uy = positions[b + 1]! - positions[a + 1]!
    const uz = positions[b + 2]! - positions[a + 2]!
    const vx = positions[c]! - positions[a]!
    const vy = positions[c + 1]! - positions[a + 1]!
    const vz = positions[c + 2]! - positions[a + 2]!
    v6 +=
      positions[a]! * (uy * vz - uz * vy) +
      positions[a + 1]! * (uz * vx - ux * vz) +
      positions[a + 2]! * (ux * vy - uy * vx)
  }
  return Math.abs(v6) / 6
}

/** Planar area of a z≈0 face (sum of |cross|/2 over triangles). */
function faceAreaXY(s: Shape): number {
  const { positions, indices } = s
  let area = 0
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]! * 3
    const b = indices[i + 1]! * 3
    const c = indices[i + 2]! * 3
    const ax = positions[a]!, ay = positions[a + 1]!
    const bx = positions[b]!, by = positions[b + 1]!
    const cx = positions[c]!, cy = positions[c + 1]!
    area += Math.abs(ax * (by - cy) + bx * (cy - ay) + cx * (ay - by)) / 2
  }
  return area
}

function bbox(s: Shape): { min: number[]; max: number[] } {
  const { positions } = s
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k]!
      if (v < min[k]!) min[k] = v
      if (v > max[k]!) max[k] = v
    }
  }
  return { min, max }
}

function square(): Contour {
  return {
    closed: true,
    segments: [
      { kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
      { kind: 'line', x1: 10, y1: 0, x2: 10, y2: 10 },
      { kind: 'line', x1: 10, y1: 10, x2: 0, y2: 10 },
      { kind: 'line', x1: 0, y1: 10, x2: 0, y2: 0 },
    ],
  }
}

function circleAt(cx: number, cy: number, r: number): Contour {
  return {
    closed: true,
    segments: [{
      kind: 'arc', cx, cy, radius: r, startAngle: 0, endAngle: Math.PI * 2,
      ccw: true, x1: cx + r, y1: cy, x2: cx + r, y2: cy,
    }],
  }
}

describe('cad.sketch — BREP planar face construction', () => {
  it('builds a planar face from a square (area ≈ 100)', async () => {
    const s = await runSketch([square()])
    expect(Math.abs(faceAreaXY(s) - 100)).toBeLessThan(1.0)
  })

  it('bbox spans the square in XY and is ~0 in Z', async () => {
    const s = await runSketch([square()])
    const b = bbox(s)
    expect(b.min[0]).toBeLessThan(0.01)
    expect(b.min[1]).toBeLessThan(0.01)
    expect(b.max[0]).toBeGreaterThan(9.99)
    expect(b.max[1]).toBeGreaterThan(9.99)
    expect(Math.abs(b.min[2]!)).toBeLessThan(0.01)
    expect(Math.abs(b.max[2]!)).toBeLessThan(0.01)
  })

  it('cuts a circular hole out of the square (area ≈ 100 − πr²)', async () => {
    const r = 2
    const s = await runSketch([square(), circleAt(5, 5, r)])
    const expected = 100 - Math.PI * r * r
    expect(Math.abs(faceAreaXY(s) - expected)).toBeLessThan(1.0)
  })

  it('throws on empty contours (E_SKETCH_NO_CONTOURS)', async () => {
    await expect(runSketch([])).rejects.toThrow(/E_SKETCH_NO_CONTOURS/)
  })

  it('sketch → extrude produces a prism (volume ≈ area × length)', async () => {
    // square face (area 100) extruded 10 along +Z → prism volume 1000
    const code =
      `let part0 = cad.sketch({ contours: ${JSON.stringify([square()])} })\n` +
      `let part1 = cad.extrude(part0, [0, 0, 10])\n`
    const prism = await runCode(code, 'part1')
    expect(Math.abs(volume(prism) - 1000)).toBeLessThan(2)
    const b = bbox(prism)
    expect(b.min[2]!).toBeLessThan(0.01)
    expect(b.max[2]!).toBeGreaterThan(9.99)
  })
})
