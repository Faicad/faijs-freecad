/**
 * M6.2 — expression downgrade: <ExpressionEngine> → concrete values.
 *
 * Format (verified on TwoLengthsPadWithExpression.FCStd):
 *   <ExpressionEngine count="N">
 *     <Expression path="Length" expression="10 mm" />
 *   </ExpressionEngine>
 *
 * Scope: constant expressions only — number literals with optional unit
 * (mm/m/cm/in/deg/rad). Anything else (object references like Sketch.Constraints[3],
 * arithmetic with identifiers, functions) is NOT evaluated: the consumer must
 * treat the property as unknown and degrade (no heuristic fallback, plan §12).
 */
import type { FcstdProperty } from './document.js';

/** Evaluated expression result in mm (angles keep their own unit): a number, or undefined when unsupported. */
export type ExprValue = number | undefined;

const UNIT_TO_MM: Record<string, number> = {
  mm: 1, millimeter: 1,
  cm: 10, centimeter: 10,
  m: 1000, meter: 1000,
  in: 25.4, inch: 25.4, '"': 25.4,
  ft: 304.8, foot: 304.8,
  // angles: value kept in the expression's own unit; callers interpret
  deg: 1, degree: 1, '°': 1,
  rad: 1, radian: 1,
};

/**
 * Evaluate a constant expression. Returns undefined when the expression is
 * not a bare constant (reference/arithmetic/function) — explicit unsupported,
 * no guessing.
 *
 * @param expr raw expression string (e.g. "10 mm")
 * @returns the value in mm, or undefined when not a constant expression
 */
export function evalConstantExpression(expr: string): ExprValue {
  const s = expr.trim();
  // number [unit]
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([A-Za-z°"]*)$/.exec(s);
  if (!m) return undefined;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return undefined;
  const unit = m[2]!;
  if (unit === '') return value;
  const factor = UNIT_TO_MM[unit.toLowerCase()];
  if (factor === undefined) return undefined; // unknown unit → unsupported
  return value * factor;
}

// ── P1-1 参数载体（2026-09-23）：Spreadsheet 别名三跳解析 + 引用算术 ──
//
// 语料实测（B2 / probe-param-cells，见 2026-09-21 方案 §3.9）：<Expression> 的
// 绝对头部是 `<<Label>>.Alias`（1,377 条）与引用参与的算术（657 条），而带别名
// 的参数单元格 84.8% 就是「=5.9mm」形态——现有 evalConstantExpression 已能算值，
// 缺的只是三跳：<<Data>> → 按 Label 找对象 → 按 alias 找单元格 → 去掉前导 =。
// 函数族 / cells[...] 区间仍不猜（no heuristic fallback，方案 §12）。

import type { FcstdObject } from './document.js';

/**
 * 三跳解析：`<<Label>>.Alias` / `Object.Alias` → 数据源对象 → 别名单元格 → 去掉
 * 前导 `=` 后交给 evalConstantExpression。同表地址（`=B2*2` 里的 `B2`）再跳一次。
 *
 * @param docObjects 全文档对象（按 Label 或 name 匹配数据源）
 * @param label 数据源标识（`<<Label>>` 内的 Label，或裸对象名）
 * @param alias 单元格别名
 * @returns 单元格值（mm），不可解析 → undefined
 */
export function spreadsheetAliasValue(
  docObjects: readonly FcstdObject[],
  label: string,
  alias: string,
): ExprValue {
  const src = docObjects.find(
    (o) => o.type === 'Spreadsheet::Sheet' &&
      (objectLabel(o) === label || o.name === label),
  );
  if (!src) return undefined;
  // cells 属性（Spreadsheet::PropertySheet）的 <Cell address alias content/> 子元素
  const cells = src.properties.get('cells') ?? [...src.properties.values()].find((p) =>
    p.children.some((c) => c.tagName === 'Cell' || c.children.some((g) => g.tagName === 'Cell')),
  );
  if (!cells) return undefined;
  const cell = [...cells.children].flatMap((c) => (c.tagName === 'Cell' ? [c] : c.children))
    .find((c) => c.tagName === 'Cell' && c.attributes['alias'] === alias);
  if (!cell) return undefined;
  const content = cell.attributes['content'] ?? '';
  // 去掉前导 =（同表地址/算术再走一次带上下文的求值，一跳深度足够语料头部）
  return evalWithDoc(content.startsWith('=') ? content.slice(1) : content, docObjects, src);
}

/** 对象的 Label 属性（FreeCAD 引用 `<<Label>>` 用的是它，不是 name）。 */
function objectLabel(o: FcstdObject): string | undefined {
  const el = o.properties.get('Label')?.children[0];
  return el?.attributes['value'] ?? (el?.valueText || undefined);
}

/**
 * B1（2026-09-26）：`Sketch.Constraints.<名称>` —— 具名约束的驱动尺寸。
 *
 * 语料实测（Bathroom_cabinet_sink.FCStd）：`Clone2D001` 的
 * `.AttachmentOffset.Base.x = -Sketch229.Constraints.Length / 2`，
 * `Extrude_Sketch094` 的 `Dir.x = Esboco_janela_fixa_persiana.Constraints.Largura_vao
 * - 2 * …Constraints.Perfil_montante…`。这不是 Spreadsheet 别名，是草图里
 * 用户命名的约束（`<Constrain Name="Length" Value="…"/>`）。旧解析把
 * `Sketch229.Constraints` 当作 `对象.别名` 去查表，必然落空，`.Length` 作为
 * 残留标识符让整条算术求值为 undefined → 属性被判「非常量」。
 */
function sketchConstraintValue(obj: FcstdObject, name: string): ExprValue {
  const list = obj.properties.get('Constraints')?.children[0];
  if (!list) return undefined;
  const hit = list.children.find((c) => c.tagName === 'Constrain' && c.attributes['Name'] === name);
  const v = hit?.attributes['Value'];
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * B1（2026-09-26）：通用 `Object.Property` 引用 —— 任意对象的数值属性。
 *
 * 语料实测（RND_455_00194.fcstd）：`Pad010.Length = Pad_MountingPadEdge.Length`，
 * 即一个 Pad 直接引用另一个 Pad 自己的 Length。取值优先走被引用对象的
 * ExpressionEngine 绑定（FreeCAD 打开时按表达式重算），否则取存档数值。
 * 递归求值带环保护：`Pad_A.Length = Pad_B.Length`、`Pad_B.Length = Pad_A.Length`
 * 这类环必须落到 undefined，不能爆栈。
 */
function objectPropertyValue(
  obj: FcstdObject,
  prop: string,
  docObjects: readonly FcstdObject[],
  seen: Set<string>,
): ExprValue {
  const key = `${obj.name}.${prop}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const norm = (p: string): string => (p.startsWith('.') ? p.slice(1) : p);
  const binding = parseExpressionEngine(obj.properties.get('ExpressionEngine'))
    .find((b) => norm(b.path) === prop);
  if (binding) {
    if (binding.value !== undefined) return binding.value;
    return evalWithDoc(binding.expression, docObjects, obj, seen);
  }
  const el = obj.properties.get(prop)?.children[0];
  const v = el?.attributes['value'];
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 解析一条 `Object.Segment[.Sub]` 引用为数值。
 *
 * 三种形态按序尝试，先命中先返回：
 *  1. Spreadsheet / VarSet 别名（既有三跳解析，B1 头部形态）；
 *  2. `Sketch.Constraints.<名称>`（草图具名约束的驱动尺寸）；
 *  3. 普通对象的数值属性（含其自身的表达式绑定，递归一跳）。
 */
function docReferenceValue(
  docObjects: readonly FcstdObject[],
  label: string,
  seg: string,
  sub: string | undefined,
  seen: Set<string>,
): ExprValue {
  const alias = spreadsheetAliasValue(docObjects, label, seg);
  if (alias !== undefined) return alias;
  const target = docObjects.find((o) => objectLabel(o) === label || o.name === label);
  if (!target) return undefined;
  if (sub !== undefined && (seg === 'Constraints' || target.type === 'Sketcher::SketchObject')) {
    return sketchConstraintValue(target, sub);
  }
  if (sub !== undefined) return undefined; // 更深的子路径不支持，不猜
  return objectPropertyValue(target, seg, docObjects, seen);
}

/**
 * 带文档上下文的表达式求值：引用（`<<L>>.A` / `L.A` / 同表地址 `B2`）替换为
 * 数值后，求值仅含常数与 + - * / ( ) 的算术。任何残留标识符 / 函数 → undefined
 * （no heuristic fallback）。返回值单位跟随单元格（mm 语境，角度单元格调用方解释）。
 *
 * @param expr 待求值表达式原文。
 * @param docObjects 文档对象表，用于解析引用（`<<L>>.A` / `L.A`）。
 * @param self 调用方对象（Spreadsheet::Sheet 时启用同表地址 `B2` 解析）。可选。
 * @returns 求值结果数值；含残留标识符 / 无法解析引用时返回 undefined。
 */
/**
 * Evaluate a FreeCAD expression against the document objects.
 * @param expr - the expression text (without the leading `=`).
 * @param docObjects - the document objects visible to the expression.
 * @param self - the object the expression is evaluated on, if any.
 * @returns the evaluated expression value.
 */
export function evalWithDoc(
  expr: string,
  docObjects: readonly FcstdObject[],
  self?: FcstdObject,
  /** 递归环保护：`Object.Property` 可能互相引用（`Pad_A.Length = Pad_B.Length`）。 */
  seen: Set<string> = new Set(),
): ExprValue {
  let s = expr.trim();
  // 引用替换：<<Label>>.Alias | Label.Alias | Object.Alias，以及三段式
  // Object.Constraints.<名称>（B1，2026-09-26）。
  s = s.replace(
    /<<([^>]+)>>\.([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?|([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?/g,
    (whole, brLabel, brSeg, brSub, plLabel, plSeg, plSub) => {
      const label: string = brLabel ?? plLabel ?? '';
      const seg: string = brSeg ?? plSeg ?? '';
      const sub: string | undefined = brSub ?? plSub;
      const v = docReferenceValue(docObjects, label, seg, sub, seen);
      return v === undefined ? whole : `(${v})`;
    },
  );
  // 同表地址（self 表内 address→alias 值，如 `B2` / `B2*2`）：仅当 self 是表
  if (self?.type === 'Spreadsheet::Sheet') {
    s = s.replace(/\b([A-Z]+[0-9]+)\b/g, (whole, addr: string) => {
      const v = spreadsheetAddressValue(self, addr, docObjects);
      return v === undefined ? whole : `(${v})`;
    });
  }
  // 单元格值自带单位（=5.9mm）——先按「常数+单位」求值（evalConstantExpression
  // 的既有口径），再进纯算术；单位记号在算术前剥离（返回值跟随 mm 语境）。
  const constant = evalConstantExpression(s);
  if (constant !== undefined) return constant;
  s = s.replace(/\b(mm|millimeter|cm|centimeter|m|meter|in|inch|"|ft|foot|deg|degree|°|rad|radian)\b/g, '');
  return evalArithmetic(s);
}

/** 同表地址取值：address → 该单元格 content（递归经 evalWithDoc，一跳深度）。 */
function spreadsheetAddressValue(
  sheet: FcstdObject,
  address: string,
  docObjects: readonly FcstdObject[],
): ExprValue {
  const cells = sheet.properties.get('cells');
  if (!cells) return undefined;
  const cell = [...cells.children].flatMap((c) => (c.tagName === 'Cell' ? [c] : c.children))
    .find((c) => c.tagName === 'Cell' && c.attributes['address'] === address);
  if (!cell) return undefined;
  const content = cell.attributes['content'] ?? '';
  return evalWithDoc(content.startsWith('=') ? content.slice(1) : content, docObjects, sheet);
}

/** 仅含数字与 + - * / ( ) 空格的算术求值；任何其它字符 → undefined。 */
function evalArithmetic(s: string): ExprValue {
  if (!/^[-+*/(). 0-9eE]*$/.test(s)) return undefined;
  try {
    const v = Function(`"use strict"; return (${s});`)() as unknown;
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}


/** One <Expression path=... expression=...> binding with its optional constant value. */
export interface ExpressionBinding {
  /** property path the expression drives (e.g. "Length") */
  path: string;
  /** raw expression string */
  expression: string;
  /** evaluated constant; undefined when not a constant expression */
  value?: number;
}

/**
 * Extract expression bindings from a parsed ExpressionEngine property.
 * `bindable` = every expression evaluated to a constant (then the property
 * values can be overridden); otherwise the engine is only partially readable.
 *
 * @param prop the parsed <ExpressionEngine> property (undefined → no bindings)
 * @returns one binding per <Expression> child, values evaluated
 */
export function parseExpressionEngine(
  prop: FcstdProperty | undefined,
): ExpressionBinding[] {
  const engineEl = prop?.children[0];
  if (!engineEl) return [];
  const out: ExpressionBinding[] = [];
  for (const el of engineEl.children) {
    if (el.tagName !== 'Expression') continue;
    const path = el.attributes['path'] ?? '';
    const expression = el.attributes['expression'] ?? '';
    out.push({ path, expression, value: evalConstantExpression(expression) });
  }
  return out;
}

/**
 * True when all bindings are constants → safe to override property values.
 * @param bindings bindings extracted by parseExpressionEngine
 * @returns true when there is at least one binding and every value is defined
 */
export function allConstant(bindings: ExpressionBinding[]): boolean {
  return bindings.length > 0 && bindings.every((b) => b.value !== undefined);
}
