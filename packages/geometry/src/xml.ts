import { DOMParser, type Document } from "@xmldom/xmldom";
import { ModelParseError } from "./types";

/** Ceiling on XML text handed to the DOM parser. The DOM inflates its input
 *  many times over in memory, so this bounds what one hostile upload can make
 *  the process allocate. Uploaded 3MF/AMF is the only input.
 *
 *  Sized from real slicer output, not from the transport ceiling. A 1.26M
 *  triangle Bambu Studio export carries a 99.8 MiB `3D/3dmodel.model` (at an
 *  ordinary 6:1 deflate ratio - detailed models are not zip bombs), and the
 *  previous 8 MiB ceiling rejected it as one. 128 MiB clears that with room
 *  for roughly 1.6M triangles.
 *
 *  Bytes are the cheap first filter; MAX_XML_ELEMENTS below is the bound that
 *  actually caps memory, since xmldom costs ~1.7 KiB per element regardless of
 *  how few bytes each one occupies. */
export const MAX_XML_BYTES = 128 * 1024 * 1024;
/** Hard bound on DOM node count, enforced by `preflightXml` *before* xmldom
 *  allocates anything. This is the real memory limit: at ~1.7 KiB of DOM per
 *  element, 2.5M elements is roughly 3.4 GiB peak in the parse child, which is
 *  survivable inside the worker's memory limit alongside a concurrent slice.
 *  The 1.26M triangle reference model needs 1.89M (one element per triangle
 *  plus one per vertex); raise this only together with that memory budget. */
export const MAX_XML_ELEMENTS = 2_500_000;
export const MAX_XML_DEPTH = 128;
const MAX_TAG_CHARS = 64 * 1024;

/** Model XML (3MF / AMF) never carries a DTD, but xmldom expands internal
 *  entities, so a DOCTYPE is either garbage or a billion-laughs attempt. A raw
 *  '<!DOCTYPE' cannot appear in well-formed DTD-less XML outside the prolog
 *  (it would have to be escaped), so a whole-document scan is safe and avoids
 *  any prolog-parsing subtlety. Deliberately a simple linear pattern — no
 *  backtracking on ~100 MB inputs. */
const DOCTYPE_RE = /<!DOCTYPE/i;

/** Parse untrusted XML, normalising xmldom's fatal errors into ModelParseError. */
export function parseXml(text: string, what: string): Document {
  if (Buffer.byteLength(text, "utf8") > MAX_XML_BYTES) {
    throw new ModelParseError(`${what}: XML exceeds ${MAX_XML_BYTES} bytes`);
  }
  if (DOCTYPE_RE.test(text)) {
    throw new ModelParseError(`${what}: DOCTYPE declarations are not allowed`);
  }
  preflightXml(text, what);
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

/** Check bytes before decoding. Raw AMF uploads can be as large as the 300 MiB
 * transport ceiling; converting first would allocate the full hostile string
 * before parseXml had a chance to reject it. */
export function parseXmlBuffer(buffer: Buffer, what: string): Document {
  if (buffer.length > MAX_XML_BYTES) {
    throw new ModelParseError(`${what}: XML exceeds ${MAX_XML_BYTES} bytes`, "TOO_COMPLEX");
  }
  return parseXml(buffer.toString("utf8"), what);
}

/** A small allocation-free XML preflight before xmldom builds its high-overhead
 * tree. It bounds element count, depth and tag length; comments, CDATA and
 * processing instructions are skipped explicitly. Full syntax validation still
 * belongs to xmldom after these resource limits pass. */
function preflightXml(text: string, what: string): void {
  let cursor = 0;
  let elements = 0;
  let depth = 0;

  while (true) {
    const start = text.indexOf("<", cursor);
    if (start < 0) break;

    if (text.startsWith("<!--", start)) {
      const end = text.indexOf("-->", start + 4);
      if (end < 0) throw new ModelParseError(`${what}: unterminated XML comment`);
      cursor = end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", start)) {
      const end = text.indexOf("]]>", start + 9);
      if (end < 0) throw new ModelParseError(`${what}: unterminated CDATA section`);
      cursor = end + 3;
      continue;
    }
    if (text.startsWith("<?", start)) {
      const end = text.indexOf("?>", start + 2);
      if (end < 0) throw new ModelParseError(`${what}: unterminated processing instruction`);
      cursor = end + 2;
      continue;
    }
    if (text.startsWith("<!", start)) {
      throw new ModelParseError(`${what}: XML declarations are not allowed`);
    }

    let quote = "";
    let end = start + 1;
    for (; end < text.length && end - start <= MAX_TAG_CHARS; end++) {
      const char = text[end]!;
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
    }
    if (end >= text.length || text[end] !== ">") {
      throw new ModelParseError(`${what}: XML tag is unterminated or too long`, "TOO_COMPLEX");
    }

    const closing = text[start + 1] === "/";
    let tail = end - 1;
    while (tail > start && /\s/.test(text[tail]!)) tail--;
    const selfClosing = text[tail] === "/";
    if (closing) {
      depth = Math.max(0, depth - 1);
    } else {
      elements += 1;
      if (elements > MAX_XML_ELEMENTS) {
        throw new ModelParseError(
          `${what}: XML exceeds ${MAX_XML_ELEMENTS} elements`,
          "TOO_COMPLEX",
        );
      }
      if (!selfClosing) {
        depth += 1;
        if (depth > MAX_XML_DEPTH) {
          throw new ModelParseError(`${what}: XML nesting is too deep`, "TOO_COMPLEX");
        }
      }
    }
    cursor = end + 1;
  }
}
