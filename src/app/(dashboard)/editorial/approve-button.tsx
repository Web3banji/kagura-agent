"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ApproveButton({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function approve() {
    setBusy(true);
    try {
      await fetch("/api/agent/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
    } finally {
      setBusy(false);
      router.refresh();
    }
  }
  return (
    <button
      onClick={approve}
      disabled={busy}
      className="px-3 py-1.5 rounded-md bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs font-medium hover:bg-emerald-500/30 disabled:opacity-50"
      data-action="approve-publish"
    >
      {busy ? "Publishing…" : "Approve & Publish"}
    </button>
  );
}