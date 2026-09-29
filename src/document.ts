/**
 * M1.2 — Document.xml → object graph.
 *
 * Contract per plan §5.5 / 前文 A §3.3: `<ObjectData>` is authoritative
 * (objects + properties); `<Objects>` is only a type index. Transient
 * `_Property` elements are skipped.
 */
import { err, ok, type Result } from '@faicad/faijs/api/result';
import { parseXmlDocument, serializeXmlNode } from '@faicad/faijs/api/xml-dom';

/** One parsed XML node from Document.xml: a property element (or nested value element) with its children. */
export interface FcstdProperty {
  /** property name attribute ('' for non-property elements like <Geometry>) */
  name: string;
  /** e.g. "App::PropertyString", "Part::PropertyPartShape" */
  type: string;
  /** serialized element tag, e.g. "Geometry", "Constrain", "LineSegment" */
  tagName: string;
  /** raw nested XML content (first element child), serialized */
  valueXml?: string;
  /** for simple value properties, the text content */
  valueText?: string;
  /** named sub-elements (e.g. <Python .../>, <ExpressionEngine> children) */
  children: FcstdProperty[];
  attributes: Record<string, string>;
}

/** One object from <ObjectData>: name, resolved type and its property map. */
export interface FcstdObject {
  /** object name, e.g. "Sketch" or "Pad" */
  name: string;
  /** e.g. "Sketcher::SketchObject", "PartDesign::Pad" */
  type: string;
  properties: Map<string, FcstdProperty>;
}

/** Parsed Document.xml: objects, the <Objects> type index and document-level meta. */
export interface FcstdDocument {
  objects: FcstdObject[];
  /** from <Objects>: name → type (index only, not authoritative) */
  typeIndex: Map<string, string>;
  /** document-level properties (Creator, LastModifiedDate, ...) */
  meta: Map<string, FcstdProperty>;
}

/** Parse failure detail; currently only XML-level errors (`kind: 'xml'`). */
export type ParseError = { kind: 'xml'; message: string };

function attrs(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes.item(i);
    if (a) out[a.name] = a.value;
  }
  return out;
}

function firstElementChild(el: Element): Element | undefined {
  for (let c = el.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1) return c as Element;
  }
  return undefined;
}

function serialize(el: Element): Promise<string> {
  return serializeXmlNode(el);
}

async function parseProperty(propEl: Element): Promise<FcstdProperty> {
  const children: FcstdProperty[] = [];
  for (let c = propEl.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1) {
      const child = c as Element;
      children.push(await parseProperty(child));
    }
  }
  const valueEl = firstElementChild(propEl);
  return {
    name: propEl.getAttribute('name') ?? '',
    type: propEl.getAttribute('type') ?? '',
    tagName: propEl.tagName,
    attributes: attrs(propEl),
    valueXml: valueEl ? await serialize(valueEl) : undefined,
    valueText: valueEl?.textContent ?? propEl.textContent ?? '',
    children,
  };
}

/**
 * Parse Document.xml into the object graph. Only `<ObjectData>` entries are
 * returned as objects; `<Objects>` feeds `typeIndex`; document meta from
 * `<Document ...>` attributes' sibling properties.
 *
 * @param xml raw Document.xml content
 * @returns the parsed object graph, or an xml ParseError
 */
export async function parseDocumentXml(xml: string): Promise<Result<FcstdDocument, ParseError>> {
  let doc: Document;
  try {
    doc = await parseXmlDocument(xml);
  } catch (e) {
    return err({ kind: 'xml', message: `Document.xml parse failed: ${e instanceof Error ? e.message : String(e)}` });
  }
  const root = doc.documentElement;
  if (!root || root.tagName !== 'Document') {
    return err({ kind: 'xml', message: `root element is <${root?.tagName ?? 'none'}>, expected <Document>` });
  }

  const objects: FcstdObject[] = [];
  const typeIndex = new Map<string, string>();
  const meta = new Map<string, FcstdProperty>();

  for (let n = root.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 1) continue;
    const el = n as Element;
    switch (el.tagName) {
      case 'Objects': {
        for (let c = el.firstChild; c; c = c.nextSibling) {
          if (c.nodeType !== 1) continue;
          const oe = c as Element;
          if (oe.tagName !== 'Object') continue;
          const name = oe.getAttribute('name');
          const type = oe.getAttribute('type');
          if (name && type) typeIndex.set(name, type);
        }
        break;
      }
      case 'ObjectData': {
        for (let c = el.firstChild; c; c = c.nextSibling) {
          if (c.nodeType !== 1) continue;
          const oe = c as Element;
          if (oe.tagName !== 'Object') continue;
          const name = oe.getAttribute('name') ?? '';
          // ObjectData <Object> carries only `name`; the type lives in the
          // <Objects> index (plan §3.3: Objects is the type index).
          const type = oe.getAttribute('type') ?? typeIndex.get(name) ?? '';
          const properties = new Map<string, FcstdProperty>();
          // properties live under a <Properties Count="N"> wrapper element
          for (let p = oe.firstChild; p; p = p.nextSibling) {
            if (p.nodeType !== 1) continue;
            const pe = p as Element;
            if (pe.tagName === 'Properties') {
              for (let q = pe.firstChild; q; q = q.nextSibling) {
                if (q.nodeType !== 1) continue;
                const qe = q as Element;
                if (qe.tagName === '_Property') continue; // transient
                const prop = await parseProperty(qe);
                if (prop.name) properties.set(prop.name, prop);
              }
            } else if (pe.tagName !== '_Property') {
              const prop = await parseProperty(pe);
              if (prop.name) properties.set(prop.name, prop);
            }
          }
          objects.push({ name, type, properties });
        }
        break;
      }
      default: {
        // document meta properties (Creator, Uuid, LastModifiedDate, ...)
        const prop = await parseProperty(el);
        if (prop.name) meta.set(prop.name, prop);
      }
    }
  }
  return ok({ objects, typeIndex, meta });
}
