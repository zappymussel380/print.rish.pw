import type { Metadata } from "next";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { MailEditor } from "@/components/admin/mail-editor";
import { RetentionEditor } from "@/components/admin/retention-editor";
import { ShippingEditor } from "@/components/admin/shipping-editor";
import { requireAdminPage } from "@/lib/admin-page";
import { getMailConfig, toMailAdminView } from "@/lib/mail-settings";
import { getRetention } from "@/lib/retention-settings";
import { getShippingConfig, toAdminView } from "@/lib/shipping-settings";

export const metadata: Metadata = { title: "Settings · Admin" };

export const dynamic = "force-dynamic";

/** Services the site connects to, and how it runs. */
export default async function SettingsPage() {
  await requireAdminPage();
  const [shipping, mail, retention] = await Promise.all([getShippingConfig(), getMailConfig(), getRetention()]);
  return (
    <>
      <AdminPageHeader
        title="Settings"
        lede="Courier estimates on the quote page, where contact-form messages go, and how long uploads and old quotations are kept."
      />
      <ShippingEditor initial={toAdminView(shipping)} />
      <MailEditor initial={toMailAdminView(mail)} />
      <RetentionEditor initial={retention.settings} saved={retention.saved} />
    </>
  );
}
