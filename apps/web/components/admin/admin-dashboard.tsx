"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Download,
  ExternalLink,
  FolderArchive,
  LogOut,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { formatPaise } from "@print/shared";

export interface QuotationRow {
  id: string;
  number: string;
  createdAt: string;
  status: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  customerCity: string;
  notes: string;
  models: number;
  grams: number;
  printSeconds: number;
  totalPaise: number;
}

export interface AdminStats {
  total: number;
  revenuePaise: number;
  aovPaise: number;
  printHours: number;
  filamentKg: number;
  plaGrams: number;
  petgGrams: number;
  statusCounts: Record<string, number>;
}

const STATUSES = [
  "PENDING",
  "QUOTED",
  "APPROVED",
  "PRINTING",
  "COMPLETED",
  "DELIVERED",
  "CANCELLED",
] as const;
const TERMINAL_STATUSES = new Set(["COMPLETED", "DELIVERED", "CANCELLED"]);

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "2-digit" });

export function AdminDashboard({
  quotations,
  stats,
}: {
  quotations: QuotationRow[];
  stats: AdminStats;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<string>("ALL");
  const [busyId, setBusyId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return quotations.filter((row) => {
      if (filter !== "ALL" && row.status !== filter) return false;
      if (!q) return true;
      return (
        row.number.toLowerCase().includes(q) ||
        row.customerName.toLowerCase().includes(q) ||
        row.customerEmail.toLowerCase().includes(q) ||
        row.customerCity.toLowerCase().includes(q)
      );
    });
  }, [quotations, query, filter]);

  const changeStatus = async (id: string, status: string) => {
    setBusyId(id);
    try {
      await fetch(`/api/admin/quotations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify({ status }),
      });
      router.refresh();
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (row: QuotationRow) => {
    if (!confirm(`Delete quotation ${row.number}? This removes its files and cannot be undone.`)) return;
    setBusyId(row.id);
    try {
      await fetch(`/api/admin/quotations/${row.id}`, {
        method: "DELETE",
        headers: { "X-Requested-With": "XMLHttpRequest" },
      });
      router.refresh();
    } finally {
      setBusyId(null);
    }
  };

  const regeneratePdf = async (row: QuotationRow) => {
    setBusyId(row.id);
    try {
      const response = await fetch(`/api/admin/quotations/${row.id}/regenerate-pdf`, {
        method: "POST",
        headers: { "X-Requested-With": "XMLHttpRequest" },
      });
      if (!response.ok) alert(`Regenerating the PDF for ${row.number} failed.`);
      router.refresh();
    } finally {
      setBusyId(null);
    }
  };

  const logout = async () => {
    await fetch("/api/admin/logout", {
      method: "POST",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });
    router.push("/admin/login");
    router.refresh();
  };

  return (
    <div className="mx-auto max-w-6xl px-5 py-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Admin</p>
          <h1 className="section-title mt-2">Quotations</h1>
        </div>
        <div className="flex items-center gap-2">
          <a href="/api/admin/quotations/export" download className="btn-ghost text-sm">
            <Download strokeWidth={1.8} className="h-4 w-4" /> Export CSV
          </a>
          <button type="button" onClick={logout} className="btn-ghost text-sm">
            <LogOut strokeWidth={1.8} className="h-4 w-4" /> Sign out
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label="Quotations" value={String(stats.total)} />
        <StatCard label="Revenue" value={formatPaise(stats.revenuePaise)} />
        <StatCard label="Avg. order" value={formatPaise(stats.aovPaise)} />
        <StatCard label="Print hours" value={`${stats.printHours.toFixed(1)}h`} />
        <StatCard label="Filament" value={`${stats.filamentKg.toFixed(2)} kg`} />
      </div>
      <div className="mt-3">
        <MaterialSplit pla={stats.plaGrams} petg={stats.petgGrams} />
      </div>

      {/* Controls */}
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search strokeWidth={1.65} className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search number, name, email, city…"
            className="input-base pl-9"
            aria-label="Search quotations"
          />
        </div>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="input-base w-auto"
          aria-label="Filter by status"
        >
          <option value="ALL">All statuses ({stats.total})</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {label(s)} ({stats.statusCounts[s] ?? 0})
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[820px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[0.68rem] uppercase tracking-[0.1em] text-faint">
              <Th>Number</Th>
              <Th>Date</Th>
              <Th>Customer</Th>
              <Th className="text-right">Models</Th>
              <Th className="text-right">Total</Th>
              <Th>Status</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr key={row.id} className="border-b border-line align-middle">
                <td className="py-3 pr-3 font-[600]">{row.number}</td>
                <td className="py-3 pr-3 text-muted">{dateFmt.format(new Date(row.createdAt))}</td>
                <td className="py-3 pr-3">
                  <div className="font-[550]">{row.customerName}</div>
                  <div className="text-xs text-faint">
                    {row.customerCity} · {row.customerEmail}
                  </div>
                </td>
                <td className="py-3 pr-3 text-right text-muted">{row.models}</td>
                <td className="py-3 pr-3 text-right font-[600]">{formatPaise(row.totalPaise)}</td>
                <td className="py-3 pr-3">
                  <select
                    value={row.status}
                    disabled={busyId === row.id || TERMINAL_STATUSES.has(row.status)}
                    onChange={(e) => changeStatus(row.id, e.target.value)}
                    className="input-base w-auto px-2 py-1.5 text-xs"
                    aria-label={`Status of ${row.number}`}
                  >
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {label(s)}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-3">
                  <div className="flex items-center justify-end gap-1">
                    <a
                      href={`/api/quotations/${row.number}/pdf`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-md p-2 text-faint transition-colors hover:text-accent"
                      aria-label={`Open PDF for ${row.number}`}
                    >
                      <ExternalLink strokeWidth={1.65} className="h-4 w-4" />
                    </a>
                    <a
                      href={`/api/admin/quotations/${row.id}/zip`}
                      download
                      className="rounded-md p-2 text-faint transition-colors hover:text-accent"
                      aria-label={`Download ZIP for ${row.number}`}
                    >
                      <FolderArchive strokeWidth={1.65} className="h-4 w-4" />
                    </a>
                    <button
                      type="button"
                      onClick={() => regeneratePdf(row)}
                      disabled={busyId === row.id}
                      className="rounded-md p-2 text-faint transition-colors hover:text-accent disabled:opacity-40"
                      aria-label={`Regenerate PDF for ${row.number}`}
                    >
                      <RefreshCw strokeWidth={1.65} className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(row)}
                      disabled={busyId === row.id}
                      className="rounded-md p-2 text-faint transition-colors hover:text-accent disabled:opacity-40"
                      aria-label={`Delete ${row.number}`}
                    >
                      <Trash2 strokeWidth={1.65} className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <p className="py-12 text-center text-sm text-muted">No quotations match your filters.</p>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="tile p-4">
      <p className="text-[0.62rem] font-[650] uppercase tracking-[0.14em] text-faint">{label}</p>
      <p className="mt-1.5 text-lg font-[700]">{value}</p>
    </div>
  );
}

function MaterialSplit({ pla, petg }: { pla: number; petg: number }) {
  const total = pla + petg;
  const plaPct = total > 0 ? (pla / total) * 100 : 0;
  return (
    <div className="tile p-4">
      <div className="flex items-center justify-between text-[0.62rem] font-[650] uppercase tracking-[0.14em] text-faint">
        <span>Material split</span>
        <span>
          PLA {(pla / 1000).toFixed(2)}kg · PETG {(petg / 1000).toFixed(2)}kg
        </span>
      </div>
      <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--line)_60%,transparent)]">
        <div className="h-full bg-accent" style={{ width: `${plaPct}%` }} />
        <div className="h-full bg-[color-mix(in_srgb,var(--accent)_45%,transparent)]" style={{ width: `${100 - plaPct}%` }} />
      </div>
    </div>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <th className={`py-2 pr-3 font-[650] ${className}`}>{children}</th>;
}

function label(status: string): string {
  return status.charAt(0) + status.slice(1).toLowerCase();
}
