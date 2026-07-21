"use client";

import { useEffect, useState } from "react";
import { defaultAvailability, toPublicCatalog, type PublicMaterial } from "@print/shared";

export interface PublicCatalog {
  materials: PublicMaterial[];
}

/** Safe default the UI renders with until (or if) the live fetch resolves:
 *  every material on, black/white only — matching the server-side default. */
const FALLBACK: PublicCatalog = toPublicCatalog(defaultAvailability());

// Shared across every model card so the page fetches /api/catalog once.
let cached: PublicCatalog | null = null;
let inflight: Promise<PublicCatalog> | null = null;

async function fetchCatalog(): Promise<PublicCatalog> {
  const res = await fetch("/api/catalog", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`catalog ${res.status}`);
  const data = (await res.json()) as PublicCatalog;
  if (!data || !Array.isArray(data.materials)) throw new Error("bad catalog");
  return data;
}

/** Current material/colour availability for the quote UI. Returns the fallback
 *  immediately, then the live values once loaded; never throws. */
export function useCatalog(): PublicCatalog {
  const [catalog, setCatalog] = useState<PublicCatalog>(cached ?? FALLBACK);

  useEffect(() => {
    if (cached) return;
    let alive = true;
    inflight ??= fetchCatalog();
    inflight
      .then((data) => {
        cached = data;
        if (alive) setCatalog(data);
      })
      .catch(() => {
        inflight = null; // allow a later retry
      });
    return () => {
      alive = false;
    };
  }, []);

  return catalog;
}
