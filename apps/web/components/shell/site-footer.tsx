import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-5 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
        <p>
          A{" "}
          <a
            href="https://rish.pw"
            className="underline decoration-accent underline-offset-4 transition-colors hover:text-accent"
          >
            rish.pw
          </a>{" "}
          project · Guwahati, India
        </p>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2">
          <Link href="/pricing" className="transition-colors hover:text-text">
            Pricing
          </Link>
          <Link href="/materials" className="transition-colors hover:text-text">
            Materials
          </Link>
          <Link href="/faq" className="transition-colors hover:text-text">
            FAQ
          </Link>
          <Link href="/contact" className="transition-colors hover:text-text">
            Contact
          </Link>
        </nav>
      </div>
    </footer>
  );
}
