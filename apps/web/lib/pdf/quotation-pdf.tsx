import * as React from "react";
import {
  Document,
  Image,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";
import {
  ACCENTS,
  colourName,
  formatDuration,
  formatGrams,
  formatPaise,
  formatTotal,
  materialName,
  formatTaxRate,
  splitBrand,
  supportsSummary,
  type MaterialId,
  type SupportMode,
} from "@print/shared";
import { formatBytes, formatDimensions, formatVolume } from "@/lib/format";
import { getPrinterSpec } from "@/lib/printer";
import { PrinterMarkPdf } from "./printer-mark-pdf";

/** react-pdf cannot load a variable-weight woff2, so the PDF uses the built-in
 *  Helvetica family (no font registration, no external assets). The on-screen
 *  UI keeps Inter; the PDF stays crisp and dependency-free. */

export interface PdfLine {
  fileName: string;
  material: MaterialId;
  colour: string;
  /** Name captured at submission; falls back to the palette lookup when null. */
  colourName?: string | null;
  /** Likewise for the shop's own (renamable) materials. */
  materialName?: string | null;
  layerHeightUm: number;
  infillPct: number;
  supports: SupportMode;
  /** Grams of supports the slice generated per print; null when not measured. */
  supportGrams?: number | null;
  quantity: number;
  totalGrams: number;
  totalPrintSeconds: number;
  subtotalPaise: number;
}

/** One annexure page per quotation line: everything the web quote card shows
 *  about the model, so the buyer and the printer operator read the same spec. */
export interface PdfAnnexure {
  fileName: string;
  thumbnailPng: Buffer | null;
  geometry: {
    bboxXMm: number;
    bboxYMm: number;
    bboxZMm: number;
    volumeCm3: number;
    format: string;
    sizeBytes: number;
  };
  settings: {
    material: MaterialId;
    colour: string;
    colourName?: string | null;
    materialName?: string | null;
    layerHeightUm: number;
    infillPct: number;
    supports: SupportMode;
    quantity: number;
  };
  slicer: {
    filamentGrams: number;
    filamentMm: number;
    printSeconds: number;
    slicerVersion: string | null;
    /** Of filamentGrams, how much is supports; null when not measured. */
    supportGrams: number | null;
  };
  pricing: {
    materialPaise: number;
    electricityPaise: number;
    maintenancePaise: number;
    subtotalPaise: number;
  };
}

export interface QuotationPdfData {
  /** The shop's name (SiteProfile.brandName) for the letterhead and footer. */
  brandName: string;
  /** The site's accent for print (`ACCENTS[id].pdf`); the original coral when omitted. */
  accent?: string;
  number: string;
  createdAt: Date;
  customer: { name: string; email: string; phone: string; city: string; notes: string };
  lines: PdfLine[];
  setupFeePaise: number;
  shippingPaise?: number;
  /** GST included in totalPaise, frozen at submission; null/absent when none. */
  tax?: { paise: number; rateBp: number; hsn: string | null; gstin: string | null } | null;
  /** What rounding to a whole rupee added, inside totalPaise; 0/absent before round off. */
  roundOffPaise?: number;
  totalPaise: number;
  totalGrams: number;
  totalPrintSeconds: number;
  completion: Date | null;
  annexures: PdfAnnexure[];
  /** The printer it was sliced for; the installed one when omitted. */
  printer?: PdfPrinter;
}

const DEFAULT_ACCENT = ACCENTS.red.pdf;
const INK = "#111111";
const MUTED = "#6b6b6b";
const LINE = "#e2e2e2";

const s = StyleSheet.create({
  page: { paddingTop: 44, paddingBottom: 56, paddingHorizontal: 44, fontFamily: "Helvetica", fontSize: 9, color: INK },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  wordmark: { fontFamily: "Helvetica-Bold", fontSize: 15 },
  wordmarkCompact: { fontFamily: "Helvetica-Bold", fontSize: 10 },
  docTitle: { fontFamily: "Helvetica-Bold", fontSize: 20, marginBottom: 2 },
  metaRight: { textAlign: "right", color: MUTED, fontSize: 9 },
  rule: { height: 2, width: 46, marginTop: 14, marginBottom: 20 },
  sectionLabel: { fontFamily: "Helvetica-Bold", fontSize: 8, letterSpacing: 1.4, color: MUTED, textTransform: "uppercase", marginBottom: 6 },
  twoCol: { flexDirection: "row", justifyContent: "space-between", marginBottom: 22 },
  col: { width: "48%" },
  kv: { marginBottom: 2 },
  tableHead: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: INK, paddingBottom: 5, marginBottom: 4 },
  row: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: LINE, paddingVertical: 6 },
  cFile: { width: "34%", paddingRight: 6 },
  cSpec: { width: "26%", paddingRight: 6, color: MUTED },
  cNum: { width: "13%", textAlign: "right" },
  cPrice: { width: "14%", textAlign: "right" },
  th: { fontFamily: "Helvetica-Bold", fontSize: 8, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6 },
  fileName: { fontFamily: "Helvetica-Bold", fontSize: 9 },
  totals: { marginTop: 14, marginLeft: "auto", width: "45%" },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  grandRow: { flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: INK, marginTop: 6, paddingTop: 8 },
  grandLabel: { fontFamily: "Helvetica-Bold", fontSize: 12 },
  grandValue: { fontFamily: "Helvetica-Bold", fontSize: 12 },
  footer: { position: "absolute", bottom: 30, left: 44, right: 44, borderTopWidth: 1, borderTopColor: LINE, paddingTop: 10, color: MUTED, fontSize: 7.5, lineHeight: 1.4 },
  annexTitle: { fontFamily: "Helvetica-Bold", fontSize: 14 },
  thumbBox: { borderWidth: 1, borderColor: LINE, height: 250, alignItems: "center", justifyContent: "center", padding: 8, marginTop: 16, marginBottom: 20 },
  kvRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 3 },
});

const fmtDate = (d: Date) =>
  new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(d);

/** Site wordmark, mirroring the web header: printer mark + the shop's name,
 *  its first part in the accent colour. */
function Letterhead({ brandName, accent, compact = false }: { brandName: string; accent: string; compact?: boolean }) {
  const brand = splitBrand(brandName);
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      <PrinterMarkPdf size={compact ? 15 : 22} color={accent} />
      <View style={{ marginLeft: 6 }}>
        <Text style={compact ? s.wordmarkCompact : s.wordmark}>
          <Text style={{ color: accent }}>{brand.accent}</Text>
          {brand.rest}
        </Text>
        {!compact && <Text style={{ color: MUTED, marginTop: 2 }}>Instant 3D-printing quotation</Text>}
      </View>
    </View>
  );
}

type PdfPrinter = { name: string; nozzleMm: number };

function PdfFooter({ number, brandName, printer }: { number: string; brandName: string; printer: PdfPrinter }) {
  return (
    <View style={s.footer} fixed>
      <Text>
        This quotation is an estimate generated from real OrcaSlicer slicing on a {printer.name}{" "}
        ({printer.nozzleMm}mm nozzle). Prices are in Indian Rupees and include a one-time setup fee. Filament
        weight and print time come directly from the slicer. This is not a tax invoice.
      </Text>
      <Text style={{ marginTop: 4 }}>
        Final confirmation and payment are arranged over WhatsApp. Quotation {number} ·{" "}
        {brandName}
      </Text>
    </View>
  );
}

// Built-in Helvetica has no ₹ (U+20B9) glyph, so use an ASCII "Rs" in the PDF.
const money = (paise: number) => formatPaise(paise).replace("₹", "Rs ");
// The PDF's built-in font has neither ₹ nor the Unicode minus.
const totalMoney = (paise: number) => formatTotal(paise).replace("₹", "Rs ");
const roundOffMoney = (paise: number) => `${paise < 0 ? "-" : "+"}${money(Math.abs(paise))}`;

const LAYER = (um: number) => `${(um / 1000).toFixed(2)}mm`;

function KV({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.kvRow}>
      <Text style={{ color: MUTED }}>{label}</Text>
      <Text>{value}</Text>
    </View>
  );
}

function AnnexurePage({
  annexure,
  index,
  total,
  number,
  createdAt,
  brandName,
  accent,
  printer,
}: {
  annexure: PdfAnnexure;
  index: number;
  total: number;
  number: string;
  createdAt: Date;
  brandName: string;
  accent: string;
  printer: PdfPrinter;
}) {
  const { geometry, settings, slicer, pricing } = annexure;
  return (
    <Page size="A4" style={s.page}>
      <View style={s.headerRow}>
        <Letterhead brandName={brandName} accent={accent} compact />
        <View style={s.metaRight}>
          <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 11, color: INK }}>
            Annexure {index + 1} of {total}
          </Text>
          <Text style={{ fontFamily: "Helvetica-Bold", color: INK }}>{number}</Text>
          <Text>{fmtDate(createdAt)}</Text>
        </View>
      </View>
      <View style={[s.rule, { backgroundColor: accent }]} />

      <Text style={s.annexTitle}>{annexure.fileName}</Text>
      <Text style={{ color: MUTED, marginTop: 2 }}>
        {geometry.format.toUpperCase()} · {formatBytes(geometry.sizeBytes)}
      </Text>

      <View style={s.thumbBox}>
        {annexure.thumbnailPng ? (
          // eslint-disable-next-line jsx-a11y/alt-text -- react-pdf's Image draws into a PDF and has no alt prop
          <Image
            src={{ data: annexure.thumbnailPng, format: "png" }}
            style={{ maxWidth: "100%", maxHeight: 232, objectFit: "contain" }}
          />
        ) : (
          <Text style={{ color: MUTED }}>Preview not available</Text>
        )}
      </View>

      <View style={s.twoCol}>
        <View style={s.col}>
          <Text style={s.sectionLabel}>Model geometry</Text>
          <KV
            label="Dimensions"
            value={formatDimensions({ x: geometry.bboxXMm, y: geometry.bboxYMm, z: geometry.bboxZMm })}
          />
          <KV label="Volume" value={formatVolume(geometry.volumeCm3)} />
          <KV label="Format" value={geometry.format.toUpperCase()} />
          <KV label="File size" value={formatBytes(geometry.sizeBytes)} />

          <Text style={[s.sectionLabel, { marginTop: 14 }]}>Print settings</Text>
          <KV label="Material" value={`${settings.materialName ?? materialName(settings.material)} · ${settings.colourName ?? colourName(settings.colour)}`} />
          <KV label="Layer height" value={LAYER(settings.layerHeightUm)} />
          <KV label="Infill" value={`${settings.infillPct}%`} />
          <KV label="Supports" value={supportsSummary(settings.supports, slicer.supportGrams).detail} />
          <KV label="Quantity" value={String(settings.quantity)} />
        </View>

        <View style={s.col}>
          <Text style={s.sectionLabel}>Slicer output (per unit)</Text>
          <KV label="Filament" value={formatGrams(slicer.filamentGrams)} />
          {slicer.filamentMm > 0 && (
            <KV label="Filament length" value={`${(slicer.filamentMm / 1000).toFixed(1)} m`} />
          )}
          <KV label="Print time" value={formatDuration(slicer.printSeconds)} />
          {slicer.slicerVersion && <KV label="Slicer" value={slicer.slicerVersion} />}

          <Text style={[s.sectionLabel, { marginTop: 14 }]}>
            Price ({settings.quantity} {settings.quantity === 1 ? "print" : "prints"})
          </Text>
          <View style={s.grandRow}>
            <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 10 }}>Line total</Text>
            <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 10, color: accent }}>
              {money(pricing.subtotalPaise)}
            </Text>
          </View>
        </View>
      </View>

      <PdfFooter number={number} brandName={brandName} printer={printer} />
    </Page>
  );
}

function QuotationDocument({ data }: { data: QuotationPdfData }) {
  const printer = data.printer ?? getPrinterSpec();
  const accent = data.accent ?? DEFAULT_ACCENT;
  return (
    <Document title={`Quotation ${data.number}`} author={data.brandName}>
      <Page size="A4" style={s.page}>
        <View style={s.headerRow}>
          <Letterhead brandName={data.brandName} accent={accent} />
          <View style={s.metaRight}>
            <Text style={s.docTitle}>Quotation</Text>
            <Text style={{ fontFamily: "Helvetica-Bold", color: INK }}>{data.number}</Text>
            <Text>{fmtDate(data.createdAt)}</Text>
            {data.tax?.gstin ? <Text>GSTIN {data.tax.gstin}</Text> : null}
          </View>
        </View>
        <View style={[s.rule, { backgroundColor: accent }]} />

        <View style={s.twoCol}>
          <View style={s.col}>
            <Text style={s.sectionLabel}>Prepared for</Text>
            <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 11, marginBottom: 3 }}>
              {data.customer.name}
            </Text>
            <Text style={s.kv}>{data.customer.email}</Text>
            <Text style={s.kv}>{data.customer.phone}</Text>
            <Text style={s.kv}>{data.customer.city}</Text>
          </View>
          <View style={s.col}>
            <Text style={s.sectionLabel}>Order</Text>
            <Text style={s.kv}>Total filament: {formatGrams(data.totalGrams)}</Text>
            <Text style={s.kv}>Total print time: {formatDuration(data.totalPrintSeconds)}</Text>
            {data.completion && <Text style={s.kv}>Estimated ready: {fmtDate(data.completion)}</Text>}
          </View>
        </View>

        <View style={s.tableHead}>
          <Text style={[s.cFile, s.th]}>Model</Text>
          <Text style={[s.cSpec, s.th]}>Spec</Text>
          <Text style={[s.cNum, s.th]}>Qty</Text>
          <Text style={[s.cNum, s.th]}>Weight</Text>
          <Text style={[s.cPrice, s.th]}>Price</Text>
        </View>

        {data.lines.map((l, i) => (
          <View style={s.row} key={i} wrap={false}>
            <View style={s.cFile}>
              <Text style={s.fileName}>{l.fileName}</Text>
              <Text style={{ color: MUTED, marginTop: 1 }}>{formatDuration(l.totalPrintSeconds)}</Text>
            </View>
            <Text style={s.cSpec}>
              {l.materialName ?? materialName(l.material)} · {l.colourName ?? colourName(l.colour)}
              {"\n"}
              {LAYER(l.layerHeightUm)} · {l.infillPct}% · supports {supportsSummary(l.supports, l.supportGrams).label.toLowerCase()}
            </Text>
            <Text style={s.cNum}>{l.quantity}</Text>
            <Text style={s.cNum}>{formatGrams(l.totalGrams)}</Text>
            <Text style={s.cPrice}>{money(l.subtotalPaise)}</Text>
          </View>
        ))}

        <View style={s.totals}>
          <View style={s.totalRow}>
            <Text style={{ color: MUTED }}>Materials subtotal</Text>
            <Text>{money(data.lines.reduce((sum, line) => sum + line.subtotalPaise, 0))}</Text>
          </View>
          <View style={s.totalRow}>
            <Text style={{ color: MUTED }}>Setup fee</Text>
            <Text>{money(data.setupFeePaise)}</Text>
          </View>
          <View style={s.totalRow}>
            <Text style={{ color: MUTED }}>Shipping</Text>
            {data.shippingPaise ? (
              <Text>{money(data.shippingPaise)}</Text>
            ) : (
              <Text style={{ color: MUTED }}>Not included</Text>
            )}
          </View>
          {data.tax && data.tax.paise > 0 ? (
            <View style={s.totalRow}>
              <Text style={{ color: MUTED }}>
                GST @ {formatTaxRate(data.tax.rateBp)}
                {data.tax.hsn ? ` (HSN/SAC ${data.tax.hsn})` : ""}
              </Text>
              <Text>{money(data.tax.paise)}</Text>
            </View>
          ) : null}
          {data.roundOffPaise ? (
            <View style={s.totalRow}>
              <Text style={{ color: MUTED }}>Round off</Text>
              <Text>{roundOffMoney(data.roundOffPaise)}</Text>
            </View>
          ) : null}
          <View style={s.grandRow}>
            <Text style={s.grandLabel}>Total</Text>
            <Text style={[s.grandValue, { color: accent }]}>{totalMoney(data.totalPaise)}</Text>
          </View>
        </View>

        {data.customer.notes ? (
          <View style={{ marginTop: 24 }}>
            <Text style={s.sectionLabel}>Notes</Text>
            <Text style={{ color: MUTED, lineHeight: 1.5 }}>{data.customer.notes}</Text>
          </View>
        ) : null}

        <PdfFooter number={data.number} brandName={data.brandName} printer={printer} />
      </Page>
      {data.annexures.map((annexure, i) => (
        <AnnexurePage
          key={i}
          annexure={annexure}
          index={i}
          total={data.annexures.length}
          number={data.number}
          createdAt={data.createdAt}
          brandName={data.brandName}
          accent={accent}
          printer={printer}
        />
      ))}
    </Document>
  );
}

export function renderQuotationPdf(data: QuotationPdfData): Promise<Buffer> {
  return renderToBuffer(<QuotationDocument data={data} />);
}
