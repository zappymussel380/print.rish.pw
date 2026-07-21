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
  formatDuration,
  formatGrams,
  formatPaise,
  type MaterialId,
  type SupportMode,
} from "@print/shared";
import { formatBytes, formatDimensions, formatVolume } from "@/lib/format";
import { PrinterMarkPdf } from "./printer-mark-pdf";

/** react-pdf cannot load a variable-weight woff2, so the PDF uses the built-in
 *  Helvetica family (no font registration, no external assets). The on-screen
 *  UI keeps Inter; the PDF stays crisp and dependency-free. */

export interface PdfLine {
  fileName: string;
  material: MaterialId;
  colour: string;
  layerHeightUm: number;
  infillPct: number;
  supports: SupportMode;
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
  };
  pricing: {
    materialPaise: number;
    electricityPaise: number;
    maintenancePaise: number;
    subtotalPaise: number;
  };
}

export interface QuotationPdfData {
  number: string;
  createdAt: Date;
  customer: { name: string; email: string; phone: string; city: string; notes: string };
  lines: PdfLine[];
  setupFeePaise: number;
  shippingPaise?: number;
  totalPaise: number;
  totalGrams: number;
  totalPrintSeconds: number;
  completion: Date | null;
  annexures: PdfAnnexure[];
}

const ACCENT = "#ff5555";
const INK = "#111111";
const MUTED = "#6b6b6b";
const LINE = "#e2e2e2";

const s = StyleSheet.create({
  page: { paddingTop: 44, paddingBottom: 56, paddingHorizontal: 44, fontFamily: "Helvetica", fontSize: 9, color: INK },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  wordmark: { fontFamily: "Helvetica-Bold", fontSize: 15 },
  wordmarkCompact: { fontFamily: "Helvetica-Bold", fontSize: 10 },
  accent: { color: ACCENT },
  docTitle: { fontFamily: "Helvetica-Bold", fontSize: 20, marginBottom: 2 },
  metaRight: { textAlign: "right", color: MUTED, fontSize: 9 },
  rule: { height: 2, backgroundColor: ACCENT, width: 46, marginTop: 14, marginBottom: 20 },
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
  grandValue: { fontFamily: "Helvetica-Bold", fontSize: 12, color: ACCENT },
  footer: { position: "absolute", bottom: 30, left: 44, right: 44, borderTopWidth: 1, borderTopColor: LINE, paddingTop: 10, color: MUTED, fontSize: 7.5, lineHeight: 1.4 },
  annexTitle: { fontFamily: "Helvetica-Bold", fontSize: 14 },
  thumbBox: { borderWidth: 1, borderColor: LINE, height: 250, alignItems: "center", justifyContent: "center", padding: 8, marginTop: 16, marginBottom: 20 },
  kvRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 3 },
});

const fmtDate = (d: Date) =>
  new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(d);

/** Site wordmark, mirroring the web header: printer mark + "print.rish.pw". */
function Letterhead({ compact = false }: { compact?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      <PrinterMarkPdf size={compact ? 15 : 22} />
      <View style={{ marginLeft: 6 }}>
        <Text style={compact ? s.wordmarkCompact : s.wordmark}>
          <Text style={s.accent}>print</Text>.rish.pw
        </Text>
        {!compact && <Text style={{ color: MUTED, marginTop: 2 }}>Instant 3D-printing quotation</Text>}
      </View>
    </View>
  );
}

function PdfFooter({ number }: { number: string }) {
  return (
    <View style={s.footer} fixed>
      <Text>
        This quotation is an estimate generated from real OrcaSlicer slicing on a Bambu Lab A1
        (0.4mm nozzle). Prices are in Indian Rupees and include a one-time setup fee. Filament
        weight and print time come directly from the slicer. This is not a tax invoice.
      </Text>
      <Text style={{ marginTop: 4 }}>
        Final confirmation and payment are arranged over WhatsApp. Quotation {number} ·
        print.rish.pw
      </Text>
    </View>
  );
}

// Built-in Helvetica has no ₹ (U+20B9) glyph, so use an ASCII "Rs" in the PDF.
const money = (paise: number) => formatPaise(paise).replace("₹", "Rs ");

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
}: {
  annexure: PdfAnnexure;
  index: number;
  total: number;
  number: string;
  createdAt: Date;
}) {
  const { geometry, settings, slicer, pricing } = annexure;
  return (
    <Page size="A4" style={s.page}>
      <View style={s.headerRow}>
        <Letterhead compact />
        <View style={s.metaRight}>
          <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 11, color: INK }}>
            Annexure {index + 1} of {total}
          </Text>
          <Text style={{ fontFamily: "Helvetica-Bold", color: INK }}>{number}</Text>
          <Text>{fmtDate(createdAt)}</Text>
        </View>
      </View>
      <View style={s.rule} />

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
          <KV label="Material" value={`${settings.material} · ${settings.colour}`} />
          <KV label="Layer height" value={LAYER(settings.layerHeightUm)} />
          <KV label="Infill" value={`${settings.infillPct}%`} />
          <KV label="Supports" value={settings.supports} />
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
            <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 10, color: ACCENT }}>
              {money(pricing.subtotalPaise)}
            </Text>
          </View>
        </View>
      </View>

      <PdfFooter number={number} />
    </Page>
  );
}

function QuotationDocument({ data }: { data: QuotationPdfData }) {
  return (
    <Document title={`Quotation ${data.number}`} author="print.rish.pw">
      <Page size="A4" style={s.page}>
        <View style={s.headerRow}>
          <Letterhead />
          <View style={s.metaRight}>
            <Text style={s.docTitle}>Quotation</Text>
            <Text style={{ fontFamily: "Helvetica-Bold", color: INK }}>{data.number}</Text>
            <Text>{fmtDate(data.createdAt)}</Text>
          </View>
        </View>
        <View style={s.rule} />

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
              {l.material} · {l.colour}
              {"\n"}
              {LAYER(l.layerHeightUm)} · {l.infillPct}% · supports {l.supports}
            </Text>
            <Text style={s.cNum}>{l.quantity}</Text>
            <Text style={s.cNum}>{formatGrams(l.totalGrams)}</Text>
            <Text style={s.cPrice}>{money(l.subtotalPaise)}</Text>
          </View>
        ))}

        <View style={s.totals}>
          <View style={s.totalRow}>
            <Text style={{ color: MUTED }}>Materials subtotal</Text>
            <Text>{money(data.totalPaise - data.setupFeePaise - (data.shippingPaise ?? 0))}</Text>
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
          <View style={s.grandRow}>
            <Text style={s.grandLabel}>Total</Text>
            <Text style={s.grandValue}>{money(data.totalPaise)}</Text>
          </View>
        </View>

        {data.customer.notes ? (
          <View style={{ marginTop: 24 }}>
            <Text style={s.sectionLabel}>Notes</Text>
            <Text style={{ color: MUTED, lineHeight: 1.5 }}>{data.customer.notes}</Text>
          </View>
        ) : null}

        <PdfFooter number={data.number} />
      </Page>
      {data.annexures.map((annexure, i) => (
        <AnnexurePage
          key={i}
          annexure={annexure}
          index={i}
          total={data.annexures.length}
          number={data.number}
          createdAt={data.createdAt}
        />
      ))}
    </Document>
  );
}

export function renderQuotationPdf(data: QuotationPdfData): Promise<Buffer> {
  return renderToBuffer(<QuotationDocument data={data} />);
}
