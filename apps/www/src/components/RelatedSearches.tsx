import Link from "next/link";
import { Compass } from "lucide-react";
import type { RelatedSection } from "@/lib/related-searches";

export default function RelatedSearches({
  sections,
}: {
  sections: RelatedSection[];
}) {
  if (sections.length === 0) return null;

  return (
    <section className="mt-10" aria-label="Related to your search">
      <div className="mb-5 flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent-soft)]">
          <Compass className="h-4 w-4 text-[var(--accent-forest)]" aria-hidden="true" />
        </div>
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Related to your search</h2>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {sections.map((section) => (
          <div
            key={section.heading}
            className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 sm:p-5"
          >
            <h3 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">
              {section.heading}
            </h3>
            <ul className="space-y-1.5">
              {section.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="group flex items-center gap-2 text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--accent-forest)]"
                  >
                    <span className="h-1 w-1 shrink-0 rounded-full bg-[var(--border-subtle)] group-hover:bg-[var(--accent-primary)]" />
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
            {section.viewMoreHref && (
              <Link
                href={section.viewMoreHref}
                className="mt-3 inline-block text-xs font-medium text-[var(--accent-forest)] transition-colors hover:text-[var(--accent-primary-hover)]"
              >
                View More
              </Link>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
