import type { Metadata } from "next";
import { toPricingInput, toPublicCatalog } from "@print/shared";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { CatalogEditor } from "@/components/admin/catalog-editor";
import { CustomMaterialsEditor } from "@/components/admin/custom-materials-editor";
import { MaterialHelperEditor } from "@/components/admin/material-helper-editor";
import { RatesEditor } from "@/components/admin/rates-editor";
import { SlicerProfilesEditor } from "@/components/admin/slicer-profiles-editor";
import { requireAdminPage } from "@/lib/admin-page";
import { getReadyCustomMaterials, getStoredCatalogAvailability } from "@/lib/catalog-availability";
import { getMaterialHelper } from "@/lib/material-helper";
import { getPricing } from "@/lib/pricing-settings";
import { advancedProfilesEnabled } from "@/lib/printer";
import { getSlicerProfilesState } from "@/lib/slicer-profiles";

export const metadata: Metadata = { title: "Filament · Admin" };

export const dynamic = "force-dynamic";

/** What the shop sells and what it costs. */
export default async function FilamentPage() {
  await requireAdminPage();
  const [pricing, stored, ready, slicerProfiles, helper] = await Promise.all([
    getPricing(),
    getStoredCatalogAvailability(),
    getReadyCustomMaterials(),
    getSlicerProfilesState(),
    getMaterialHelper(),
  ]);
  // As saved, with what each of the shop's own materials still needs.
  const catalog = toPublicCatalog(stored, ready);
  return (
    <>
      <AdminPageHeader
        title="Filament"
        lede="Materials and colours on sale, layer heights, the material helper, your own materials and their OrcaSlicer profiles, and the rates quotes are built from."
      />
      <CatalogEditor catalog={catalog} rates={pricing.catalog} />
      <MaterialHelperEditor initial={helper} catalog={catalog} />
      <CustomMaterialsEditor catalog={catalog} initial={slicerProfiles} materialNames={stored.customMaterials} />
      <RatesEditor pricing={toPricingInput(pricing)} materialNames={stored.customMaterials} />
      {/* Advanced mode: the owner's own printer and presets */}
      {advancedProfilesEnabled() ? <SlicerProfilesEditor initial={slicerProfiles} /> : null}
    </>
  );
}
