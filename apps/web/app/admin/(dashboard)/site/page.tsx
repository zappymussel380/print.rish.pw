import type { Metadata } from "next";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { FaqEditor } from "@/components/admin/faq-editor";
import { SiteEditor } from "@/components/admin/site-editor";
import { requireAdminPage } from "@/lib/admin-page";
import { getStoredCatalogAvailability } from "@/lib/catalog-availability";
import { getFaqSettings, getGeneratedFaq } from "@/lib/faq";
import { getStoredSiteProfile } from "@/lib/site-profile";

export const metadata: Metadata = { title: "Site · Admin" };

export const dynamic = "force-dynamic";

/** The shop's identity and its public pages' words. */
export default async function SitePage() {
  await requireAdminPage();
  const [profile, stored, generated, settings] = await Promise.all([
    getStoredSiteProfile().catch(() => null),
    getStoredCatalogAvailability(),
    getGeneratedFaq(),
    getFaqSettings(),
  ]);
  return (
    <>
      <AdminPageHeader
        title="Site"
        lede="Shop name, contact details, accent colour and the materials page, and the questions the FAQ answers."
      />
      <SiteEditor profile={profile} materialNames={stored.customMaterials} />
      <FaqEditor generated={generated} settings={settings} />
    </>
  );
}
