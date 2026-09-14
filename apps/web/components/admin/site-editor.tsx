"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ACCENTS,
  ACCENT_IDS,
  DEFAULT_SITE_PROFILE,
  accentCss,
  MATERIAL_IDS,
  SITE_PROFILE_LIMITS,
  materialName,
  siteProfileFieldSchemas,
  type AccentId,
  type MaterialId,
  type SiteProfile,
} from "@print/shared";

type TextKey =
  | "brandName"
  | "tagline"
  | "city"
  | "quotationPrefix"
  | "whatsappNumber"
  | "email"
  | "phone"
  | "address"
  | "footerNote";

const FIELDS: { key: TextKey; label: string; hint?: string; max: number; multiline?: boolean }[] = [
  { key: "brandName", label: "Shop name", hint: "Header, page titles, PDFs and messages.", max: SITE_PROFILE_LIMITS.brandName },
  { key: "tagline", label: "Tagline", hint: "Shown after the name in browser tabs.", max: SITE_PROFILE_LIMITS.tagline },
  { key: "city", label: "City", hint: "“3D printing · City”, pickup and shipping copy.", max: SITE_PROFILE_LIMITS.city },
  {
    key: "quotationPrefix",
    label: "Quotation initials",
    hint: "2–5 capital letters: AP-2026-0001. Earlier numbers keep working.",
    max: 5,
  },
  { key: "whatsappNumber", label: "WhatsApp number", hint: "With country code, e.g. 919876543210. Quotes hand off here.", max: 20 },
  { key: "email", label: "Contact email", max: SITE_PROFILE_LIMITS.email },
  { key: "phone", label: "Phone", max: SITE_PROFILE_LIMITS.phone },
  { key: "address", label: "Address", hint: "Shown on the contact page.", max: SITE_PROFILE_LIMITS.address, multiline: true },
  { key: "footerNote", label: "Footer note", hint: "A bare domain in it becomes a link.", max: SITE_PROFILE_LIMITS.footerNote },
];

function toForm(p: SiteProfile): Record<TextKey, string> {
  return {
    brandName: p.brandName,
    tagline: p.tagline,
    city: p.city,
    quotationPrefix: p.quotationPrefix,
    whatsappNumber: p.contact.whatsappNumber,
    email: p.contact.email,
    phone: p.contact.phone,
    address: p.contact.address,
    footerNote: p.footerNote,
  };
}

/** The shop's identity: name, contact details, and which materials the public
 *  /materials page explains. Empty WhatsApp/email fall back to the server's
 *  environment settings. */
export function SiteEditor({ profile }: { profile: SiteProfile | null }) {
  const router = useRouter();
  const start = profile ?? DEFAULT_SITE_PROFILE;
  const [form, setForm] = useState(() => toForm(start));
  const [materials, setMaterials] = useState<MaterialId[]>(start.materialsPage);
  const [accent, setAccent] = useState<AccentId>(start.accent);

  // Preview the accent on this page as it's picked. Appended after the layout's
  // own accent style, which it then outranks; gone again when the editor is.
  useEffect(() => {
    const preview = document.createElement("style");
    preview.id = "site-accent-preview";
    preview.textContent = accent === start.accent ? "" : accentCss(accent, true);
    document.body.append(preview);
    return () => preview.remove();
  }, [accent, start.accent]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalid = new Set<string>(
    FIELDS.filter((f) => !siteProfileFieldSchemas[f.key].safeParse(form[f.key]).success).map((f) => f.key),
  );
  if (materials.length === 0) invalid.add("materialsPage");

  const set = (key: TextKey, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
  };

  const toggleMaterial = (m: MaterialId, on: boolean) => {
    // Keep catalog order so the comparison reads the same way everywhere.
    setMaterials((list) => MATERIAL_IDS.filter((id) => (id === m ? on : list.includes(id))));
    setDirty(true);
  };

  const save = async () => {
    if (invalid.size > 0) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/site", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify({
          brandName: form.brandName,
          tagline: form.tagline,
          city: form.city,
          contact: {
            whatsappNumber: form.whatsappNumber,
            email: form.email,
            phone: form.phone,
            address: form.address,
          },
          footerNote: form.footerNote,
          quotationPrefix: form.quotationPrefix.trim().toUpperCase(),
          materialsPage: materials,
          accent,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(data?.error?.message ?? "Saving the site profile failed.");
        return;
      }
      setDirty(false);
      router.refresh();
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className="tile mt-4 p-0 [&_summary]:list-none">
      <summary className="flex cursor-pointer items-center justify-between p-4 text-[0.62rem] font-[650] uppercase tracking-[0.14em] text-faint">
        <span>Site · name, contact, accent colour &amp; materials page</span>
        <span className="text-faint">edit</span>
      </summary>
      <div className="space-y-6 border-t border-line p-4">
        {profile === null ? (
          <p className="text-xs text-danger">Could not load the saved profile; showing defaults.</p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          {FIELDS.map((f) => {
            const bad = invalid.has(f.key);
            const common = {
              value: form[f.key],
              maxLength: f.max,
              "aria-invalid": bad,
              className: `input-base py-2 text-sm ${bad ? "border-[var(--danger)]" : ""}`,
            };
            return (
              <label key={f.key} className={`block text-sm ${f.multiline ? "sm:col-span-2" : ""}`}>
                <span className="font-[600]">{f.label}</span>
                {f.hint ? <span className="ml-2 text-xs text-faint">{f.hint}</span> : null}
                <span className="mt-1.5 block">
                  {f.multiline ? (
                    <textarea rows={2} {...common} onChange={(e) => set(f.key, e.target.value)} />
                  ) : (
                    <input type="text" {...common} onChange={(e) => set(f.key, e.target.value)} />
                  )}
                </span>
              </label>
            );
          })}
        </div>
        <fieldset>
          <legend className="text-sm font-[600]">Accent colour</legend>
          <p className="mt-0.5 text-xs text-faint">
            Buttons, links, prices and the name in the header, across the whole site and the quotation PDF. Each has a
            light- and a dark-theme shade; errors stay red.
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {ACCENT_IDS.map((id) => {
              const { label, light, dark } = ACCENTS[id];
              const on = accent === id;
              return (
                <label
                  key={id}
                  className={`flex cursor-pointer items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-sm transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--accent)] ${
                    on ? "border-[var(--accent)] text-text" : "border-line text-muted hover:text-text"
                  }`}
                >
                  <input
                    type="radio"
                    name="accent"
                    value={id}
                    checked={on}
                    onChange={() => {
                      setAccent(id);
                      setDirty(true);
                    }}
                    className="sr-only"
                  />
                  <span
                    aria-hidden="true"
                    className="size-6 rounded-full border border-line"
                    style={{ background: `linear-gradient(135deg, ${light} 50%, ${dark} 50%)` }}
                  />
                  {label}
                </label>
              );
            })}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-sm font-[600]">Materials page</legend>
          <p className="mt-0.5 text-xs text-faint">
            Which materials /materials compares, side by side. Independent of what is on sale.
          </p>
          <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-2">
            {MATERIAL_IDS.map((m) => (
              <label key={m} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={materials.includes(m)}
                  onChange={(e) => toggleMaterial(m, e.target.checked)}
                  className="size-4 accent-[var(--accent)]"
                />
                {materialName(m)}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving || invalid.size > 0}
            className="btn-pill text-sm disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save site profile"}
          </button>
          {invalid.has("materialsPage") ? (
            <span className="text-xs text-danger">Pick at least one material for the materials page.</span>
          ) : invalid.size > 0 ? (
            <span className="text-xs text-danger">Check the highlighted fields.</span>
          ) : dirty && !saving ? (
            <span className="text-xs text-faint">Unsaved changes</span>
          ) : null}
          {error ? <span className="text-xs text-danger">{error}</span> : null}
        </div>
      </div>
    </details>
  );
}
