import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { formatBlogDate, getPublishedBlogPosts } from "@/lib/blog";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "PropAI Blog — Property Guides and Locality Insights",
  description: "Practical property guides, locality explainers, and insights from the live broker network on PropAI.",
};

export default async function BlogPage() {
  const posts = await getPublishedBlogPosts();
  return (
    <div className="www-shell min-h-screen">
      <SiteHeader />
      <main className="www-page-main mx-auto max-w-6xl px-4 py-12 lg:px-6 lg:py-20">
        <div className="max-w-2xl">
          <p className="mp-label">PropAI Blog</p>
          <h1 className="mt-4 text-4xl font-semibold leading-tight tracking-[-.035em] sm:text-6xl">Useful property knowledge, close to the market.</h1>
          <p className="mt-5 text-base leading-7 text-[var(--text-secondary)] sm:text-lg">Clear guides for renting, buying, and understanding local property markets through the broker network.</p>
        </div>

        {posts.length === 0 ? (
          <div className="mt-12 border-y border-[var(--border-subtle)] py-12 text-[var(--text-secondary)]">New guides are being prepared. Browse <Link className="font-semibold text-[var(--accent-forest)] underline underline-offset-4" href="/localities">localities</Link> or <Link className="font-semibold text-[var(--accent-forest)] underline underline-offset-4" href="/search">search live listings</Link> meanwhile.</div>
        ) : (
          <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {posts.map((post) => (
              <article key={post.id} className="flex min-h-[260px] flex-col border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6 transition-transform hover:-translate-y-1">
                {post.cover_image_url && <img src={post.cover_image_url} alt="" className="-mx-6 -mt-6 mb-6 h-40 w-[calc(100%+3rem)] object-cover" />}
                <p className="text-xs font-semibold uppercase tracking-[.14em] text-[var(--accent-forest)]">{post.category}</p>
                <h2 className="mt-4 text-2xl font-semibold leading-tight tracking-[-.025em]"><Link href={`/blog/${post.slug}`}>{post.title}</Link></h2>
                <p className="mt-3 flex-1 text-sm leading-6 text-[var(--text-secondary)]">{post.excerpt}</p>
                <p className="mt-6 text-xs text-[var(--text-secondary)]">{formatBlogDate(post.published_at)}</p>
              </article>
            ))}
          </div>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
