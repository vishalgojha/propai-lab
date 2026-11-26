"use client";

import ActionGrid from "../../dashboard/ActionGrid";

export default function FixtureClient() {
  return (
    <main style={{ background: "#0b0f0e", minHeight: "100vh", padding: 24 }}>
      <ActionGrid suggestionPending={3} />
    </main>
  );
}
