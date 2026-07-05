#!/usr/bin/env node
// Generate a bcrypt hash for ADMIN_PASSWORD_HASH.
//   pnpm --filter @print/web hash-password 'your-password-here'
import bcrypt from "bcryptjs";

const password = process.argv[2];
if (!password) {
  console.error("Usage: pnpm --filter @print/web hash-password '<password>'");
  process.exit(1);
}
if (password.length < 8) {
  console.error("Refusing to hash a password shorter than 8 characters.");
  process.exit(1);
}

const hash = await bcrypt.hash(password, 12);
console.log(hash);
