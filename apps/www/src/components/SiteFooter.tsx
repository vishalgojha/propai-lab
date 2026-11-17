import Link from "next/link";

const FOOTER_LINKS = {
  connect: [
    { label: "Connect WhatsApp", href: "https://app.propai.live/connect" },
    { label: "How it works", href: "/about#how-it-works" },
    { label: "Blog", href: "/blog" },
  ],
  support: [
    { label: "Why no photos", href: "/about#no-photos" },
    { label: "Privacy", href: "/privacy-policy" },
    { label: "Terms", href: "/terms-of-service" },
  ],
  company: [
    { label: "About PropAI", href: "/about" },
    { label: "Contact", href: "/contact" },
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
          <nav aria-label="Connect">
            <h4>Connect</h4>
            <ul>
              {FOOTER_LINKS.connect.map((link) => (
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
          <p>Ask in chat, get the listing and the broker's number.</p>
        </div>
      </div>
    </footer>
  );
}
