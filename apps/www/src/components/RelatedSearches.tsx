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
    <section className="mt-12" aria-label="Related to your search">
      <div className="flex items-center gap-2.5 mb-6">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-400/15">
          <Compass className="h-4 w-4 text-green-400" aria-hidden="true" />
        </div>
        <h2 className="text-lg font-semibold text-white">Related to your search</h2>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {sections.map((section) => (
          <div
            key={section.heading}
            className="rounded-2xl border border-white/10 bg-zinc-950/80 p-5"
          >
            <h3 className="text-sm font-semibold text-white mb-3">
              {section.heading}
            </h3>
            <ul className="space-y-1.5">
              {section.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="group flex items-center gap-2 text-sm text-zinc-400 hover:text-green-300 transition-colors"
                  >
                    <span className="h-1 w-1 rounded-full bg-zinc-600 group-hover:bg-green-400 shrink-0" />
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
            {section.viewMoreHref && (
              <Link
                href={section.viewMoreHref}
                className="mt-3 inline-block text-xs font-medium text-green-400 hover:text-green-300 transition-colors"
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
