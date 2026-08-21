/** Where customers can get printable files.
 *
 * The single most common reason someone lands on the site and leaves again is
 * that they have nothing to upload and do not know these libraries exist. The
 * list lives here, not in a page, because two surfaces render it: the homepage
 * shows `homepage: true` entries, the /find-models page shows all of them.
 */
export interface ModelSource {
  name: string;
  url: string;
  /** One line for the homepage card. */
  short: string;
  /** The fuller version for the dedicated page. */
  long: string;
  /** Cost badge, e.g. "Free" or "Free + paid". */
  cost: string;
  /** Shown on the homepage. Keep this to four so the grid stays one row. */
  homepage: boolean;
}

export const MODEL_SOURCES: readonly ModelSource[] = [
  {
    name: "MakerWorld",
    url: "https://makerworld.com",
    short: "Bambu Lab's own library — profiles are tuned for the printer we run.",
    long: "Bambu Lab's own library, and the best starting point for us: models are often published with print profiles already tuned for Bambu machines, and many download as 3MF with orientation and settings intact. Huge, active, and free.",
    cost: "Free",
    homepage: true,
  },
  {
    name: "Printables",
    url: "https://printables.com",
    short: "Prusa's library. Big, well moderated, strong on practical parts.",
    long: "Run by Prusa. Excellent moderation and model quality, with a strong bias toward genuinely useful, functional parts — brackets, organisers, replacements, tools. Everything is free, and the contests mean a steady stream of new designs.",
    cost: "Free",
    homepage: true,
  },
  {
    name: "Thingiverse",
    url: "https://thingiverse.com",
    short: "The oldest and largest archive. Quality varies, coverage is enormous.",
    long: "The original model repository and still the largest archive by volume. Quality is inconsistent and some files are old, but if a thing has ever been modelled for 3D printing, there is a fair chance it is here.",
    cost: "Free",
    homepage: true,
  },
  {
    name: "Yeggi",
    url: "https://yeggi.com",
    short: "A search engine across all the libraries — start here if you're hunting.",
    long: "Not a library but a search engine across all of them at once. If you know what you want and do not care where it comes from, search here first and follow the result to whichever site hosts it.",
    cost: "Free",
    homepage: true,
  },
  {
    name: "Thangs",
    url: "https://thangs.com",
    short: "Search by shape as well as by name, and mirrors other sites.",
    long: "Indexes other libraries and adds geometric search — you can look for models that resemble a shape, not just ones tagged with the right word. Useful when you are trying to find a part and do not know what it is called.",
    cost: "Free",
    homepage: false,
  },
  {
    name: "Cults3D",
    url: "https://cults3d.com",
    short: "Designer marketplace — a lot of free models alongside paid ones.",
    long: "A marketplace where independent designers sell their work, mixed with a large free section. Worth a look for more decorative or artistic pieces that the functional-parts libraries do not cover as well.",
    cost: "Free + paid",
    homepage: false,
  },
];

export const HOMEPAGE_MODEL_SOURCES = MODEL_SOURCES.filter((source) => source.homepage);
