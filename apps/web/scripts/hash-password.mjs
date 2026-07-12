#!/usr/bin/env node
// Generate a bcrypt hash for ADMIN_PASSWORD_HASH.
//   pnpm --filter @print/web hash-password
import bcrypt from "bcryptjs";

if (process.argv.length > 2) {
  console.error("Refusing a password in argv (it would leak through shell history/process listings).");
  process.exit(1);
}

async function readPassword() {
  if (!process.stdin.isTTY) {
    let value = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      value += chunk;
      if (value.length > 1024) throw new Error("Password input is too long");
    }
    return value.replace(/\r?\n$/, "");
  }

  return new Promise((resolve, reject) => {
    let value = "";
    process.stderr.write("Admin password: ");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const finish = (err) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stderr.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\u0003") return finish(new Error("Cancelled"));
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (value.length < 1024) value += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

const password = await readPassword().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
const bytes = Buffer.byteLength(password, "utf8");
if (password.length < 12) {
  console.error("Refusing to hash a password shorter than 12 characters.");
  process.exit(1);
}
if (bytes > 72) {
  console.error("Refusing a password over bcrypt's 72-byte input limit.");
  process.exit(1);
}

const hash = await bcrypt.hash(password, 12);
console.log(hash);
