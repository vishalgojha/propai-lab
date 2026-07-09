"use client";

import React from "react";
import { Users, Activity, Phone, Shield, LayoutDashboard } from "lucide-react";
import Link from "next/link";

const WORKSPACE_CARDS = [
    {
        title: "Team Members",
        desc: "Manage team roles, members, and fine-grained permissions",
        icon: Users,
        color: "text-blue-400",
        bg: "bg-blue-400/10",
        link: "/workspace/members"
    },
    {
        title: "Activity Logs",
        desc: "Full audit trail of every action taken by your team",
        icon: Activity,
        color: "text-green-400",
        bg: "bg-green-400/10",
        link: "/workspace/activity"
    },
    {
        title: "WhatsApp Access",
        desc: "Control which team members can send messages from connected accounts",
        icon: Phone,
        color: "text-purple-400",
        bg: "bg-purple-400/10",
        link: "/workspace/whatsapp"
    },
    {
        title: "Permission Sets",
        desc: "Define and manage global permission roles for the workspace",
        icon: Shield,
        color: "text-orange-400",
        bg: "bg-orange-400/10",
        link: "#" // future
    },
];

export default function WorkspacePage() {
    return (
        <div className="p-8 max-w-6xl mx-auto">
            <div className="mb-12">
                <h1 className="text-3xl font-bold text-white mb-2">Workspace</h1>
                <p className="text-gray-400">Operating system for your brokerage team management</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                {WORKSPACE_CARDS.map(card => (
                    <Link key={card.title} href={card.link} className="group">
                        <div className="h-full p-6 bg-zinc-900 border border-white/10 rounded-2xl hover:border-blue-500/50 transition-all hover:-translate-y-1 shadow-sm">
                            <div className={`w-12 h-12 ${card.bg} ${card.color} rounded-xl flex items-center justify-center mb-4 group-hover:scale-110 transition-transform`}>
                                <card.icon size={24} />
                            </div>
                            <h3 className="text-white font-semibold mb-2">{card.title}</h3>
                            <p className="text-gray-500 text-xs leading-relaxed">
                                {card.desc}
                            </p>
                        </div>
                    </Link>
                ))}
            </div>

            <div className="mt-12 p-8 bg-gradient-to-br from-[#161b22] to-[#0d1117] border border-white/10 rounded-2xl">
                <div className="flex items-start gap-6">
                    <div className="w-12 h-12 bg-blue-600/20 text-blue-400 rounded-xl flex items-center justify-center shrink-0">
                        <LayoutDashboard size={24} />
                    </div>
                    <div>
                        <h3 className="text-lg font-bold text-white mb-2">Brokerage Dashboard (Coming Soon)</h3>
                        <p className="text-gray-400 text-sm max-w-2xl leading-relaxed">
                            Real-time analytics of your team's performance. Track message volume, requirement capture rates, and 
                            AI usage per member to optimize your operational efficiency.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
