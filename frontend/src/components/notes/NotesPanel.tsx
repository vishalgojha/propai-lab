"use client";

import { useEffect, useState, useRef } from "react";
import { StickyNote, Trash2, Plus, AtSign, Loader2 } from "lucide-react";
import { getNotes, createNote, deleteNote, getTeamMembers, type Note, type TeamMember } from "@/lib/api";

interface Props {
  entityType: "chat" | "broker" | "building";
  entityId: string;
}

export default function NotesPanel({ entityType, entityId }: Props) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [newBody, setNewBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [showMentionPopover, setShowMentionPopover] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const fetchNotes = async () => {
    setLoading(true);
    try {
      const { notes: data } = await getNotes(entityType, entityId);
      setNotes(data);
    } catch (err) {
      console.error("Failed to fetch notes", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchNotes();
    getTeamMembers()
      .then((r) => setMembers(r.members))
      .catch(() => {});
  }, [entityType, entityId]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowMentionPopover(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleTextChange = (val: string) => {
    setNewBody(val);
    // Detect @ trigger for mention popover
    const lastAtIndex = val.lastIndexOf("@");
    if (lastAtIndex !== -1 && (lastAtIndex === 0 || val[lastAtIndex - 1] === " ")) {
      const query = val.slice(lastAtIndex + 1);
      if (!query.includes(" ")) {
        setMentionFilter(query);
        setShowMentionPopover(true);
        return;
      }
    }
    setShowMentionPopover(false);
  };

  const insertMention = (m: TeamMember) => {
    const val = newBody;
    const lastAtIndex = val.lastIndexOf("@");
    const before = val.slice(0, lastAtIndex);
    const after = val.slice(lastAtIndex + mentionFilter.length + 1);
    setNewBody(`${before}@${m.name} ${after}`);
    setShowMentionPopover(false);
    textareaRef.current?.focus();
  };

  const handleSubmit = async () => {
    if (!newBody.trim() || saving) return;
    setSaving(true);
    try {
      await createNote({
        entity_type: entityType,
        entity_id: entityId,
        body: newBody.trim(),
      });
      setNewBody("");
      await fetchNotes();
    } catch (err) {
      console.error("Failed to create note", err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (noteId: number) => {
    try {
      await deleteNote(noteId);
      await fetchNotes();
    } catch (err) {
      console.error("Failed to delete note", err);
    }
  };

  const filteredMembers = members.filter((m) =>
    m.name.toLowerCase().includes(mentionFilter.toLowerCase())
  );

  return (
    <div className="space-y-4 animate-fadeIn">
      {/* Header */}
      <div className="flex items-center gap-2 text-zinc-300 text-sm font-semibold">
        <StickyNote size={14} />
        Notes
      </div>

      {/* New note form */}
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={newBody}
          onChange={(e) => handleTextChange(e.target.value)}
          placeholder="Add a note... (type @ to mention)"
          rows={3}
          className="w-full bg-zinc-800/50 border border-zinc-700 rounded-lg p-3 text-sm text-zinc-200 placeholder-zinc-500 resize-none focus:outline-none focus:ring-1 focus:ring-blue-500"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleSubmit();
            }
          }}
        />
        {showMentionPopover && filteredMembers.length > 0 && (
          <div
            ref={popoverRef}
            className="absolute bottom-full left-0 mb-1 w-56 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl z-10 max-h-40 overflow-y-auto"
          >
            {filteredMembers.map((m) => (
              <button
                key={m.id}
                onClick={() => insertMention(m)}
                className="w-full text-left px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-700 transition-colors flex items-center gap-2"
              >
                <AtSign size={12} className="text-blue-400 shrink-0" />
                {m.name}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between mt-2">
          <span className="text-[10px] text-zinc-500">Cmd+Enter to save</span>
          <button
            onClick={handleSubmit}
            disabled={!newBody.trim() || saving}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium rounded-md transition-colors"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            Add Note
          </button>
        </div>
      </div>

      {/* Notes list */}
      {loading ? (
        <div className="flex items-center justify-center py-6 text-zinc-500 text-xs">
          <Loader2 size={14} className="animate-spin mr-2" />
          Loading notes...
        </div>
      ) : notes.length === 0 ? (
        <p className="text-zinc-500 text-xs py-6 text-center">No notes yet</p>
      ) : (
        <div className="space-y-3">
          {notes.map((note) => (
            <div
              key={note.id}
              className="border-b border-white/[0.04] last:border-0 py-3 relative group"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-xs text-zinc-500 mb-1">
                    <span className="font-medium text-zinc-400">
                      {note.author_name || `Member #${note.author_id}`}
                    </span>
                    <span>&middot;</span>
                    <span>{new Date(note.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                  </div>
                  <p className="text-sm text-zinc-300 whitespace-pre-wrap break-words">
                    {note.body}
                  </p>
                  {note.mentioned_member_ids && note.mentioned_member_ids.length > 0 && (
                    <div className="flex items-center gap-1 mt-1.5">
                      <AtSign size={10} className="text-blue-400" />
                      <span className="text-[10px] text-blue-400">
                        {note.mentioned_member_ids.length} member{note.mentioned_member_ids.length > 1 ? "s" : ""} mentioned
                      </span>
                    </div>
                  )}
                </div>
              </div>
              <button
                onClick={() => handleDelete(note.id)}
                className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 p-1 rounded text-zinc-500 hover:text-red-400 hover:bg-red-950/30 transition-all"
                title="Delete note"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
