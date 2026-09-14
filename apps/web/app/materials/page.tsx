import type { Metadata } from "next";
import Link from "next/link";
import {
  MATERIAL_GUIDE,
  MATERIAL_GUIDE_ROWS,
  listJoin,
  materialName,
  type StockMaterialId,
} from "@print/shared";
import { PageIntro } from "@/components/shell/page-intro";
import { getPricing } from "@/lib/pricing-settings";
import { getSiteProfile } from "@/lib/site-profile";

/** "PLA or PETG", "PLA, PETG or ABS". */
function orJoin(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

export async function generateMetadata(): Promise<Metadata> {
  const { materialsPage } = await getSiteProfile();
  return {
    title: "Materials",
    description: `${materialsPage.length === 2 ? materialsPage.map((m) => materialName(m)).join(" vs ") : listJoin(materialsPage.map((m) => materialName(m)))} compared: strength, flexibility, temperature and UV resistance, print quality and what to use each for.`,
  };
}

/** The shop chooses which materials this page compares (admin → Site). */
export default async function MaterialsPage() {
  const [{ materialsPage }, { catalog }] = await Promise.all([getSiteProfile(), getPricing()]);
  const shown: StockMaterialId[] = materialsPage;
  const names = shown.map((m) => materialName(m));
  const printer = catalog.printers[catalog.defaultPrinterId]!.name;
  const pair = shown.length === 2;

  return (
    <div className="mx-auto max-w-6xl px-5 py-16 sm:py-20">
      <PageIntro
        eyebrow="Materials"
        title={shown.length === 1 ? `About ${names[0]}` : `${orJoin(names)}?`}
        lede={
          shown.length === 1
            ? `What ${names[0]} is good at on the ${printer}, and where it struggles.`
            : `${pair ? "Both" : "All of them"} print beautifully on the ${printer}. The right choice depends on where the part lives and what it has to survive.`
        }
      />

      <div className="mx-auto mt-10 max-w-4xl md:hidden">
        <div className="border-y border-line">
          {MATERIAL_GUIDE_ROWS.map((row) => (
            <article key={row.key} className="border-b border-line py-5 last:border-b-0">
              <h2 className="text-sm font-[700] text-text">{row.label}</h2>
              {/* Two materials sit side by side on wider phones; more stack. */}
              <div className={`mt-4 grid gap-4 ${pair ? "min-[520px]:grid-cols-2" : ""}`}>
                {shown.map((m, i) => (
                  <section
                    key={m}
                    className={`min-w-0 ${
                      i === 0
                        ? ""
                        : pair
                          ? "border-t border-line pt-4 min-[520px]:border-t-0 min-[520px]:border-l min-[520px]:pt-0 min-[520px]:pl-4"
                          : "border-t border-line pt-4"
                    }`}
                  >
                    <h3 className="chip chip-accent w-fit">{materialName(m)}</h3>
                    <p className="mt-2 text-sm leading-6 text-muted">{MATERIAL_GUIDE[m][row.key]}</p>
                  </section>
                ))}
              </div>
            </article>
          ))}
        </div>
      </div>

      {/* The original two-column comparison keeps its width; more columns get
          the page's full width and, past that, scroll. */}
      <div
        className={`mx-auto mt-12 hidden overflow-x-auto md:block ${pair || shown.length === 1 ? "max-w-4xl" : "max-w-6xl"}`}
      >
        <table
          className="w-full border-collapse text-sm"
          style={{ minWidth: `${Math.max(36, 11 + shown.length * 11.5)}rem` }}
        >
          <caption className="sr-only">Comparison of {listJoin(names)} properties</caption>
          <thead>
            <tr>
              <th scope="col" className="w-44 pb-4 text-left align-bottom">
                <span className="eyebrow text-[0.7rem]">Property</span>
              </th>
              {shown.map((m) => (
                <th key={m} scope="col" className="tile rounded-b-none border-b-0 p-4 text-left">
                  <span className="text-base font-[650]">{materialName(m)}</span>
                  <span className="mt-1 block text-xs font-[450] text-muted">
                    {MATERIAL_GUIDE[m].subtitle}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {MATERIAL_GUIDE_ROWS.map((row) => (
              <tr key={row.key} className="border-t border-line">
                <th scope="row" className="py-4 pr-4 text-left align-top font-[650] text-text">
                  {row.label}
                </th>
                {shown.map((m) => (
                  <td key={m} className="border-x border-line bg-surface p-4 align-top leading-6 text-muted">
                    {MATERIAL_GUIDE[m][row.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mx-auto mt-12 max-w-4xl text-sm leading-7 text-muted">
        <p>
          {shown.includes("PLA") && shown.includes("PETG") ? (
            <>
              Rule of thumb: if it&apos;s decorative or a prototype, choose{" "}
              <strong className="text-text">PLA</strong>. If it clamps, carries load, lives outside or
              gets warm, spend the little extra on <strong className="text-text">PETG</strong>.{" "}
            </>
          ) : null}
          Still unsure? Mention what the part is for in the notes when you submit your quote —
          we&apos;ll flag it if the material looks wrong.
        </p>
        <Link href="/quote" className="btn-pill mt-8">
          Upload a model
        </Link>
      </div>
    </div>
  );
}
