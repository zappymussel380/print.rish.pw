import { DOMParser, type Document } from "@xmldom/xmldom";
import { ModelParseError } from "./types";

/** Parse untrusted XML, normalising xmldom's fatal errors into ModelParseError. */
export function parseXml(text: string, what: string): Document {
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
