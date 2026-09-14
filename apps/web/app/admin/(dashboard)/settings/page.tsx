import type { Metadata } from "next";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { ShippingEditor } from "@/components/admin/shipping-editor";
import { TaxEditor } from "@/components/admin/tax-editor";
import { requireAdminPage } from "@/lib/admin-page";
import { getShippingConfig, toAdminView } from "@/lib/shipping-settings";
import { getTax } from "@/lib/tax-settings";

export const metadata: Metadata = { title: "Settings · Admin" };

export const dynamic = "force-dynamic";

/** Services the site connects to, and how it runs. */
export default async function SettingsPage() {
  await requireAdminPage();
  const [shipping, tax] = await Promise.all([getShippingConfig(), getTax()]);
  return (
    <>
      <AdminPageHeader title="Settings" lede="Courier estimates on the quote page, and GST on quotations." />
      <ShippingEditor initial={toAdminView(shipping)} />
      <TaxEditor initial={tax} />
    </>
  );
}
