import Link from "next/link";

const footerLinks = [
  { href: "/quote", label: "Get a quote" },
  { href: "/find-models", label: "Find models" },
  { href: "/pricing", label: "Pricing" },
  { href: "/materials", label: "Materials" },
  { href: "/faq", label: "FAQ" },
  { href: "/contact", label: "Contact" },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto max-w-6xl px-5 py-8 text-sm text-muted">
        <nav aria-label="Footer" className="mb-6 flex flex-wrap gap-x-6 gap-y-2">
          {footerLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="transition-colors hover:text-accent"
            >
              {link.label}
            </Link>
          ))}
        </nav>
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
      </div>
    </footer>
  );
}
