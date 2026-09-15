import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AdminNav } from "@/components/admin/admin-nav";
import { requireAdminPage } from "@/lib/admin-page";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** Every admin section: the nav, then the section's page. */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireAdminPage();
  return (
    <div className="mx-auto max-w-6xl px-5 py-10">
      <p className="eyebrow">Admin</p>
      <div className="mt-3">
        <AdminNav />
      </div>
      {children}
    </div>
  );
}
