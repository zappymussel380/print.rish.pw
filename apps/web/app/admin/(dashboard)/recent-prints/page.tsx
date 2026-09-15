import type { Metadata } from "next";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { ShowcaseEditor } from "@/components/admin/showcase-editor";
import { requireAdminPage } from "@/lib/admin-page";
import { getStoredCatalogAvailability } from "@/lib/catalog-availability";
import { getRecentPrints } from "@/lib/recent-prints";

export const metadata: Metadata = { title: "Recent prints · Admin" };

export const dynamic = "force-dynamic";

/** The public showcase of finished prints. */
export default async function RecentPrintsAdminPage() {
  await requireAdminPage();
  const [prints, stored] = await Promise.all([getRecentPrints(), getStoredCatalogAvailability()]);
  return (
    <>
      <AdminPageHeader title="Recent prints" lede="Photos of finished work for the public Recent prints page." />
      <ShowcaseEditor prints={prints} materialNames={stored.customMaterials} open />
    </>
  );
}
