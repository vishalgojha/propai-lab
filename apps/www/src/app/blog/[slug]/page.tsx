import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { blogBlocks, formatBlogDate, getPublishedBlogPost } from "@/lib/blog";

function inlineMarkdown(text: string) {
  return text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\((?:https?:\/\/|\/)[^)]+\))/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*")) return <em key={index}>{part.slice(1, -1)}</em>;
    const link = part.match(/^\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)]+)\)$/);
    if (link) return <a key={index} href={link[2]} className="font-semibold text-[var(--accent-forest)] underline underline-offset-4">{link[1]}</a>;
    return part;
  });
}

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPublishedBlogPost(slug);
  if (!post) return { title: "Article not found | PropAI" };
  return {
    title: post.seo_title || `${post.title} | PropAI Blog`,
    description: post.seo_description || post.excerpt,
    alternates: { canonical: `/blog/${post.slug}` },
    openGraph: { title: post.seo_title || post.title, description: post.seo_description || post.excerpt, type: "article", publishedTime: post.published_at },
  };
}

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = await getPublishedBlogPost(slug);
  if (!post) notFound();
  const blocks = blogBlocks(post.content);
  return (
    <div className="www-shell min-h-screen">
      <SiteHeader backHref="/blog" backLabel="Back to blog" />
      <main className="www-page-main mx-auto max-w-3xl px-4 py-12 lg:px-6 lg:py-20">
        <Link href="/blog" className="site-back-link">← Back to blog</Link>
        <p className="mt-12 text-xs font-semibold uppercase tracking-[.14em] text-[var(--accent-forest)]">{post.category}</p>
        <h1 className="mt-4 text-4xl font-semibold leading-[1.05] tracking-[-.04em] sm:text-6xl">{post.title}</h1>
        <p className="mt-5 text-lg leading-8 text-[var(--text-secondary)]">{post.excerpt}</p>
        <p className="mt-5 text-xs text-[var(--text-secondary)]">Published {formatBlogDate(post.published_at)}</p>
        {post.cover_image_url && <img src={post.cover_image_url} alt="" className="mt-10 max-h-[420px] w-full object-cover" />}
        <article className="mt-12 border-t border-[var(--border-subtle)] pt-10">
          {blocks.map((block, index) => block.kind === "heading" ? <h2 key={index} className="mb-4 mt-10 text-2xl font-semibold tracking-[-.025em]">{inlineMarkdown(block.text)}</h2> : block.kind === "bullet" ? <li key={index} className="ml-5 list-disc text-base leading-8 text-[var(--text-secondary)]">{inlineMarkdown(block.text)}</li> : block.kind === "quote" ? <blockquote key={index} className="my-8 border-l-2 border-[var(--accent-forest)] pl-5 text-lg italic leading-8 text-[var(--text-secondary)]">{inlineMarkdown(block.text)}</blockquote> : block.kind === "divider" ? <hr key={index} className="my-10 border-[var(--border-subtle)]" /> : <p key={index} className="mb-6 text-base leading-8 text-[var(--text-secondary)]">{inlineMarkdown(block.text)}</p>)}
        </article>
        <div className="mt-12 border-t border-[var(--border-subtle)] pt-8 text-sm text-[var(--text-secondary)]">Looking for a property? <Link href="/search" className="font-semibold text-[var(--accent-forest)] underline underline-offset-4">Search live listings on PropAI</Link>.</div>
      </main>
      <SiteFooter />
    </div>
  );
}
