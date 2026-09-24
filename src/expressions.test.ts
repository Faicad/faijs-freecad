/**
 * M6.2 tests — constant expression evaluation and engine extraction.
 */
import { describe, it, expect } from 'vitest';
import { evalConstantExpression, parseExpressionEngine, allConstant } from './expressions.js';
import type { FcstdProperty } from './document.js';

describe('evalConstantExpression (M6.2)', () => {
  it('evaluates bare numbers', () => {
    expect(evalConstantExpression('10')).toBe(10);
    expect(evalConstantExpression('-3.5')).toBe(-3.5);
    expect(evalConstantExpression('1e2')).toBe(100);
  });

  it('normalizes length units to mm (D7)', () => {
    expect(evalConstantExpression('10 mm')).toBe(10);
    expect(evalConstantExpression('1 cm')).toBe(10);
    expect(evalConstantExpression('2 in')).toBeCloseTo(50.8, 10);
  });

  it('returns undefined for references / arithmetic (explicit unsupported)', () => {
    expect(evalConstantExpression('Sketch.Constraints[3]')).toBeUndefined();
    expect(evalConstantExpression('10 mm + 5 mm')).toBeUndefined();
    expect(evalConstantExpression('Pad.Length * 2')).toBeUndefined();
    expect(evalConstantExpression('10foo')).toBeUndefined();
  });
});

describe('parseExpressionEngine (M6.2)', () => {
  it('extracts bindings from a real-shaped engine element', () => {
    const prop = {
      children: [{
        children: [
          { tagName: 'Expression', attributes: { path: 'Length', expression: '10 mm' } },
          { tagName: 'Expression', attributes: { path: 'Length2', expression: '5' } },
        ],
      }],
    };
    const bindings = parseExpressionEngine(prop as unknown as FcstdProperty);
    expect(bindings.length).toBe(2);
    expect(bindings[0]).toMatchObject({ path: 'Length', value: 10 });
    expect(allConstant(bindings)).toBe(true);
  });

  it('flags non-constant engines as not bindable', () => {
    const prop = {
      children: [{
        children: [{ attributes: { path: 'Length', expression: 'Sketch.Constraints[3]' } }],
      }],
    };
    expect(allConstant(parseExpressionEngine(prop as unknown as FcstdProperty))).toBe(false);
  });
});
