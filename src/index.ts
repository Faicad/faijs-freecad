/**
 * FCStd read layer (public surface, `@faicad/faijs/fcstd`).
 *
 * Unpacks an .FCStd container and parses `Document.xml` into the object graph,
 * plus the sketch/constraint/expression parse helpers built on top of it. This
 * is the reading half of FCStd support: consumers that inspect documents
 * (profiling, coverage reports, migration tooling) use this entry instead of
 * re-implementing the XML layout.
 *
 * The conversion pipeline (`./convert.js` → `.fai.zip`) is deliberately NOT
 * re-exported here: it pulls the planegcs solver and the occt kernel, which are
 * development/peer dependencies, so importing it would drag a solver into every
 * consumer of the read layer. Conversion is exposed separately.
 */
export { unpackFcstd, memberText } from './unpack.js';
export type { FcstdArchive, FcstdMember, UnpackError } from './unpack.js';
export { parseDocumentXml } from './document.js';
export type { FcstdDocument, FcstdObject, FcstdProperty, ParseError } from './document.js';
export { parseSketchObject, parseGeometryList, parseConstraintList, CONSTRAINT_NAMES } from './sketch-parse.js';
export type { ConstraintType, GeoId, GeoRef, PointPos, SketchCon, SketchGeom, ParsedSketch } from './sketch-parse.js';
export { parseExpressionEngine } from './expressions.js';
export type { ExpressionBinding } from './expressions.js';
// The `.fai.zip` container layer is NOT re-exported here: it is faijs' own
// container format, owned by core (`@faicad/faijs/io/fai-zip`). This package
// only reads FCStd and converts it, so it depends on the container layer
// instead of hosting it.