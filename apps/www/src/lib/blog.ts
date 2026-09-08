import { getServerSupabase } from "./supabase";

export type BlogPost = {
  id: number;
  slug: string;
  title: string;
  excerpt: string;
  content: string;
  category: string;
  cover_image_url: string | null;
  seo_title: string | null;
  seo_description: string | null;
  published_at: string;
  updated_at: string;
};

export async function getPublishedBlogPosts(limit = 50): Promise<BlogPost[]> {
  const db = getServerSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("blog_posts")
    .select("id, slug, title, excerpt, content, category, cover_image_url, seo_title, seo_description, published_at, updated_at")
    .eq("status", "published")
    .lte("published_at", new Date().toISOString())
    .order("published_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("published blog query error:", error.message);
    return [];
  }
  return (data || []) as BlogPost[];
}

export async function getPublishedBlogPost(slug: string): Promise<BlogPost | null> {
  const db = getServerSupabase();
  if (!db || !slug) return null;
  const { data, error } = await db
    .from("blog_posts")
    .select("id, slug, title, excerpt, content, category, cover_image_url, seo_title, seo_description, published_at, updated_at")
    .eq("slug", slug)
    .eq("status", "published")
    .lte("published_at", new Date().toISOString())
    .maybeSingle();
  if (error) {
    console.error("published blog post query error:", error.message);
    return null;
  }
  return (data || null) as BlogPost | null;
}

export function formatBlogDate(value: string): string {
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "long" }).format(new Date(value));
}

/** Render the deliberately small, safe editor format without injecting HTML. */
export function blogBlocks(content: string): Array<{ kind: "heading" | "paragraph" | "bullet"; text: string }> {
  const blocks: Array<{ kind: "heading" | "paragraph" | "bullet"; text: string }> = [];
  String(content || "")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .forEach((block) => {
      if (block.startsWith("## ")) {
        blocks.push({ kind: "heading", text: block.slice(3).trim() });
        return;
      }
      if (block.split("\n").every((line) => line.trim().startsWith("- "))) {
        block.split("\n").forEach((line) => blocks.push({ kind: "bullet", text: line.trim().slice(2).trim() }));
        return;
      }
      blocks.push({ kind: "paragraph", text: block.replace(/\n+/g, " ").trim() });
    });
  return blocks;
}
