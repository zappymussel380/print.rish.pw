"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, Lock } from "lucide-react";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message: string } } | null;
        throw new Error(body?.error?.message ?? "Login failed");
      }
      const next = params.get("next");
      router.push(next && next.startsWith("/admin") ? next : "/admin");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-sm flex-col justify-center px-5 py-16">
      <div className="mb-6 flex items-center gap-2 text-accent">
        <Lock strokeWidth={1.8} className="h-5 w-5" />
        <span className="eyebrow">Admin</span>
      </div>
      <h1 className="section-title">Sign in</h1>
      <p className="mt-2 text-sm text-muted">Enter the admin password to manage quotations.</p>

      <form onSubmit={onSubmit} className="mt-8">
        <label className="block">
          <span className="mb-2 block text-[0.7rem] font-[650] uppercase tracking-[0.14em] text-muted">
            Password
          </span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            autoComplete="current-password"
            className="input-base"
            aria-invalid={!!error}
          />
        </label>
        {error && (
          <p className="mt-3 text-sm text-accent" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy || !password} className="btn-pill mt-6 w-full">
          {busy ? <Loader2 strokeWidth={2} className="h-4 w-4 animate-spin" /> : "Sign in"}
        </button>
      </form>
    </div>
  );
}

export default function AdminLoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
