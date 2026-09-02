import Link from "next/link";

const FOOTER_LINKS = {
  browse: [
    { label: "Search listings", href: "/search" },
    { label: "Property map", href: "/map" },
    { label: "All localities", href: "/localities" },
  ],
  support: [
    { label: "How it works", href: "/about#how-it-works" },
    { label: "Why no photos", href: "/about#no-photos" },
    { label: "Search tips", href: "/search" },
  ],
  company: [
    { label: "About PropAI", href: "/about" },
    { label: "Contact", href: "/contact" },
    { label: "Localities", href: "/localities" },
  ],
};

export default function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-grid">
          <div className="site-footer-brand">
            <Link href="/" className="site-footer-wordmark" aria-label="PropAI home">
              <img src="/propai-logo.svg?v=3" alt="" aria-hidden="true" />
              <span>Prop<span>AI</span></span>
            </Link>
            <p>
              PropAI reads WhatsApp broker groups so you get real, fresh
              live listings — and a direct line to the broker.
            </p>
          </div>
          <nav aria-label="Browse">
            <h4>Browse</h4>
            <ul>
              {FOOTER_LINKS.browse.map((link) => (
                <li key={link.href}>
                  <Link href={link.href}>
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <nav aria-label="Support">
            <h4>Support</h4>
            <ul>
              {FOOTER_LINKS.support.map((link) => (
                <li key={link.href}>
                  <Link href={link.href}>
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <nav aria-label="Company">
            <h4>Company</h4>
            <ul>
              {FOOTER_LINKS.company.map((link) => (
                <li key={link.href}>
                  <Link href={link.href}>
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        <div className="site-footer-bottom">
          <p>© {new Date().getFullYear()} PropAI. Listings sourced from active broker WhatsApp networks.</p>
          <p>Fresh property inventory, directly from brokers.</p>
        </div>
      </div>
    </footer>
  );
}
