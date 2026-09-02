import { DOMParser, type Document } from "@xmldom/xmldom";
import { ModelParseError } from "./types";

/** Ceiling on XML text handed to the DOM parser. The DOM inflates its input
 *  many times over in memory, so this bounds what one hostile upload can make
 *  the process allocate.
 *
 *  This governs the *DOM* path only: raw AMF, 3MF plate/project settings, and
 *  the structural skeleton a streamed 3MF model part is reduced to. Mesh-heavy
 *  3MF model parts are no longer measured against it — they never become DOM
 *  at all (see `scanXmlTags` and `threemf.ts`), and carry the far larger
 *  MAX_MESH_XML_BYTES instead.
 *
 *  Deliberately well below the transport ceiling: nothing that legitimately
 *  reaches the DOM parser is large. A dense mesh used to arrive here, which is
 *  what forced this constant up to 128 MiB; now that it cannot, the bound goes
 *  back to a size whose DOM comfortably fits the parse child's heap. */
export const MAX_XML_BYTES = 32 * 1024 * 1024;
/** Hard bound on DOM node count, enforced *before* xmldom allocates anything.
 *  At ~1.7 KiB of DOM per element, 400k elements is roughly 700 MiB peak —
 *  survivable inside the parse child's heap alongside a concurrent slice.
 *  Like MAX_XML_BYTES this is a DOM-path bound; streamed 3MF mesh content is
 *  bounded by MAX_TRIANGLES / MAX_VERTICES instead, and the skeleton left
 *  behind by MAX_SKELETON_ELEMENTS. */
export const MAX_XML_ELEMENTS = 400_000;

/** Ceiling on a 3MF model part that will be *streamed* rather than parsed into
 *  a DOM. Mesh text is read straight from the buffer into typed arrays, so the
 *  cost of these bytes is a linear scan and no retained allocation; what the
 *  resulting mesh costs is capped separately by MAX_TRIANGLES / MAX_VERTICES.
 *
 *  Sized so MAX_TRIANGLES is actually reachable: a 4M triangle mesh with 2.5M
 *  vertices runs to roughly 400 MiB of `<vertex>` / `<triangle>` text. Before
 *  streaming, the XML ceiling — not the triangle ceiling — was what every
 *  detailed 3MF hit first, which is the bug this pair of constants exists to
 *  keep fixed. */
export const MAX_MESH_XML_BYTES = 512 * 1024 * 1024;
/** Bound on what survives mesh excision. A 3MF's structure — objects,
 *  components, build items, metadata — is tiny however dense its geometry is;
 *  the reference 1.26M triangle export leaves roughly 40 elements once its two
 *  meshes are excised. This is what MAX_XML_ELEMENTS meant before mesh data
 *  was forced through the DOM: a bound on structural complexity, not a stand-in
 *  for a memory budget. */
export const MAX_SKELETON_ELEMENTS = 100_000;

export const MAX_XML_DEPTH = 128;
const MAX_TAG_CHARS = 64 * 1024;

const LT = 0x3c; // <
const GT = 0x3e; // >
const SLASH = 0x2f; // /
const BANG = 0x21; // !
const DQUOTE = 0x22; // "
const SQUOTE = 0x27; // '
const COLON = 0x3a; // :
const EQUALS = 0x3d; // =

/** Model XML (3MF / AMF) never carries a DTD, but xmldom expands internal
 *  entities, so a DOCTYPE is either garbage or a billion-laughs attempt. A raw
 *  '<!DOCTYPE' cannot appear in well-formed DTD-less XML outside the prolog
 *  (it would have to be escaped), so a whole-document scan is safe and avoids
 *  any prolog-parsing subtlety. Deliberately a simple linear pattern — no
 *  backtracking on ~100 MB inputs. */
const DOCTYPE_RE = /<!DOCTYPE/i;
/** The byte form of the same check, for inputs we never decode to a string. */
const DOCTYPE_BYTES = Buffer.from("<!DOCTYPE", "latin1");

/** A tag the scanner is currently sitting on.
 *
 *  ONE cursor object is reused for every tag in a document — scanning a 4M
 *  triangle mesh must not allocate 8M short-lived objects. Its fields are only
 *  meaningful for the duration of the visitor call; copy anything you intend
 *  to keep. */
export interface XmlTagCursor {
  /** Byte range of the local name, with any namespace prefix stripped. */
  nameStart: number;
  nameEnd: number;
  /** Byte range of the whole tag, from `<` up to and including `>`. */
  start: number;
  end: number;
  closing: boolean;
  selfClosing: boolean;
  /** Nesting depth of this element, counting the document element as 1. */
  depth: number;
}

export interface XmlScanRange {
  from?: number;
  to?: number;
}

/**
 * Walk every tag in `buf` without allocating a DOM, calling `visit` for each.
 *
 * This is the shared spine of both XML paths: the DOM path uses it to bound
 * element count and nesting *before* handing text to xmldom, and the 3MF path
 * uses it to locate mesh spans and to read vertices and triangles straight out
 * of the buffer.
 *
 * Comments, CDATA sections and processing instructions are skipped as units,
 * so markup quoted inside them is never mistaken for a tag — the reason mesh
 * spans must be found through this function and never with `indexOf("<mesh")`.
 *
 * Byte-level scanning is safe on UTF-8 input: no continuation byte falls below
 * 0x80, so a search for `<`, `>`, `"` or `'` can never land mid-character, and
 * every offset reported here is therefore also a safe place to cut a string.
 *
 * Structural validation beyond resource limits is still xmldom's job; this
 * deliberately accepts more than it should rather than duplicating a parser.
 */
export function scanXmlTags(
  buf: Buffer,
  what: string,
  visit: (tag: XmlTagCursor) => void,
  range: XmlScanRange = {},
): void {
  const from = range.from ?? 0;
  const to = range.to ?? buf.length;
  const cursor: XmlTagCursor = {
    nameStart: 0,
    nameEnd: 0,
    start: 0,
    end: 0,
    closing: false,
    selfClosing: false,
    depth: 0,
  };
  let at = from;
  let depth = 0;

  while (at < to) {
    const start = buf.indexOf(LT, at);
    if (start < 0 || start >= to) break;

    if (matches(buf, start, "<!--", to)) {
      at = skipTo(buf, start + 4, "-->", to, what, "XML comment");
      continue;
    }
    if (matches(buf, start, "<![CDATA[", to)) {
      at = skipTo(buf, start + 9, "]]>", to, what, "CDATA section");
      continue;
    }
    if (matches(buf, start, "<?", to)) {
      at = skipTo(buf, start + 2, "?>", to, what, "processing instruction");
      continue;
    }
    if (start + 1 < to && buf[start + 1] === BANG) {
      throw new ModelParseError(`${what}: XML declarations are not allowed`);
    }

    // Find the tag's '>', ignoring any that sits inside a quoted attribute.
    let quote = 0;
    let end = start + 1;
    for (; end < to && end - start <= MAX_TAG_CHARS; end++) {
      const byte = buf[end]!;
      if (quote) {
        if (byte === quote) quote = 0;
      } else if (byte === DQUOTE || byte === SQUOTE) {
        quote = byte;
      } else if (byte === GT) {
        break;
      }
    }
    if (end >= to || buf[end] !== GT) {
      throw new ModelParseError(`${what}: XML tag is unterminated or too long`, "TOO_COMPLEX");
    }

    const closing = buf[start + 1] === SLASH;
    let tail = end - 1;
    while (tail > start && isSpace(buf[tail]!)) tail--;
    const selfClosing = !closing && buf[tail] === SLASH;

    // Local name: everything up to whitespace, '/' or '>', after any prefix.
    let nameStart = start + (closing ? 2 : 1);
    let nameEnd = nameStart;
    while (nameEnd < end) {
      const byte = buf[nameEnd]!;
      if (isSpace(byte) || byte === SLASH || byte === GT) break;
      if (byte === COLON) nameStart = nameEnd + 1;
      nameEnd++;
    }

    if (closing) {
      depth = Math.max(0, depth - 1);
      cursor.depth = depth + 1;
    } else {
      cursor.depth = depth + 1;
      if (!selfClosing) {
        depth += 1;
        if (depth > MAX_XML_DEPTH) {
          throw new ModelParseError(`${what}: XML nesting is too deep`, "TOO_COMPLEX");
        }
      }
    }

    cursor.nameStart = nameStart;
    cursor.nameEnd = nameEnd;
    cursor.start = start;
    cursor.end = end + 1;
    cursor.closing = closing;
    cursor.selfClosing = selfClosing;
    visit(cursor);

    at = end + 1;
  }
}

/** Visit each `name="value"` pair in a tag, reporting byte ranges only. Values
 *  keep their source escaping; numeric attributes never carry entities, and a
 *  malformed one becomes NaN exactly as `Number(getAttribute(...))` would. */
export function scanTagAttributes(
  buf: Buffer,
  tagStart: number,
  tagEnd: number,
  visit: (nameStart: number, nameEnd: number, valueStart: number, valueEnd: number) => void,
): void {
  // Skip '<', the optional '/', and the element name.
  let at = tagStart + 1;
  while (at < tagEnd && !isSpace(buf[at]!) && buf[at] !== GT && buf[at] !== SLASH) at++;

  while (at < tagEnd) {
    while (at < tagEnd && isSpace(buf[at]!)) at++;
    const nameStart = at;
    while (at < tagEnd && !isSpace(buf[at]!) && buf[at] !== EQUALS && buf[at] !== GT && buf[at] !== SLASH) {
      at++;
    }
    const nameEnd = at;
    if (nameEnd === nameStart) break;
    while (at < tagEnd && isSpace(buf[at]!)) at++;
    if (buf[at] !== EQUALS) continue;
    at++;
    while (at < tagEnd && isSpace(buf[at]!)) at++;
    const quote = buf[at]!;
    if (quote !== DQUOTE && quote !== SQUOTE) break;
    at++;
    const valueStart = at;
    while (at < tagEnd && buf[at] !== quote) at++;
    if (at >= tagEnd) break;
    visit(nameStart, nameEnd, valueStart, at);
    at++;
  }
}

/** True when a tag's local name equals `name` (ASCII, case-sensitive). */
export function tagNameIs(buf: Buffer, tag: XmlTagCursor, name: string): boolean {
  if (tag.nameEnd - tag.nameStart !== name.length) return false;
  for (let i = 0; i < name.length; i++) {
    if (buf[tag.nameStart + i] !== name.charCodeAt(i)) return false;
  }
  return true;
}

/** True when a byte range equals `name` (ASCII, case-sensitive). */
export function bytesAre(buf: Buffer, start: number, end: number, name: string): boolean {
  if (end - start !== name.length) return false;
  for (let i = 0; i < name.length; i++) {
    if (buf[start + i] !== name.charCodeAt(i)) return false;
  }
  return true;
}

/** Reject a DOCTYPE in input we never decode to a string.
 *
 *  Only `<!` sequences are examined, not every `<`: mesh XML carries millions
 *  of tags and no markup declarations at all, so this walks a handful of
 *  candidates rather than the whole tag stream. */
export function rejectDoctypeBytes(buf: Buffer, what: string): void {
  for (let at = buf.indexOf("<!", 0, "latin1"); at >= 0; at = buf.indexOf("<!", at + 2, "latin1")) {
    if (at + DOCTYPE_BYTES.length > buf.length) break;
    let hit = true;
    // Case-insensitive across the keyword, which is all XML permits to vary.
    for (let i = 2; i < DOCTYPE_BYTES.length; i++) {
      const want = DOCTYPE_BYTES[i]!;
      const got = buf[at + i]!;
      if (got !== want && (got | 0x20) !== (want | 0x20)) {
        hit = false;
        break;
      }
    }
    if (hit) throw new ModelParseError(`${what}: DOCTYPE declarations are not allowed`);
  }
}

/** Parse untrusted XML, normalising xmldom's fatal errors into ModelParseError. */
export function parseXml(text: string, what: string): Document {
  if (Buffer.byteLength(text, "utf8") > MAX_XML_BYTES) {
    throw new ModelParseError(`${what}: XML exceeds ${MAX_XML_BYTES} bytes`);
  }
  if (DOCTYPE_RE.test(text)) {
    throw new ModelParseError(`${what}: DOCTYPE declarations are not allowed`);
  }
  preflightXml(Buffer.from(text, "utf8"), what);
  return domParse(text, what);
}

/** Check bytes before decoding. Raw AMF uploads can be as large as the 300 MiB
 * transport ceiling; converting first would allocate the full hostile string
 * before parseXml had a chance to reject it. */
export function parseXmlBuffer(buffer: Buffer, what: string): Document {
  if (buffer.length > MAX_XML_BYTES) {
    throw new ModelParseError(`${what}: XML exceeds ${MAX_XML_BYTES} bytes`, "TOO_COMPLEX");
  }
  rejectDoctypeBytes(buffer, what);
  preflightXml(buffer, what);
  return domParse(buffer.toString("utf8"), what);
}

function domParse(text: string, what: string): Document {
  try {
    const doc = new DOMParser({
      onError: (level, message) => {
        if (level === "fatalError") throw new ModelParseError(`${what}: ${message}`);
      },
    }).parseFromString(text, "text/xml");
    if (!doc.documentElement) throw new ModelParseError(`${what}: empty document`);
    return doc;
  } catch (err) {
    if (err instanceof ModelParseError) throw err;
    throw new ModelParseError(`${what}: not valid XML`);
  }
}

/** Bound element count and nesting before xmldom builds its high-overhead tree.
 * Full syntax validation still belongs to xmldom after these limits pass. */
export function preflightXml(buf: Buffer, what: string): void {
  let elements = 0;
  scanXmlTags(buf, what, (tag) => {
    if (tag.closing) return;
    elements += 1;
    if (elements > MAX_XML_ELEMENTS) {
      throw new ModelParseError(
        `${what}: XML exceeds ${MAX_XML_ELEMENTS} elements`,
        "TOO_COMPLEX",
      );
    }
  });
}

function isSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function matches(buf: Buffer, at: number, literal: string, to: number): boolean {
  if (at + literal.length > to) return false;
  for (let i = 0; i < literal.length; i++) {
    if (buf[at + i] !== literal.charCodeAt(i)) return false;
  }
  return true;
}

function skipTo(
  buf: Buffer,
  from: number,
  terminator: string,
  to: number,
  what: string,
  label: string,
): number {
  const end = buf.indexOf(terminator, from, "latin1");
  if (end < 0 || end >= to) throw new ModelParseError(`${what}: unterminated ${label}`);
  return end + terminator.length;
}
