import Link from "next/link";

const footerLinks = [
  { href: "/quote", label: "Get a quote" },
  { href: "/find-models", label: "Find models" },
  { href: "/recent-prints", label: "Recent prints" },
  { href: "/pricing", label: "Pricing" },
  { href: "/materials", label: "Materials" },
  { href: "/faq", label: "FAQ" },
  { href: "/contact", label: "Contact" },
];

// A bare domain in the footer note ("A rish.pw project") becomes a link.
const DOMAIN = /\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})\b/i;

function FooterNote({ note }: { note: string }) {
  const match = DOMAIN.exec(note);
  if (!match) return <>{note}</>;
  const [domain] = match;
  return (
    <>
      {note.slice(0, match.index)}
      <a
        href={`https://${domain}`}
        className="underline decoration-accent underline-offset-4 transition-colors hover:text-accent"
      >
        {domain}
      </a>
      {note.slice(match.index + domain.length)}
    </>
  );
}

export function SiteFooter({ note, city, brandName }: { note: string; city: string; brandName: string }) {
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
          <FooterNote note={note || brandName} />
          {city ? ` · ${city}, India` : " · India"}
        </p>
      </div>
    </footer>
  );
}
