import { redirect } from "next/navigation";
import { isAdmin } from "./session";

/** Admin pages check the session themselves, on top of the proxy's gate: a
 *  layout isn't re-run when moving between its pages, and the PII queries
 *  must stay protected even if proxy matching or framework behaviour changes.
 *  API routes do the same with requireAdminApi. */
export async function requireAdminPage(): Promise<void> {
  if (!(await isAdmin())) redirect("/admin/login");
}
