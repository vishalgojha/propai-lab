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
  const [featured, ...morePosts] = posts;
  return (
    <div className="www-shell min-h-screen">
      <SiteHeader />
      <main className="www-page-main mx-auto max-w-6xl px-4 py-12 lg:px-6 lg:py-20">
        <div className="flex flex-wrap items-end justify-between gap-8 border-b border-[var(--border-subtle)] pb-10">
          <div className="max-w-2xl">
            <p className="mp-label">PropAI Blog</p>
            <h1 className="mt-4 text-4xl font-semibold leading-tight tracking-[-.035em] sm:text-6xl">Useful property knowledge, close to the market.</h1>
            <p className="mt-5 text-base leading-7 text-[var(--text-secondary)] sm:text-lg">Clear guides for renting, buying, and understanding local property markets through the broker network.</p>
          </div>
          <div className="min-w-[150px] border-l-2 border-[var(--accent-forest)] pl-4"><p className="text-3xl font-semibold tracking-[-.03em]">{posts.length}</p><p className="mt-1 text-xs uppercase tracking-[.14em] text-[var(--text-secondary)]">Published guides</p></div>
        </div>

        {posts.length === 0 ? (
          <div className="mt-12 border-y border-[var(--border-subtle)] py-12 text-[var(--text-secondary)]">New guides are being prepared. Browse <Link className="font-semibold text-[var(--accent-forest)] underline underline-offset-4" href="/localities">localities</Link> or <Link className="font-semibold text-[var(--accent-forest)] underline underline-offset-4" href="/search">search live listings</Link> meanwhile.</div>
        ) : (
          <div className="mt-12 space-y-12">
            <article className="grid overflow-hidden border border-[var(--border-subtle)] bg-[var(--bg-surface)] md:grid-cols-[1.15fr_.85fr]">
              <div className="flex min-h-[330px] flex-col justify-end p-7 sm:p-10">
                <p className="text-xs font-semibold uppercase tracking-[.14em] text-[var(--accent-forest)]">{featured.category}</p>
                <h2 className="mt-4 max-w-2xl text-3xl font-semibold leading-tight tracking-[-.03em] sm:text-5xl"><Link href={`/blog/${featured.slug}`}>{featured.title}</Link></h2>
                <p className="mt-4 max-w-xl text-base leading-7 text-[var(--text-secondary)]">{featured.excerpt}</p>
                <p className="mt-7 text-xs text-[var(--text-secondary)]">Published {formatBlogDate(featured.published_at)}</p>
              </div>
              <div className="min-h-[260px] bg-[var(--accent-forest)] p-7 text-[var(--bg-surface)] sm:p-10">
                {featured.cover_image_url ? <img src={featured.cover_image_url} alt="" className="h-full min-h-[220px] w-full object-cover" /> : <div className="flex h-full min-h-[220px] flex-col justify-between border border-white/25 p-6"><span className="text-sm uppercase tracking-[.16em]">PropAI field notes</span><span className="text-6xl font-semibold leading-none tracking-[-.06em]">{String(posts.length).padStart(2, "0")}</span></div>}
              </div>
            </article>
            {morePosts.length > 0 && <div><div className="mb-5 flex items-end justify-between gap-4"><div><p className="mp-label">Keep reading</p><h2 className="mt-2 text-2xl font-semibold tracking-[-.025em]">More from PropAI</h2></div><span className="text-xs text-[var(--text-secondary)]">{morePosts.length} more guide{morePosts.length === 1 ? "" : "s"}</span></div><div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">{morePosts.map((post) => <article key={post.id} className="flex min-h-[260px] flex-col border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6 transition-transform hover:-translate-y-1">{post.cover_image_url && <img src={post.cover_image_url} alt="" className="-mx-6 -mt-6 mb-6 h-40 w-[calc(100%+3rem)] object-cover" />}<p className="text-xs font-semibold uppercase tracking-[.14em] text-[var(--accent-forest)]">{post.category}</p><h3 className="mt-4 text-2xl font-semibold leading-tight tracking-[-.025em]"><Link href={`/blog/${post.slug}`}>{post.title}</Link></h3><p className="mt-3 flex-1 text-sm leading-6 text-[var(--text-secondary)]">{post.excerpt}</p><p className="mt-6 text-xs text-[var(--text-secondary)]">{formatBlogDate(post.published_at)}</p></article>)}</div></div>}
          </div>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
