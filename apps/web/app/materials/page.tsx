import type { Metadata } from "next";
import Link from "next/link";
import { PageIntro } from "@/components/shell/page-intro";

export const metadata: Metadata = {
  title: "Materials",
  description: "PLA vs PETG compared: strength, flexibility, temperature and UV resistance, print quality and what to use each for.",
};

const rows: { label: string; pla: string; petg: string }[] = [
  {
    label: "Strength",
    pla: "Stiff and strong in static loads; can be brittle under impact.",
    petg: "Slightly less stiff but much tougher — absorbs impacts without cracking.",
  },
  {
    label: "Flexibility",
    pla: "Low — snaps rather than bends.",
    petg: "Moderate — flexes and springs back, good for clips and snap-fits.",
  },
  {
    label: "Temperature resistance",
    pla: "Softens around 55–60 °C. Keep out of parked cars and direct sun.",
    petg: "Comfortable up to ~75–80 °C. Fine for warm environments and enclosures.",
  },
  {
    label: "UV / outdoor resistance",
    pla: "Degrades and fades with prolonged sun exposure.",
    petg: "Good UV and moisture resistance — the default for outdoor parts.",
  },
  {
    label: "Print quality",
    pla: "Excellent — sharp corners, clean overhangs, the best-looking surface finish.",
    petg: "Very good, slightly glossier; fine details are a touch softer than PLA.",
  },
  {
    label: "Best for",
    pla: "Prototypes, figurines, architectural models, jigs, indoor decorative parts.",
    petg: "Functional parts, brackets, enclosures, planters, anything outdoors or load-bearing.",
  },
];

export default function MaterialsPage() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-16 sm:py-20">
      <PageIntro
        eyebrow="Materials"
        title="PLA or PETG?"
        lede="Both print beautifully on the Bambu Lab A1 in black or white. The right choice depends on where the part lives and what it has to survive."
      />

      <div className="mx-auto mt-12 max-w-4xl overflow-x-auto">
        <table className="w-full min-w-[36rem] border-collapse text-sm">
          <caption className="sr-only">Comparison of PLA and PETG properties</caption>
          <thead>
            <tr>
              <th scope="col" className="w-44 pb-4 text-left align-bottom">
                <span className="eyebrow text-[0.7rem]">Property</span>
              </th>
              <th scope="col" className="tile rounded-b-none border-b-0 p-4 text-left">
                <span className="text-base font-[650]">PLA</span>
                <span className="mt-1 block text-xs font-[450] text-muted">Polylactic acid</span>
              </th>
              <th scope="col" className="tile rounded-b-none border-b-0 p-4 text-left">
                <span className="text-base font-[650]">PETG</span>
                <span className="mt-1 block text-xs font-[450] text-muted">
                  Glycol-modified PET
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-t border-line">
                <th scope="row" className="py-4 pr-4 text-left align-top font-[650] text-text">
                  {row.label}
                </th>
                <td className="border-x border-line bg-surface p-4 align-top leading-6 text-muted">
                  {row.pla}
                </td>
                <td className="border-x border-line bg-surface p-4 align-top leading-6 text-muted">
                  {row.petg}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mx-auto mt-12 max-w-4xl text-sm leading-7 text-muted">
        <p>
          Rule of thumb: if it's decorative or a prototype, choose <strong className="text-text">PLA</strong>.
          If it clamps, carries load, lives outside or gets warm, spend the little extra on{" "}
          <strong className="text-text">PETG</strong>. Still unsure? Mention what the part is for in
          the notes when you submit your quote — we'll flag it if the material looks wrong.
        </p>
        <Link href="/quote" className="btn-pill mt-8">
          Upload a model
        </Link>
      </div>
    </div>
  );
}
