import { NextResponse, type NextRequest } from "next/server";
import { PICKUP_PINCODE_RE, isShippingEmail, shippingSettingsInputSchema, type ShippingSettings } from "@print/shared";
import { jsonError, readJsonBody, requireAdminApi } from "@/lib/api-util";
import { assertSameOrigin } from "@/lib/security";
import { sealSecret } from "@/lib/secret-box";
import { checkShiprocketLogin } from "@/lib/shipping";
import {
  SHIPROCKET_PASSWORD_PURPOSE,
  getShippingConfig,
  getStoredShipping,
  resolveShippingConfig,
  saveShipping,
  toAdminView,
} from "@/lib/shipping-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4 * 1024;

/** Admin: the courier-estimate settings in use, without the password. */
export async function GET() {
  const auth = await requireAdminApi();
  if (auth) return auth;
  return NextResponse.json(toAdminView(await getShippingConfig()));
}

/** Admin: save the courier-estimate settings. Switching the estimator on needs
 *  an email, a password (typed now, or the one already in use — a first save
 *  keeps the server environment's) and a pickup pincode, and a new email or
 *  password is checked with Shiprocket before it's stored. */
export async function PUT(request: NextRequest) {
  const auth = await requireAdminApi();
  if (auth) return auth;
  if (!assertSameOrigin(request)) return jsonError(403, "CSRF", "Cross-origin request rejected");

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const parsed = shippingSettingsInputSchema.safeParse(body.value);
  if (!parsed.success) return jsonError(422, "BAD_REQUEST", "Invalid shipping settings payload");
  const input = parsed.data;

  const current = resolveShippingConfig(await getStoredShipping());
  const typed = input.password ?? "";
  const password = typed !== "" ? typed : current.password;

  const issues: string[] = [];
  if (input.email !== "" && !isShippingEmail(input.email)) issues.push("the email");
  if (input.pickupPincode !== "" && !PICKUP_PINCODE_RE.test(input.pickupPincode)) issues.push("the pickup pincode (6 digits)");
  if (input.enabled) {
    if (input.email === "") issues.push("an email");
    if (password === "") issues.push("a password");
    if (input.pickupPincode === "") issues.push("a pickup pincode");
  }
  if (issues.length > 0) {
    return jsonError(422, "INVALID_FIELDS", `${input.enabled ? "To show estimates, check" : "Check"} ${issues.join(", ")}.`);
  }

  // A new API user (or password) is tried once before customers depend on it.
  const newLogin = input.email !== current.email || typed !== "";
  if (input.enabled && newLogin) {
    const login = await checkShiprocketLogin(input.email, password);
    if (login === "rejected") {
      return jsonError(422, "LOGIN_REJECTED", "Shiprocket rejected this email and password. Use the API user's (Settings → API), not your login.");
    }
    if (login === "unreachable") {
      return jsonError(502, "LOGIN_UNCHECKED", "Couldn't reach Shiprocket to check the login. Nothing was saved; try again in a minute.");
    }
  }

  const next: ShippingSettings = {
    enabled: input.enabled,
    email: input.email,
    passwordSealed: password === "" ? "" : sealSecret(password, SHIPROCKET_PASSWORD_PURPOSE),
    pickupPincode: input.pickupPincode,
  };
  await saveShipping(next);
  return NextResponse.json(toAdminView(resolveShippingConfig(next)));
}
