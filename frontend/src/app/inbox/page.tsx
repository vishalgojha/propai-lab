"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import * as api from "@/lib/api";

const PAGE_SIZE = 100;

export default function BrokerWorkspacePage() {
  // Left Panel States
  const [messages, setMessages] = useState<api.RawMessage[]>([]);
  const [loadingLeft, setLoadingLeft] = useState(false);
  const [offset, setOffset] = useState(0);
  const [searchText, setSearchText] = useState("");
  const [viewMode, setViewMode] = useState<"all" | "groups" | "direct">("all");

  // Selection States
  const [selectedMsg, setSelectedMsg] = useState<api.RawMessage | null>(null);
  
  // Center Panel States
  const [conversationMessages, setConversationMessages] = useState<api.RawMessage[]>([]);
  const [loadingConv, setLoadingConv] = useState(false);
  const threadEndRef = useRef<HTMLDivElement>(null);

  // Right Panel States
  const [activeRightTab, setActiveRightTab] = useState<"analysis" | "broker" | "building">("analysis");
  const [selectedMsgDetails, setSelectedMsgDetails] = useState<any>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [selectedBroker, setSelectedBroker] = useState<any>(null);
  const [loadingBroker, setLoadingBroker] = useState(false);
  const [selectedBuilding, setSelectedBuilding] = useState<any>(null);
  const [loadingBuilding, setLoadingBuilding] = useState(false);
  const [priceStats, setPriceStats] = useState<any>(null);
  const [loadingPriceStats, setLoadingPriceStats] = useState(false);
  const [allSuggestions, setAllSuggestions] = useState<any[]>([]);
  
  // Interaction/UI States
  const [revealedPhone, setRevealedPhone] = useState<Record<string, boolean>>({});
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  // 1. Initial Load of Feed & Suggestions
  const loadFeed = useCallback(async () => {
    setLoadingLeft(true);
    try {
      const rawMsgs = await api.getRaw(PAGE_SIZE, offset);
      setMessages(rawMsgs);
      const sugData = await api.getSuggestions("pending", 100);
      setAllSuggestions(sugData);
    } catch (e) {
      console.error("Failed to load feed:", e);
    } finally {
      setLoadingLeft(false);
    }
  }, [offset]);

  useEffect(() => {
    loadFeed();
  }, [loadFeed]);

  // Scroll to bottom of conversation thread when new messages arrive
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversationMessages]);

  // 2. Compute Left Panel Grouped Lists
  const filteredMessages = messages.filter(
    (m) =>
      !searchText ||
      m.message.toLowerCase().includes(searchText.toLowerCase()) ||
      m.sender.toLowerCase().includes(searchText.toLowerCase()) ||
      m.group_name.toLowerCase().includes(searchText.toLowerCase())
  );

  // Group by WhatsApp Group name
  const groupChats = (() => {
    const groups: Record<string, { latest: api.RawMessage; count: number }> = {};
    filteredMessages.forEach((m) => {
      // Treat non-empty and non-seed as groups
      const groupName = m.group_name?.trim();
      if (groupName && groupName !== "seed" && groupName !== "seed-bot") {
        if (!groups[groupName] || new Date(m.timestamp) > new Date(groups[groupName].latest.timestamp)) {
          groups[groupName] = { latest: m, count: (groups[groupName]?.count || 0) + 1 };
        } else {
          groups[groupName].count += 1;
        }
      }
    });
    return Object.entries(groups)
      .map(([name, data]) => ({
        name,
        latest: data.latest,
        count: data.count,
      }))
      .sort((a, b) => new Date(b.latest.timestamp).getTime() - new Date(a.latest.timestamp).getTime());
  })();

  // Group by Direct Chats (Sender)
  const directChats = (() => {
    const direct: Record<string, { latest: api.RawMessage; count: number }> = {};
    filteredMessages.forEach((m) => {
      const isGroup = m.group_name && m.group_name !== "seed" && m.group_name !== "seed-bot";
      if (!isGroup) {
        const key = m.sender_phone || m.sender_jid || m.sender || "Unknown";
        if (!direct[key] || new Date(m.timestamp) > new Date(direct[key].latest.timestamp)) {
          direct[key] = { latest: m, count: (direct[key]?.count || 0) + 1 };
        } else {
          direct[key].count += 1;
        }
      }
    });
    return Object.entries(direct)
      .map(([senderKey, data]) => ({
        senderKey,
        name: data.latest.sender || senderKey,
        latest: data.latest,
        count: data.count,
      }))
      .sort((a, b) => new Date(b.latest.timestamp).getTime() - new Date(a.latest.timestamp).getTime());
  })();

  // 3. Load Conversation Thread (Center Panel)
  const selectConversation = async (msg: api.RawMessage) => {
    setSelectedMsg(msg);
    setLoadingConv(true);
    try {
      let thread: api.RawMessage[] = [];
      const groupName = msg.group_name?.trim();
      if (groupName && groupName !== "seed" && groupName !== "seed-bot") {
        // Group Conversation
        thread = await api.getRaw(80, 0, groupName);
      } else {
        // Direct Chat Conversation
        const phone = msg.sender_phone || undefined;
        const jid = msg.sender_jid || undefined;
        thread = await api.getRaw(80, 0, undefined, undefined, phone, jid);
      }
      // Threads come newest first, reverse to show chronological top-to-bottom
      setConversationMessages(thread.slice().reverse());
      
      // Load intelligence details for the selected message immediately
      loadMessageDetails(msg.id);
    } catch (e) {
      console.error("Failed to load thread:", e);
    } finally {
      setLoadingConv(false);
    }
  };

  // 4. Load Detailed Analysis, Broker, and Building (Right Panel)
  const loadMessageDetails = async (msgId: number) => {
    setLoadingDetails(true);
    setSelectedBroker(null);
    setSelectedBuilding(null);
    setPriceStats(null);
    try {
      const details = await api.getObservation(msgId);
      setSelectedMsgDetails(details);
      
      // Resolve Broker if possible
      const brokerName = details.parsed?.broker_name || details.parsed?.profile_name || details.raw?.sender;
      const brokerPhone = details.parsed?.broker_phone;
      if (brokerName || brokerPhone) {
        loadBrokerDetails(brokerName, brokerPhone);
      }

      // Resolve Building if possible
      const buildingName = details.resolver?.building_name || details.parsed?.building_name;
      if (buildingName) {
        loadBuildingDetails(buildingName);
      }

      // Load Price Stats if price, bhk, and market are present
      const price = details.parsed?.price;
      const bhk = details.parsed?.bhk;
      const market = details.parsed?.micro_market;
      const intent = details.parsed?.intent?.toLowerCase() === "rent" ? "rental" : "listing";
      if (price && bhk && market) {
        loadPriceStats(market, bhk, intent);
      }

    } catch (e) {
      console.error("Failed to load message details:", e);
    } finally {
      setLoadingDetails(false);
    }
  };

  const loadBrokerDetails = async (name: string, phone: string) => {
    setLoadingBroker(true);
    try {
      const res = await api.findBroker(name, phone);
      if (res && res.broker_id) {
        const brokerData = await api.getBroker(res.broker_id);
        setSelectedBroker(brokerData);
      }
    } catch (e) {
      console.log("No canonical broker profile found or failed to load:", e);
    } finally {
      setLoadingBroker(false);
    }
  };

  const loadBuildingDetails = async (name: string) => {
    setLoadingBuilding(true);
    try {
      const buildingData = await api.getBuildingProfile(name);
      setSelectedBuilding(buildingData);
    } catch (e) {
      console.log("Failed to load building profile:", e);
    } finally {
      setLoadingBuilding(false);
    }
  };

  const loadPriceStats = async (market: string, bhk: string, intent: string) => {
    setLoadingPriceStats(true);
    try {
      const stats = await api.getPriceStats(market, bhk, intent);
      if (stats && !stats.error) {
        setPriceStats(stats);
      }
    } catch (e) {
      console.log("Failed to load price stats:", e);
    } finally {
      setLoadingPriceStats(false);
    }
  };

  // Act on merge/duplicate suggestions
  const handleApproveSuggestion = async (sugId: number) => {
    try {
      await api.actOnSuggestion(sugId, "approve");
      setActionMessage("Suggestion approved and successfully merged!");
      setTimeout(() => setActionMessage(null), 3000);
      
      // Reload feed, suggestions, and current details to reflect changes
      loadFeed();
      if (selectedMsg) {
        loadMessageDetails(selectedMsg.id);
      }
    } catch (e) {
      console.error("Failed to approve suggestion:", e);
      setActionMessage("Error approving suggestion.");
      setTimeout(() => setActionMessage(null), 3000);
    }
  };

  const handleRejectSuggestion = async (sugId: number) => {
    try {
      await api.actOnSuggestion(sugId, "reject", "User rejected from workspace");
      setActionMessage("Suggestion rejected and hidden.");
      setTimeout(() => setActionMessage(null), 3000);
      
      // Reload lists
      loadFeed();
      if (selectedMsg) {
        loadMessageDetails(selectedMsg.id);
      }
    } catch (e) {
      console.error("Failed to reject suggestion:", e);
    }
  };

  // Helper formatting functions
  const maskPhoneString = (phone: string) => {
    const digits = phone?.replace(/\D/g, "") || "";
    if (digits.length < 4) return phone || "—";
    return `••••••${digits.slice(-4)}`;
  };

  const getWaLink = (phone: string) => {
    const digits = phone?.replace(/\D/g, "");
    return digits ? `https://wa.me/${digits.startsWith("91") ? digits : "91" + digits}` : "#";
  };

  const toggleRevealPhone = (phone: string) => {
    setRevealedPhone(prev => ({ ...prev, [phone]: !prev[phone] }));
  };

  const formatCurrency = (val: number, unit?: string) => {
    if (!val) return "—";
    if (unit?.toLowerCase() === "cr" || val >= 10000000) {
      const crVal = val >= 10000000 ? val / 10000000 : val;
      return `₹${crVal.toFixed(2)} Cr`;
    }
    if (val >= 100000) {
      return `₹${(val / 100000).toFixed(1)} L`;
    }
    if (val >= 1000) {
      return `₹${(val / 1000).toFixed(0)} K`;
    }
    return `₹${val.toLocaleString("en-IN")}`;
  };

  // Check signals/warnings
  const getAISignals = () => {
    const signals: { type: "info" | "warning" | "alert"; title: string; desc: string; actionSug?: any }[] = [];
    if (!selectedMsgDetails) return signals;

    const parsed = selectedMsgDetails.parsed || {};
    const resolver = selectedMsgDetails.resolver || {};

    // 1. Missing building / Unresolved building
    if (parsed.building_name && (!resolver.building_name || resolver.method === "unresolved")) {
      signals.push({
        type: "warning",
        title: "Missing Building Mapping",
        desc: `Parser extracted building "${parsed.building_name}", but the resolver was unable to map it to a canonical building. Needs manual resolution.`
      });
    }

    // 2. Price deviation comparison
    if (parsed.price && priceStats) {
      const listingPrice = parsed.price;
      const median = priceStats.median;
      const p25 = priceStats.p25;
      
      if (median && listingPrice < median * 0.75) {
        const percentBelow = Math.round(((median - listingPrice) / median) * 100);
        signals.push({
          type: "alert",
          title: "Price Unusually Low",
          desc: `${formatCurrency(listingPrice)} is ${percentBelow}% lower than the market median (${formatCurrency(median)}) for a ${parsed.bhk || ""} in ${parsed.micro_market || ""}. Potential distress sale or parsing error.`
        });
      }
    }

    // 3. Broker Merge Suggestion
    if (selectedBroker) {
      const brokerMergeSug = allSuggestions.find(
        s => s.agent === "merge_broker" && s.status === "pending" && s.source_data.includes(String(selectedBroker.id))
      );
      if (brokerMergeSug) {
        signals.push({
          type: "info",
          title: "Duplicate Broker Merge Candidate",
          desc: `AI proposes merging this broker with another profile due to matching contacts/names: "${brokerMergeSug.title}"`,
          actionSug: brokerMergeSug
        });
      }
    }

    // 4. Listing Duplicate Suggestion
    if (selectedMsgDetails.listings && selectedMsgDetails.listings.length > 0) {
      const listingId = selectedMsgDetails.listings[0].id;
      const listingMergeSug = allSuggestions.find(
        s => s.agent === "duplicate_listing" && s.status === "pending" && s.source_data.includes(String(listingId))
      );
      if (listingMergeSug) {
        signals.push({
          type: "info",
          title: "Duplicate Listing Merge Candidate",
          desc: `AI proposes merging this listing with a near-identical post from the same broker: "${listingMergeSug.title}"`,
          actionSug: listingMergeSug
        });
      }
    }

    return signals;
  };

  const signals = getAISignals();

  return (
    <div className="flex flex-col h-[calc(100vh-80px)] border border-[rgba(255,255,255,0.06)] rounded-2xl overflow-hidden bg-[#090d12]">
      
      {actionMessage && (
        <div className="bg-[#1e293b] border-b border-[#3EE88A]/30 text-[#3EE88A] px-4 py-2 text-xs font-semibold text-center transition-all animate-pulse">
          🚀 {actionMessage}
        </div>
      )}

      {/* Main Layout Grid */}
      <div className="flex-1 flex overflow-hidden">
        
        {/* ================= LEFT PANEL: INBOX ================= */}
        <div className="w-80 border-r border-[rgba(255,255,255,0.06)] flex flex-col bg-[#0a0e14]">
          {/* Panel Search & Header */}
          <div className="p-4 border-b border-[rgba(255,255,255,0.06)] space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold tracking-wider text-[#e2e8f0] uppercase">Inbox Feed</span>
              <button 
                onClick={loadFeed} 
                className="text-xs text-[#3EE88A] hover:underline"
                disabled={loadingLeft}
              >
                {loadingLeft ? "Refreshing..." : "Refresh"}
              </button>
            </div>
            
            <input
              type="text"
              placeholder="Search chat or message..."
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="w-full px-3 py-1.5 bg-[#0d1117] border border-[rgba(255,255,255,0.1)] rounded-lg text-xs text-[#e2e8f0] focus:border-[#3EE88A] focus:outline-none transition-colors"
            />

            {/* Filter Toggle Buttons */}
            <div className="grid grid-cols-3 gap-1 bg-[#0d1117] p-0.5 rounded-lg border border-[rgba(255,255,255,0.03)]">
              {(["all", "groups", "direct"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`py-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-colors ${
                    viewMode === mode
                      ? "bg-[#111820] text-[#3EE88A] shadow-sm"
                      : "text-[#64748b] hover:text-white"
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          {/* List Content */}
          <div className="flex-1 overflow-y-auto divide-y divide-[rgba(255,255,255,0.04)]">
            {loadingLeft && messages.length === 0 ? (
              <div className="p-8 text-center text-xs text-[#64748b]">Loading inbox feed...</div>
            ) : filteredMessages.length === 0 ? (
              <div className="p-8 text-center text-xs text-[#64748b]">No chats found</div>
            ) : (
              <>
                {/* 1. All Chronological Feed */}
                {viewMode === "all" &&
                  filteredMessages.map((m) => {
                    const isSelected = selectedMsg?.id === m.id;
                    const intentColor =
                      ({ SELL: "green", BUY: "purple", RENT: "yellow" } as Record<string, string>)[m.message_type?.toUpperCase()] || "blue";
                    return (
                      <button
                        key={m.id}
                        onClick={() => selectConversation(m)}
                        className={`w-full text-left p-3.5 transition-colors flex flex-col gap-1.5 select-none ${
                          isSelected ? "bg-blue-600/10 border-l-2 border-[#3b82f6]" : "hover:bg-[rgba(255,255,255,0.02)]"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] text-[#64748b] font-mono">#{m.id}</span>
                          <span className="text-[10px] text-[#64748b]">
                            {new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                        <div className="text-xs font-semibold text-[#f0f6fc] truncate">
                          {m.group_name && m.group_name !== "seed" ? `👥 ${m.group_name}` : `👤 ${m.sender}`}
                        </div>
                        <div className="text-[11px] text-[#94a3b8] line-clamp-2 leading-relaxed">
                          {m.message}
                        </div>
                        {m.message_type && (
                          <div className="flex mt-1">
                            <span className={`badge badge-${intentColor} text-[9px] px-1.5 py-0.5`}>
                              {m.message_type}
                            </span>
                          </div>
                        )}
                      </button>
                    );
                  })}

                {/* 2. Group Chats View */}
                {viewMode === "groups" &&
                  groupChats.map((g) => {
                    const isSelected = selectedMsg?.group_name === g.name;
                    return (
                      <button
                        key={g.name}
                        onClick={() => selectConversation(g.latest)}
                        className={`w-full text-left p-3.5 transition-colors flex flex-col gap-1 select-none ${
                          isSelected ? "bg-blue-600/10 border-l-2 border-[#3b82f6]" : "hover:bg-[rgba(255,255,255,0.02)]"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-bold text-[#e2e8f0] truncate max-w-[180px]">
                            👥 {g.name}
                          </span>
                          <span className="text-[9px] bg-[#111820] text-[#64748b] px-1.5 py-0.5 rounded-full">
                            {g.count} msg
                          </span>
                        </div>
                        <div className="text-[10px] text-[#64748b] truncate mt-1">
                          Last: {g.latest.sender}
                        </div>
                        <div className="text-[11px] text-[#94a3b8] line-clamp-1 italic">
                          &quot;{g.latest.message}&quot;
                        </div>
                      </button>
                    );
                  })}

                {/* 3. Direct Chats View */}
                {viewMode === "direct" &&
                  directChats.map((d) => {
                    const isSelected = selectedMsg?.sender === d.name || selectedMsg?.sender_phone === d.senderKey;
                    return (
                      <button
                        key={d.senderKey}
                        onClick={() => selectConversation(d.latest)}
                        className={`w-full text-left p-3.5 transition-colors flex flex-col gap-1 select-none ${
                          isSelected ? "bg-blue-600/10 border-l-2 border-[#3b82f6]" : "hover:bg-[rgba(255,255,255,0.02)]"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-bold text-[#e2e8f0] truncate max-w-[180px]">
                            👤 {d.name}
                          </span>
                          <span className="text-[9px] bg-[#111820] text-[#64748b] px-1.5 py-0.5 rounded-full">
                            {d.count} msg
                          </span>
                        </div>
                        {d.latest.sender_phone && (
                          <div className="text-[9px] text-[#64748b] font-mono">
                            {maskPhoneString(d.latest.sender_phone)}
                          </div>
                        )}
                        <div className="text-[11px] text-[#94a3b8] line-clamp-1 italic mt-1">
                          &quot;{d.latest.message}&quot;
                        </div>
                      </button>
                    );
                  })}
              </>
            )}
          </div>
          
          {/* Left panel footer / Pagination */}
          <div className="p-3 border-t border-[rgba(255,255,255,0.06)] flex items-center justify-between bg-[#0a0e14]">
            <button
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
              className="px-2 py-1 text-[10px] font-bold bg-[#111820] text-[#94a3b8] border border-[rgba(255,255,255,0.06)] rounded disabled:opacity-30"
            >
              Prev
            </button>
            <span className="text-[10px] text-[#64748b]">
              Showing {offset + 1}–{offset + messages.length}
            </span>
            <button
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={messages.length < PAGE_SIZE}
              className="px-2 py-1 text-[10px] font-bold bg-[#111820] text-[#94a3b8] border border-[rgba(255,255,255,0.06)] rounded disabled:opacity-30"
            >
              Next
            </button>
          </div>
        </div>

        {/* ================= CENTER PANEL: CONVERSATION ================= */}
        <div className="flex-1 flex flex-col bg-[#070b0e] overflow-hidden">
          {selectedMsg ? (
            <>
              {/* Chat Thread Header */}
              <div className="px-6 py-4 border-b border-[rgba(255,255,255,0.06)] flex items-center justify-between bg-[#0a0e14]">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-blue-600/20 text-[#3b82f6] flex items-center justify-center font-bold text-sm shadow-inner">
                    {selectedMsg.group_name && selectedMsg.group_name !== "seed" ? "👥" : "👤"}
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-[#e2e8f0]">
                      {selectedMsg.group_name && selectedMsg.group_name !== "seed"
                        ? selectedMsg.group_name
                        : selectedMsg.sender}
                    </h3>
                    <div className="text-[10px] text-[#64748b] flex items-center gap-2 mt-0.5">
                      <span>Sender: {selectedMsg.sender}</span>
                      {selectedMsg.sender_phone && (
                        <>
                          <span>•</span>
                          <span className="font-mono">{maskPhoneString(selectedMsg.sender_phone)}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex gap-2">
                  {selectedMsg.sender_phone && (
                    <a
                      href={getWaLink(selectedMsg.sender_phone)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-2.5 py-1 bg-[#166534] text-green-100 hover:bg-[#15803d] rounded text-[10px] font-bold uppercase tracking-wider transition-colors"
                    >
                      Connect WhatsApp
                    </a>
                  )}
                  {selectedBroker && (
                    <button
                      onClick={() => setActiveRightTab("broker")}
                      className="px-2.5 py-1 bg-[#1e293b] text-[#cbd5e1] hover:text-white rounded text-[10px] font-bold uppercase tracking-wider transition-colors"
                    >
                      View Broker Graph
                    </button>
                  )}
                </div>
              </div>

              {/* Chat Thread Message Area */}
              <div className="flex-1 overflow-y-auto p-6 space-y-4">
                {loadingConv ? (
                  <div className="h-full flex items-center justify-center text-xs text-[#64748b]">
                    Loading message thread...
                  </div>
                ) : (
                  <>
                    {conversationMessages.map((m) => {
                      const isMainMsg = m.id === selectedMsg.id;
                      // Outgoing check or seed parser bot check
                      const isSelf = m.sender === "seed-bot" || m.sender === "system" || m.sender === "owner";
                      const bubbleBg = isMainMsg
                        ? "bg-[#1d4ed8]/30 border border-[#3b82f6]"
                        : isSelf
                        ? "bg-emerald-950/40 border border-emerald-800/30 ml-auto"
                        : "bg-[#0d1117] border border-[rgba(255,255,255,0.06)]";
                      
                      const intentBadgeColor =
                        ({ SELL: "green", BUY: "purple", RENT: "yellow" } as Record<string, string>)[m.message_type?.toUpperCase()] || "blue";

                      return (
                        <div
                          key={m.id}
                          className={`max-w-[70%] rounded-2xl p-4 space-y-2 relative transition-all group ${
                            isSelf ? "text-right ml-auto" : ""
                          } ${bubbleBg}`}
                        >
                          <div className={`flex items-center gap-2 text-[10px] text-[#64748b] ${
                            isSelf ? "justify-end" : "justify-between"
                          }`}>
                            <span className="font-semibold text-[#cbd5e1]">{m.sender}</span>
                            <span>
                              {new Date(m.timestamp).toLocaleDateString([], {
                                day: "numeric",
                                month: "short",
                              })}{" "}
                              {new Date(m.timestamp).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                          </div>
                          <div className="text-xs text-[#e2e8f0] whitespace-pre-wrap leading-relaxed text-left">
                            {m.message}
                          </div>
                          
                          <div className="flex items-center justify-between pt-1 border-t border-[rgba(255,255,255,0.04)]">
                            <div>
                              {m.message_type && (
                                <span className={`badge badge-${intentBadgeColor} text-[8px] px-1 py-0`}>
                                  {m.message_type}
                                </span>
                              )}
                            </div>
                            
                            <button
                              onClick={() => {
                                setSelectedMsg(m);
                                loadMessageDetails(m.id);
                              }}
                              className="text-[9px] text-[#3EE88A] hover:underline opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                              Analyze details →
                            </button>
                          </div>

                          {isMainMsg && (
                            <span className="absolute -top-1.5 -left-1.5 flex h-3 w-3">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                              <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500"></span>
                            </span>
                          )}
                        </div>
                      );
                    })}
                    <div ref={threadEndRef} />
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-[#64748b] space-y-2">
              <span className="text-4xl">💬</span>
              <h3 className="text-sm font-semibold text-[#cbd5e1]">No conversation selected</h3>
              <p className="text-xs max-w-xs">
                Select any incoming message or group chat from the left panel to open the broker workspace.
              </p>
            </div>
          )}
        </div>

        {/* ================= RIGHT PANEL: INTELLIGENCE PANEL ================= */}
        <div className="w-96 border-l border-[rgba(255,255,255,0.06)] flex flex-col bg-[#0a0e14] overflow-hidden">
          {/* Tab Switcher */}
          <div className="flex border-b border-[rgba(255,255,255,0.06)] bg-[#070b0e]">
            {(["analysis", "broker", "building"] as const).map((tab) => {
              const label = { analysis: "🎯 Analysis", broker: "🤝 Broker", building: "🏢 Building" }[tab];
              return (
                <button
                  key={tab}
                  onClick={() => setActiveRightTab(tab)}
                  className={`flex-1 py-3 text-xs font-bold text-center border-b-2 transition-colors ${
                    activeRightTab === tab
                      ? "border-[#3EE88A] text-[#3EE88A] bg-[#0a0e14]/50"
                      : "border-transparent text-[#64748b] hover:text-white"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* Details Scroll Area */}
          <div className="flex-1 overflow-y-auto p-4 space-y-5">
            {loadingDetails ? (
              <div className="h-full flex items-center justify-center text-xs text-[#64748b]">
                Updating workspace intelligence...
              </div>
            ) : !selectedMsgDetails ? (
              <div className="h-full flex items-center justify-center text-xs text-[#64748b] text-center p-6">
                Select a message to view structured PropAI knowledge graph insights.
              </div>
            ) : (
              <>
                {/* ================= TAB 1: MESSAGE ANALYSIS ================= */}
                {activeRightTab === "analysis" && (
                  <div className="space-y-4 animate-fadeIn">
                    
                    {/* AI Signals & Alerts Section */}
                    {signals.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-[10px] font-bold text-[#64748b] uppercase tracking-wider">
                          AI Signals & Notifications
                        </div>
                        {signals.map((s, idx) => {
                          const bg = s.type === "alert" ? "bg-red-950/20 border-red-500/30 text-red-200" : s.type === "warning" ? "bg-amber-950/20 border-amber-500/30 text-amber-200" : "bg-blue-950/20 border-blue-500/30 text-blue-200";
                          return (
                            <div key={idx} className={`p-3 rounded-xl border text-xs leading-relaxed space-y-2 ${bg}`}>
                              <div className="font-bold flex items-center gap-1.5">
                                {s.type === "alert" ? "🚨" : s.type === "warning" ? "⚠️" : "💡"} {s.title}
                              </div>
                              <p className="text-[11px] text-[#94a3b8]">{s.desc}</p>
                              
                              {/* Merge suggestion action trigger */}
                              {s.actionSug && (
                                <div className="flex gap-2 pt-1">
                                  <button
                                    onClick={() => handleApproveSuggestion(s.actionSug.id)}
                                    className="px-2 py-1 bg-[#166534] text-green-100 hover:bg-[#15803d] rounded text-[10px] font-bold"
                                  >
                                    Approve Merge
                                  </button>
                                  <button
                                    onClick={() => handleRejectSuggestion(s.actionSug.id)}
                                    className="px-2 py-1 bg-red-950/40 text-red-200 border border-red-800/40 rounded text-[10px] font-bold"
                                  >
                                    Reject
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Raw Text Card */}
                    <div className="bg-[#0d1117] rounded-xl p-3.5 border border-[rgba(255,255,255,0.04)] space-y-1.5">
                      <div className="flex justify-between items-center text-[10px] text-[#64748b] uppercase tracking-wider font-bold">
                        <span>Original text</span>
                        <button
                          onClick={() => navigator.clipboard.writeText(selectedMsgDetails.raw?.message || "")}
                          className="hover:text-white"
                        >
                          Copy
                        </button>
                      </div>
                      <p className="text-xs text-[#cbd5e1] whitespace-pre-wrap leading-relaxed">
                        {selectedMsgDetails.raw?.message}
                      </p>
                    </div>

                    {/* Parsed Output Panel */}
                    <div className="bg-[#0d1117] rounded-xl p-3.5 border border-[rgba(255,255,255,0.04)] space-y-3">
                      <div className="text-[10px] text-[#64748b] uppercase tracking-wider font-bold">
                        Structured Extraction
                      </div>
                      
                      {selectedMsgDetails.parsed && Object.keys(selectedMsgDetails.parsed).length > 0 ? (
                        <div className="grid grid-cols-2 gap-3 text-xs">
                          <div>
                            <span className="text-[10px] text-[#64748b] block uppercase">Intent</span>
                            <span className="badge badge-blue font-bold mt-0.5">
                              {selectedMsgDetails.parsed.intent || "TEXT"}
                            </span>
                          </div>
                          <div>
                            <span className="text-[10px] text-[#64748b] block uppercase">BHK</span>
                            <span className="font-semibold text-white mt-0.5 block">
                              {selectedMsgDetails.parsed.bhk || "—"}
                            </span>
                          </div>
                          <div>
                            <span className="text-[10px] text-[#64748b] block uppercase">Price</span>
                            <span className="font-bold text-[#3EE88A] mt-0.5 block">
                              {formatCurrency(selectedMsgDetails.parsed.price, selectedMsgDetails.parsed.price_unit)}
                            </span>
                          </div>
                          <div>
                            <span className="text-[10px] text-[#64748b] block uppercase">Area</span>
                            <span className="font-semibold text-white mt-0.5 block">
                              {selectedMsgDetails.parsed.area_sqft ? `${selectedMsgDetails.parsed.area_sqft} sqft` : "—"}
                            </span>
                          </div>
                          <div className="col-span-2">
                            <span className="text-[10px] text-[#64748b] block uppercase">Extracted Location</span>
                            <span className="text-white mt-0.5 block leading-normal">
                              {selectedMsgDetails.parsed.location_raw || "—"}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <div className="text-xs text-[#64748b] italic py-2">No structured data parsed.</div>
                      )}
                    </div>

                    {/* Resolver Decisions Panel */}
                    <div className="bg-[#0d1117] rounded-xl p-3.5 border border-[rgba(255,255,255,0.04)] space-y-3">
                      <div className="text-[10px] text-[#64748b] uppercase tracking-wider font-bold">
                        Location Resolver Decision
                      </div>

                      {selectedMsgDetails.resolver ? (
                        <div className="space-y-2.5 text-xs">
                          <div className="flex justify-between items-center">
                            <span className="text-[#64748b]">Status</span>
                            <span className={`badge ${
                              selectedMsgDetails.resolver.method === "resolved" ? "badge-green" : "badge-yellow"
                            } font-bold`}>
                              {selectedMsgDetails.resolver.method?.toUpperCase()}
                            </span>
                          </div>
                          <div>
                            <span className="text-[10px] text-[#64748b] block uppercase">Canonical Building</span>
                            <span className="font-bold text-white block mt-0.5">
                              {selectedMsgDetails.resolver.building_name || "—"}
                            </span>
                          </div>
                          <div>
                            <span className="text-[10px] text-[#64748b] block uppercase">Confidence Level</span>
                            <div className="flex items-center gap-2 mt-1">
                              <div className="flex-1 h-2 bg-[rgba(255,255,255,0.06)] rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-blue-500 rounded-full"
                                  style={{ width: `${Math.round((selectedMsgDetails.resolver.final_confidence || 0) * 100)}%` }}
                                />
                              </div>
                              <span className="font-mono text-[10px] text-[#cbd5e1] font-bold">
                                {Math.round((selectedMsgDetails.resolver.final_confidence || 0) * 100)}%
                              </span>
                            </div>
                          </div>
                          {selectedMsgDetails.resolver.method_detail && (
                            <div>
                              <span className="text-[10px] text-[#64748b] block uppercase">Resolution Logic</span>
                              <span className="text-[#cbd5e1] block mt-0.5 leading-relaxed text-[11px]">
                                {selectedMsgDetails.resolver.method_detail}
                              </span>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="text-xs text-[#64748b] italic py-2">No resolution details recorded.</div>
                      )}
                    </div>

                    {/* Price Stats Comparison Widget */}
                    {priceStats && selectedMsgDetails.parsed?.price && (
                      <div className="bg-[#0d1117] rounded-xl p-3.5 border border-[rgba(255,255,255,0.04)] space-y-3">
                        <div className="text-[10px] text-[#64748b] uppercase tracking-wider font-bold">
                          Market Price Benchmarking
                        </div>
                        <div className="space-y-2 text-xs">
                          <div className="text-[11px] text-[#94a3b8] font-bold">
                            {selectedMsgDetails.parsed.bhk} in {selectedMsgDetails.parsed.micro_market}
                          </div>
                          <div className="flex justify-between text-[11px] border-b border-[rgba(255,255,255,0.04)] pb-1.5">
                            <span className="text-[#64748b]">Listing Price:</span>
                            <span className="font-bold text-[#3EE88A]">{formatCurrency(selectedMsgDetails.parsed.price)}</span>
                          </div>
                          <div className="flex justify-between text-[11px]">
                            <span className="text-[#64748b]">Market Median:</span>
                            <span className="font-semibold text-white">{formatCurrency(priceStats.median)}</span>
                          </div>
                          <div className="flex justify-between text-[11px]">
                            <span className="text-[#64748b]">25th Percentile (p25):</span>
                            <span className="text-[#cbd5e1]">{formatCurrency(priceStats.p25)}</span>
                          </div>
                          <div className="flex justify-between text-[11px]">
                            <span className="text-[#64748b]">75th Percentile (p75):</span>
                            <span className="text-[#cbd5e1]">{formatCurrency(priceStats.p75)}</span>
                          </div>
                          <div className="text-[10px] text-[#64748b] pt-1.5 italic text-center">
                            Based on {priceStats.count} parsed observation listings in the database
                          </div>
                        </div>
                      </div>
                    )}

                  </div>
                )}

                {/* ================= TAB 2: BROKER PROFILE ================= */}
                {activeRightTab === "broker" && (
                  <div className="space-y-4 animate-fadeIn">
                    {loadingBroker ? (
                      <div className="text-center text-xs text-[#64748b] py-8">Resolving broker graph profile...</div>
                    ) : !selectedBroker ? (
                      <div className="text-center text-xs text-[#64748b] py-8">
                        No canonical broker record resolved for this contact.
                      </div>
                    ) : (
                      <div className="space-y-4 text-xs">
                        
                        {/* Broker Basic Info */}
                        <div className="bg-[#0d1117] rounded-xl p-4 border border-[rgba(255,255,255,0.04)] flex flex-col gap-2">
                          <h4 className="text-sm font-bold text-white">{selectedBroker.name}</h4>
                          
                          <div className="flex items-center justify-between text-[11px] border-t border-[rgba(255,255,255,0.04)] pt-2.5">
                            <span className="text-[#64748b]">Primary Phone</span>
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-[#cbd5e1]">
                                {revealedPhone[selectedBroker.phone] ? selectedBroker.phone : maskPhoneString(selectedBroker.phone)}
                              </span>
                              <button
                                onClick={() => toggleRevealPhone(selectedBroker.phone)}
                                className="text-[9.5px] text-[#3b82f6] hover:underline"
                              >
                                {revealedPhone[selectedBroker.phone] ? "Hide" : "Reveal"}
                              </button>
                            </div>
                          </div>

                          {selectedBroker.first_seen_at && (
                            <div className="flex justify-between text-[11px]">
                              <span className="text-[#64748b]">First Observed</span>
                              <span className="text-[#cbd5e1]">
                                {new Date(selectedBroker.first_seen_at).toLocaleDateString("en-IN", {
                                  day: "numeric",
                                  month: "short",
                                  year: "numeric"
                                })}
                              </span>
                            </div>
                          )}

                          {selectedBroker.last_seen_at && (
                            <div className="flex justify-between text-[11px]">
                              <span className="text-[#64748b]">Last Activity</span>
                              <span className="text-[#cbd5e1]">
                                {new Date(selectedBroker.last_seen_at).toLocaleDateString("en-IN", {
                                  day: "numeric",
                                  month: "short",
                                  year: "numeric"
                                })}
                              </span>
                            </div>
                          )}

                          {selectedBroker.phone && (
                            <div className="pt-2">
                              <a
                                href={getWaLink(selectedBroker.phone)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="w-full py-1.5 bg-[#166534] hover:bg-[#15803d] text-green-100 rounded text-[10px] font-bold uppercase tracking-wider text-center block transition-colors"
                              >
                                WhatsApp Chat Link
                              </a>
                            </div>
                          )}
                        </div>

                        {/* Stats Grid */}
                        <div className="grid grid-cols-2 gap-2 text-center">
                          {[
                            { label: "Total Posts", value: selectedBroker.observation_count },
                            { label: "Listings", value: selectedBroker.listing_count },
                            { label: "Requirements", value: selectedBroker.requirement_count },
                            { label: "Avg Ticket", value: selectedBroker.avg_ticket ? formatCurrency(selectedBroker.avg_ticket) : "—" },
                          ].map((stat) => (
                            <div key={stat.label} className="bg-[#0d1117] rounded-xl p-2.5 border border-[rgba(255,255,255,0.04)]">
                              <div className="text-sm font-bold text-white">{stat.value}</div>
                              <div className="text-[9px] text-[#64748b] uppercase mt-0.5">{stat.label}</div>
                            </div>
                          ))}
                        </div>

                        {/* Aliases */}
                        {selectedBroker.aliases?.length > 0 && (
                          <div className="bg-[#0d1117] rounded-xl p-3.5 border border-[rgba(255,255,255,0.04)] space-y-2">
                            <div className="text-[10px] text-[#64748b] uppercase tracking-wider font-bold">
                              Known Aliases
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {selectedBroker.aliases.map((a: any, idx: number) => (
                                <span key={idx} className="bg-[#111820] px-2 py-0.5 rounded text-[10px] text-[#cbd5e1] border border-[rgba(255,255,255,0.03)]">
                                  {a.alias}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Top Micro-Markets */}
                        {selectedBroker.markets?.length > 0 && (
                          <div className="bg-[#0d1117] rounded-xl p-3.5 border border-[rgba(255,255,255,0.04)] space-y-2">
                            <div className="text-[10px] text-[#64748b] uppercase tracking-wider font-bold">
                              Core Micro Markets
                            </div>
                            <div className="space-y-1.5">
                              {selectedBroker.markets.slice(0, 3).map((m: any, idx: number) => (
                                <div key={idx} className="flex justify-between items-center">
                                  <span className="font-semibold text-[#cbd5e1]">{m.micro_market}</span>
                                  <span className="text-[10px] text-[#64748b]">
                                    {m.listing_count} listings · {m.requirement_count} reqs
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Top Buildings */}
                        {selectedBroker.buildings?.length > 0 && (
                          <div className="bg-[#0d1117] rounded-xl p-3.5 border border-[rgba(255,255,255,0.04)] space-y-2">
                            <div className="text-[10px] text-[#64748b] uppercase tracking-wider font-bold">
                              Frequent Buildings
                            </div>
                            <div className="space-y-1.5">
                              {selectedBroker.buildings.slice(0, 3).map((b: any, idx: number) => (
                                <div key={idx} className="flex justify-between items-center">
                                  <span className="font-semibold text-[#cbd5e1]">{b.building_name}</span>
                                  <span className="text-[10px] text-[#64748b]">
                                    {b.listing_count} listings · {b.requirement_count} reqs
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                      </div>
                    )}
                  </div>
                )}

                {/* ================= TAB 3: BUILDING PROFILE ================= */}
                {activeRightTab === "building" && (
                  <div className="space-y-4 animate-fadeIn">
                    {loadingBuilding ? (
                      <div className="text-center text-xs text-[#64748b] py-8">Resolving building metrics...</div>
                    ) : !selectedBuilding ? (
                      <div className="text-center text-xs text-[#64748b] py-8">
                        No canonical building profile resolved for this message.
                      </div>
                    ) : (
                      <div className="space-y-4 text-xs">
                        
                        {/* Building basic info */}
                        <div className="bg-[#0d1117] rounded-xl p-4 border border-[rgba(255,255,255,0.04)] flex flex-col gap-2">
                          <h4 className="text-sm font-bold text-white">{selectedBuilding.name}</h4>
                          
                          <div className="flex justify-between text-[11px] border-t border-[rgba(255,255,255,0.04)] pt-2.5">
                            <span className="text-[#64748b]">Database Observations</span>
                            <span className="font-mono text-[#cbd5e1] font-bold">{selectedBuilding.observation_count}</span>
                          </div>

                          <div className="flex justify-between text-[11px]">
                            <span className="text-[#64748b]">Active Brokers</span>
                            <span className="font-mono text-[#cbd5e1] font-bold">{selectedBuilding.broker_count}</span>
                          </div>

                          {selectedBuilding.markets?.length > 0 && (
                            <div className="flex justify-between text-[11px]">
                              <span className="text-[#64748b]">Micro Market</span>
                              <span className="text-white font-semibold">{selectedBuilding.markets[0].micro_market}</span>
                            </div>
                          )}
                        </div>

                        {/* Co-occurring landmarks */}
                        {selectedBuilding.landmarks?.length > 0 && (
                          <div className="bg-[#0d1117] rounded-xl p-3.5 border border-[rgba(255,255,255,0.04)] space-y-2">
                            <div className="text-[10px] text-[#64748b] uppercase tracking-wider font-bold">
                              Nearby Landmarks
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {selectedBuilding.landmarks.map((l: any, idx: number) => (
                                <span key={idx} className="bg-[#111820] px-2 py-0.5 rounded text-[10px] text-[#cbd5e1] border border-[rgba(255,255,255,0.03)]">
                                  {l.landmark_name}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Building Price Statistics */}
                        {selectedBuilding.price_stats?.length > 0 && (
                          <div className="bg-[#0d1117] rounded-xl p-3.5 border border-[rgba(255,255,255,0.04)] space-y-2">
                            <div className="text-[10px] text-[#64748b] uppercase tracking-wider font-bold">
                              Building Price Benchmarks
                            </div>
                            <div className="space-y-2">
                              {selectedBuilding.price_stats.map((s: any, idx: number) => (
                                <div key={idx} className="border-b border-[rgba(255,255,255,0.04)] pb-2 last:border-b-0 last:pb-0">
                                  <div className="flex justify-between text-[11px] font-bold text-[#e2e8f0]">
                                    <span>{s.bhk} - {s.intent?.toUpperCase()}</span>
                                    <span className="text-[#3EE88A]">Avg: {formatCurrency(s.avg_price)}</span>
                                  </div>
                                  <div className="flex justify-between text-[9.5px] text-[#64748b] mt-0.5">
                                    <span>Range: {formatCurrency(s.min_price)} – {formatCurrency(s.max_price)}</span>
                                    <span>{s.sample_count} listings</span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Active brokers in building */}
                        {selectedBuilding.brokers?.length > 0 && (
                          <div className="bg-[#0d1117] rounded-xl p-3.5 border border-[rgba(255,255,255,0.04)] space-y-2">
                            <div className="text-[10px] text-[#64748b] uppercase tracking-wider font-bold">
                              Brokers active here
                            </div>
                            <div className="space-y-2 divide-y divide-[rgba(255,255,255,0.04)]">
                              {selectedBuilding.brokers.slice(0, 4).map((b: any, idx: number) => (
                                <div key={idx} className="flex justify-between items-center pt-2 first:pt-0">
                                  <div>
                                    <span className="font-semibold text-[#cbd5e1] block">{b.name}</span>
                                    <span className="text-[9px] text-[#64748b] font-mono">{maskPhoneString(b.phone)}</span>
                                  </div>
                                  <span className="text-[10.5px] text-[#94a3b8] font-bold">
                                    {b.observation_count} posts
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
