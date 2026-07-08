import { DOMParser, type Document } from "@xmldom/xmldom";
import { ModelParseError } from "./types";

/** Ceiling on XML text handed to the DOM parser. The DOM inflates its input
 *  many times over in memory, so this bounds what one hostile upload can make
 *  the process allocate. Matches the zip entry cap (MAX_ENTRY_BYTES) — the
 *  only XML we parse comes from uploaded model containers. */
export const MAX_XML_BYTES = 128 * 1024 * 1024;

/** Model XML (3MF / AMF) never carries a DTD, but xmldom expands internal
 *  entities, so a DOCTYPE is either garbage or a billion-laughs attempt. A raw
 *  '<!DOCTYPE' cannot appear in well-formed DTD-less XML outside the prolog
 *  (it would have to be escaped), so a whole-document scan is safe and avoids
 *  any prolog-parsing subtlety. Deliberately a simple linear pattern — no
 *  backtracking on ~100 MB inputs. */
const DOCTYPE_RE = /<!DOCTYPE/i;

/** Parse untrusted XML, normalising xmldom's fatal errors into ModelParseError. */
export function parseXml(text: string, what: string): Document {
  if (text.length > MAX_XML_BYTES) {
    throw new ModelParseError(`${what}: XML exceeds ${MAX_XML_BYTES} bytes`);
  }
  if (DOCTYPE_RE.test(text)) {
    throw new ModelParseError(`${what}: DOCTYPE declarations are not allowed`);
  }
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
