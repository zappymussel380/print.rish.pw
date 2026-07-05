import * as React from "react";
import {
  Document,
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

export interface QuotationPdfData {
  number: string;
  createdAt: Date;
  customer: { name: string; email: string; phone: string; city: string; notes: string };
  lines: PdfLine[];
  setupFeePaise: number;
  totalPaise: number;
  totalGrams: number;
  totalPrintSeconds: number;
  completion: Date | null;
}

const ACCENT = "#ff5555";
const INK = "#111111";
const MUTED = "#6b6b6b";
const LINE = "#e2e2e2";

const s = StyleSheet.create({
  page: { paddingTop: 44, paddingBottom: 56, paddingHorizontal: 44, fontFamily: "Helvetica", fontSize: 9, color: INK },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  wordmark: { fontFamily: "Helvetica-Bold", fontSize: 15 },
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
});

const fmtDate = (d: Date) =>
  new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(d);

// Built-in Helvetica has no ₹ (U+20B9) glyph, so use an ASCII "Rs" in the PDF.
const money = (paise: number) => formatPaise(paise).replace("₹", "Rs ");

const LAYER = (um: number) => `${(um / 1000).toFixed(2)}mm`;

function QuotationDocument({ data }: { data: QuotationPdfData }) {
  return (
    <Document title={`Quotation ${data.number}`} author="print.rish.pw">
      <Page size="A4" style={s.page}>
        <View style={s.headerRow}>
          <View>
            <Text style={s.wordmark}>
              rish.pw <Text style={s.accent}>/ print</Text>
            </Text>
            <Text style={{ color: MUTED, marginTop: 2 }}>Instant 3D-printing quotation</Text>
          </View>
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
            <Text>{money(data.totalPaise - data.setupFeePaise)}</Text>
          </View>
          <View style={s.totalRow}>
            <Text style={{ color: MUTED }}>Setup fee</Text>
            <Text>{money(data.setupFeePaise)}</Text>
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

        <View style={s.footer}>
          <Text>
            This quotation is an estimate generated from real OrcaSlicer slicing on a Bambu Lab A1
            (0.4mm nozzle). Prices are in Indian Rupees and include a one-time setup fee. Filament
            weight and print time come directly from the slicer. This is not a tax invoice.
          </Text>
          <Text style={{ marginTop: 4 }}>
            Final confirmation and payment are arranged over WhatsApp. Quotation {data.number} ·
            print.rish.pw
          </Text>
        </View>
      </Page>
    </Document>
  );
}

export function renderQuotationPdf(data: QuotationPdfData): Promise<Buffer> {
  return renderToBuffer(<QuotationDocument data={data} />);
}
