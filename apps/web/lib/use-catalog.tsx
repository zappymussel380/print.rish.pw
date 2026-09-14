"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  CATALOG,
  colourName,
  defaultAvailability,
  materialName,
  toPublicCatalog,
  type Catalog,
  type LayerHeightUm,
  type PublicMaterial,
} from "@print/shared";

export interface PublicCatalog {
  materials: PublicMaterial[];
  /** Layer heights the shop offers (µm), never empty. */
  layerHeights: LayerHeightUm[];
  /** The live customer-facing rates (admin-editable) the quote is priced with. */
  pricing: Catalog;
}

/** Safe default the UI renders with until (or if) the live fetch resolves:
 *  every material on, black/white only, code-default rates — matching the
 *  server-side defaults. */
const FALLBACK: PublicCatalog = { ...toPublicCatalog(defaultAvailability()), pricing: CATALOG };

// Shared across every model card so the page fetches /api/catalog once.
let cached: PublicCatalog | null = null;
let inflight: Promise<PublicCatalog> | null = null;

async function fetchCatalog(): Promise<PublicCatalog> {
  const res = await fetch("/api/catalog", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`catalog ${res.status}`);
  const data = (await res.json()) as PublicCatalog;
  if (!data || !Array.isArray(data.materials) || !Array.isArray(data.layerHeights) || !data.pricing) throw new Error("bad catalog");
  return data;
}

const SeedContext = createContext<PublicCatalog | null>(null);

/** Hands the catalog the server rendered this page with to every `useCatalog`
 *  below it, so the first paint already shows live rates and colours — a shop
 *  whose rates differ from the code defaults never flashes the wrong price. */
export function CatalogProvider({ value, children }: { value: PublicCatalog; children: ReactNode }) {
  return <SeedContext.Provider value={value}>{children}</SeedContext.Provider>;
}

/** Current material/colour availability and rates for the quote UI. Uses the
 *  server-rendered catalog when a `CatalogProvider` supplies one; otherwise
 *  returns the fallback immediately, then the live values once loaded. Never
 *  throws. */
export function useCatalog(): PublicCatalog {
  const seed = useContext(SeedContext);
  const [fetched, setFetched] = useState<PublicCatalog | null>(cached);

  useEffect(() => {
    // A server-rendered seed is authoritative (and refreshed by the server on
    // router.refresh/navigation); only pages without one fetch.
    if (seed || cached) return;
    let alive = true;
    inflight ??= fetchCatalog();
    inflight
      .then((data) => {
        cached = data;
        if (alive) setFetched(data);
      })
      .catch(() => {
        inflight = null; // allow a later retry
      });
    return () => {
      alive = false;
    };
  }, [seed]);

  return seed ?? fetched ?? FALLBACK;
}

/** Display name for a colour as the live catalog knows it — custom colours
 *  included — falling back to the palette lookup. */
/** A material's name as the shop shows it (its own materials by the name it
 *  gave them). */
export function catalogMaterialName(catalog: PublicCatalog, material: string): string {
  return catalog.materials.find((m) => m.id === material)?.name ?? materialName(material);
}

export function catalogColourName(catalog: PublicCatalog, material: string, colour: string): string {
  return (
    catalog.materials.find((m) => m.id === material)?.colours.find((c) => c.id === colour)?.name ??
    colourName(colour)
  );
}
