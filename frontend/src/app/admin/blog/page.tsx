"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, BookOpen, Check, CheckCircle2, Clock3, Eye, FileText, Globe2, Image as ImageIcon, Pencil, Plus, Save, Trash2 } from "lucide-react";
import { fetchJSON } from "@/lib/api";

type BlogPost = {
  id: number;
  slug: string;
  title: string;
  excerpt: string;
  content: string;
  category: string;
  cover_image_url: string | null;
  seo_title: string | null;
  seo_description: string | null;
  status: "draft" | "published";
  published_at: string | null;
  created_at: string;
  updated_at: string;
};

type EditorState = Omit<BlogPost, "id" | "created_at" | "updated_at">;

const blank: EditorState = { slug: "", title: "", excerpt: "", content: "", category: "Property guides", cover_image_url: null, seo_title: null, seo_description: null, status: "draft", published_at: null };

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}

function formFromPost(post: BlogPost): EditorState {
  return { slug: post.slug, title: post.title, excerpt: post.excerpt, content: post.content, category: post.category, cover_image_url: post.cover_image_url, seo_title: post.seo_title, seo_description: post.seo_description, status: post.status, published_at: post.published_at };
}

export default function AdminBlogPage() {
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [editor, setEditor] = useState<EditorState>(blank);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchJSON<{ rows: BlogPost[] }>("/admin/supabase-table/blog_posts?limit=100&offset=0");
      setPosts((result.rows || []).sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()));
      setError(null);
      } catch (err) { setError(err instanceof Error ? err.message : "Blog posts could not be loaded. Check the database connection and retry."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const update = (key: keyof EditorState, value: string | null) => setEditor((current) => ({ ...current, [key]: value }));
  const wordCount = useMemo(() => editor.content.trim() ? editor.content.trim().split(/\s+/).length : 0, [editor.content]);
  const completedFields = [editor.title, editor.slug, editor.excerpt, editor.content, editor.category].filter((value) => Boolean(value?.trim())).length;

  const applyFormat = (prefix: string, suffix = "", block = false) => {
    const input = contentRef.current;
    if (!input) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const selected = editor.content.slice(start, end);
    const value = block ? selected.split("\n").map((line) => `${prefix}${line}`).join("\n") : `${prefix}${selected || "text"}${suffix}`;
    update("content", `${editor.content.slice(0, start)}${value}${editor.content.slice(end)}`);
    requestAnimationFrame(() => { input.focus(); input.setSelectionRange(start + prefix.length, start + value.length - suffix.length); });
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editor.title.trim() || !editor.excerpt.trim() || !editor.content.trim()) { setError("Title, excerpt, and article content are required."); return; }
    setSaving(true); setError(null); setNotice(null);
    const values = { ...editor, slug: editor.slug.trim() || slugify(editor.title), title: editor.title.trim(), excerpt: editor.excerpt.trim(), content: editor.content.trim(), published_at: editor.status === "published" ? editor.published_at || new Date().toISOString() : null };
    try {
      if (editingId) await fetchJSON(`/admin/supabase-table/blog_posts/${editingId}`, { method: "PATCH", body: JSON.stringify({ values }) });
      else await fetchJSON("/admin/supabase-table/blog_posts", { method: "POST", body: JSON.stringify({ values }) });
      await load(); setEditor(blank); setEditingId(null); setNotice(values.status === "published" ? "Article published on www.propai.live." : "Draft saved.");
    } catch (err) { setError(err instanceof Error ? err.message : "Article could not be saved"); }
    finally { setSaving(false); }
  };

  const remove = async (post: BlogPost) => {
    if (!window.confirm(`Delete “${post.title}”?`)) return;
    try { await fetchJSON(`/admin/supabase-table/blog_posts/${post.id}`, { method: "DELETE" }); await load(); if (editingId === post.id) { setEditingId(null); setEditor(blank); } setNotice("Article deleted."); }
    catch (err) { setError(err instanceof Error ? err.message : "Article could not be deleted"); }
  };

  return <main className="min-h-screen bg-[#DDE8E5] px-4 py-6 text-[#16252B] sm:px-8 lg:px-10">
    <div className="mx-auto max-w-[1500px] space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-[rgba(22,37,43,.14)] pb-5">
        <div className="flex items-start gap-3"><Link href="/admin" className="mt-1 text-[#49615F] hover:text-[#16252B]"><ArrowLeft className="h-5 w-5" /></Link><div><p className="text-[10px] font-semibold uppercase tracking-[.16em] text-[#287D82]">Super Admin · Public content</p><h1 className="mt-1 text-3xl font-semibold tracking-[-.04em]">PropAI Blog</h1><p className="mt-2 max-w-2xl text-sm text-[#49615F]">Write practical property and locality guides for Google and PropAI visitors. Drafts are private until you publish them.</p></div></div>
        <Link href="https://www.propai.live/blog" target="_blank" className="inline-flex items-center gap-2 rounded-md border border-[rgba(22,37,43,.18)] bg-[#F6FBF9] px-3 py-2 text-xs font-semibold text-[#287D82] hover:border-[#287D82]"><Eye className="h-4 w-4" /> View public blog</Link>
      </header>

      {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#A9362E]/30 bg-[#FFF3F0] px-4 py-3 text-sm text-[#A9362E]"><span>{error}</span><button type="button" onClick={() => void load()} className="rounded-md border border-[#A9362E]/30 px-3 py-1.5 text-xs font-semibold hover:bg-white">Retry</button></div>}
      {notice && <div role="status" className="rounded-xl border border-[#2F6B3A]/30 bg-[#F0F8F1] px-4 py-3 text-sm text-[#2F6B3A]"><Check className="mr-2 inline h-4 w-4" />{notice}</div>}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,.8fr)]">
        <form onSubmit={save} className="rounded-2xl border border-[rgba(22,37,43,.14)] bg-[#F6FBF9] p-5 shadow-[0_8px_22px_rgba(22,37,43,.05)]">
          <div className="mb-5 flex items-center justify-between gap-3"><div className="flex items-center gap-2"><BookOpen className="h-4 w-4 text-[#287D82]" /><h2 className="font-semibold">{editingId ? "Edit article" : "New article"}</h2></div>{editingId && <button type="button" onClick={() => { setEditingId(null); setEditor(blank); }} className="text-xs text-[#49615F] hover:text-[#16252B]">Start new article</button>}</div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="sm:col-span-2"><span className="field-label">Title</span><input value={editor.title} onChange={(e) => { update("title", e.target.value); if (!editingId && !editor.slug) update("slug", slugify(e.target.value)); }} className="field" placeholder="Andheri West rental guide" required /></label>
            <label><span className="field-label">URL slug</span><input value={editor.slug} onChange={(e) => update("slug", slugify(e.target.value))} className="field" placeholder="andheri-west-rental-guide" required /></label>
            <label><span className="field-label">Category</span><input value={editor.category} onChange={(e) => update("category", e.target.value)} className="field" placeholder="Locality guides" /></label>
            <label className="sm:col-span-2"><span className="field-label">Excerpt <span className="normal-case tracking-normal text-[#49615F]">({editor.excerpt.length}/220)</span></span><textarea value={editor.excerpt} maxLength={220} onChange={(e) => update("excerpt", e.target.value)} className="field min-h-20" placeholder="A short summary shown on the blog and in search results." required /></label>
            <label className="sm:col-span-2"><div className="flex items-end justify-between gap-3"><span className="field-label">Article content <span className="normal-case tracking-normal text-[#49615F]">({wordCount.toLocaleString("en-IN")} words)</span></span><span className="text-[10px] text-[#49615F]">Formatting is preserved on the public blog</span></div><div className="overflow-hidden rounded-md border border-[rgba(22,37,43,.18)] bg-white"><div className="flex flex-wrap items-center gap-1 border-b border-[rgba(22,37,43,.1)] bg-[#EDF5F2] p-2" role="toolbar" aria-label="Article formatting"><button type="button" onClick={() => applyFormat("## ", "", true)} className="format-button" title="Heading">H2</button><button type="button" onClick={() => applyFormat("**", "**")} className="format-button font-bold" title="Bold">B</button><button type="button" onClick={() => applyFormat("*", "*")} className="format-button italic" title="Italic">I</button><button type="button" onClick={() => applyFormat("- ", "", true)} className="format-button" title="Bullet list">• List</button><button type="button" onClick={() => applyFormat("> ", "", true)} className="format-button" title="Quote">“ Quote</button><button type="button" onClick={() => applyFormat("[", "](https://)")} className="format-button" title="Link">↗ Link</button><button type="button" onClick={() => applyFormat("---\n\n")} className="format-button" title="Divider">―</button></div><textarea ref={contentRef} value={editor.content} onChange={(e) => update("content", e.target.value)} className="field min-h-[360px] rounded-none border-0 font-mono text-xs leading-6 focus:ring-0" placeholder={"Write one paragraph per block.\n\nUse the toolbar or start a line with ## for a heading."} required /></div></label>
            <label className="sm:col-span-2"><span className="field-label">Cover image URL <span className="normal-case tracking-normal text-[#49615F]">(optional)</span></span><input value={editor.cover_image_url || ""} onChange={(e) => update("cover_image_url", e.target.value || null)} className="field" placeholder="https://..." /></label>
            <label><span className="field-label">SEO title <span className="normal-case tracking-normal text-[#49615F]">(optional)</span></span><input value={editor.seo_title || ""} onChange={(e) => update("seo_title", e.target.value || null)} className="field" /></label>
            <label><span className="field-label">SEO description <span className="normal-case tracking-normal text-[#49615F]">(optional)</span></span><input value={editor.seo_description || ""} onChange={(e) => update("seo_description", e.target.value || null)} className="field" /></label>
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[rgba(22,37,43,.1)] pt-5"><label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={editor.status === "published"} onChange={(e) => update("status", e.target.checked ? "published" : "draft")} /> Publish on www.propai.live</label><button disabled={saving} className="inline-flex items-center gap-2 rounded-md bg-[#16252B] px-4 py-2.5 text-sm font-semibold text-[#F6FBF9] hover:bg-[#287D82] disabled:opacity-50"><Save className="h-4 w-4" />{saving ? "Saving…" : editingId ? "Save changes" : "Save article"}</button></div>
          <p className="mt-4 text-[11px] leading-5 text-[#49615F]">Use only accurate, source-backed claims. Public articles are editorial content and must not invent inventory, market-wide statistics, broker endorsements, or property availability.</p>
        </form>

        <div className="space-y-6">
          <section className="overflow-hidden rounded-2xl border border-[#287D82]/25 bg-[#16252B] text-[#F6FBF9] shadow-[0_12px_30px_rgba(22,37,43,.12)]">
            <div className="border-b border-white/10 px-5 py-4"><div className="flex items-center justify-between gap-3"><div><p className="text-[10px] font-semibold uppercase tracking-[.16em] text-[#9BD5C2]">Live preview</p><h2 className="mt-1 font-semibold">How this article will read</h2></div><Globe2 className="h-5 w-5 text-[#9BD5C2]" /></div></div>
            <div className="p-5">
              {editor.cover_image_url ? <img src={editor.cover_image_url} alt="" className="mb-5 h-32 w-full rounded-xl object-cover" /> : <div className="mb-5 flex h-32 items-end rounded-xl bg-[#287D82] p-4"><ImageIcon className="h-6 w-6 text-[#DDE8E5]" /></div>}
              <p className="text-[10px] font-semibold uppercase tracking-[.16em] text-[#9BD5C2]">{editor.category || "Property guides"}</p>
              <h3 className="mt-3 text-2xl font-semibold leading-tight tracking-[-.03em]">{editor.title || "Your article title"}</h3>
              <p className="mt-3 text-sm leading-6 text-[#C7D8D2]">{editor.excerpt || "Add an excerpt to give readers a clear reason to open this guide."}</p>
              <div className="mt-5 flex items-center gap-4 border-t border-white/10 pt-4 text-xs text-[#9FB6AF]"><span className="inline-flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5" />{wordCount ? `${Math.max(1, Math.ceil(wordCount / 200))} min read` : "Reading time"}</span><span className="inline-flex items-center gap-1.5"><FileText className="h-3.5 w-3.5" />/{editor.slug || "article-slug"}</span></div>
            </div>
          </section>

          <section className="rounded-2xl border border-[rgba(22,37,43,.14)] bg-[#F6FBF9] p-5 shadow-[0_8px_22px_rgba(22,37,43,.05)]"><div className="flex items-center justify-between gap-4"><div><p className="text-[10px] font-semibold uppercase tracking-[.16em] text-[#287D82]">Publishing checklist</p><h2 className="mt-1 font-semibold">Ready when you are</h2></div><span className="text-2xl font-semibold tracking-[-.04em] text-[#287D82]">{completedFields}/5</span></div><div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[#DDE8E5]"><div className="h-full rounded-full bg-[#287D82] transition-all" style={{ width: `${completedFields * 20}%` }} /></div><div className="mt-4 space-y-2 text-xs text-[#49615F]"><p className="flex items-center gap-2">{editor.title ? <CheckCircle2 className="h-4 w-4 text-[#2F6B3A]" /> : <span className="h-4 w-4 rounded-full border border-[#9FB6AF]" />} Add a clear title</p><p className="flex items-center gap-2">{editor.excerpt ? <CheckCircle2 className="h-4 w-4 text-[#2F6B3A]" /> : <span className="h-4 w-4 rounded-full border border-[#9FB6AF]" />} Summarize the guide</p><p className="flex items-center gap-2">{editor.content ? <CheckCircle2 className="h-4 w-4 text-[#2F6B3A]" /> : <span className="h-4 w-4 rounded-full border border-[#9FB6AF]" />} Write source-backed content</p></div></section>

          <section className="rounded-2xl border border-[rgba(22,37,43,.14)] bg-[#F6FBF9] p-5 shadow-[0_8px_22px_rgba(22,37,43,.05)]"><div className="mb-4 flex items-center justify-between"><div><h2 className="font-semibold">Articles</h2><p className="mt-1 text-xs text-[#49615F]">{posts.length} saved article{posts.length === 1 ? "" : "s"}</p></div><button type="button" onClick={() => { setEditingId(null); setEditor(blank); }} className="inline-flex items-center gap-1 rounded-md border border-[#287D82]/30 px-2.5 py-1.5 text-xs font-semibold text-[#287D82] hover:bg-[#EAF3F0]"><Plus className="h-3.5 w-3.5" />New</button></div>
            {loading ? <p className="py-10 text-center text-sm text-[#49615F]">Loading articles…</p> : posts.length === 0 ? <div className="border-y border-[rgba(22,37,43,.1)] py-8 text-center"><BookOpen className="mx-auto h-7 w-7 text-[#287D82]" /><p className="mt-3 text-sm font-semibold">Your library is ready</p><p className="mt-1 text-xs text-[#49615F]">Save your first draft to see it here.</p></div> : <div className="space-y-2">{posts.map((post) => <div key={post.id} className={`group rounded-xl border p-3 ${editingId === post.id ? "border-[#287D82] bg-[#EAF3F0]" : "border-[rgba(22,37,43,.1)] bg-white/60"}`}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-semibold">{post.title}</p><p className="mt-1 text-[11px] text-[#49615F]">{post.category} · {post.status === "published" ? "Published" : "Draft"}</p></div><span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wider ${post.status === "published" ? "bg-[#DDF0E0] text-[#2F6B3A]" : "bg-[#F5EBD1] text-[#8A5A00]"}`}>{post.status}</span></div><div className="mt-3 flex items-center justify-between gap-3"><span className="truncate text-[11px] text-[#49615F]">/blog/{post.slug}</span><div className="flex gap-2 opacity-70 transition-opacity group-hover:opacity-100"><button type="button" title="Edit article" onClick={() => { setEditingId(post.id); setEditor(formFromPost(post)); }} className="rounded-md p-1.5 text-[#287D82] hover:bg-[#DDE8E5]"><Pencil className="h-3.5 w-3.5" /></button><button type="button" title="Delete article" onClick={() => void remove(post)} className="rounded-md p-1.5 text-[#A9362E] hover:bg-[#FFF3F0]"><Trash2 className="h-3.5 w-3.5" /></button></div></div></div>)}</div>}
          </section>
        </div>
      </div>
    </div></main>;
}
