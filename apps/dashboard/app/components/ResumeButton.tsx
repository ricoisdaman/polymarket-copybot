"use client";

import { useState } from "react";

type Props = {
  profileId: string;
  apiBaseUrl?: string;
};

export default function ResumeButton({ profileId, apiBaseUrl = "http://localhost:4000" }: Props) {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const handleResume = async () => {
    setLoading(true);
    try {
      await fetch(`${apiBaseUrl}/control/state?profileId=${encodeURIComponent(profileId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: false, reason: "Manual resume via dashboard" })
      });
      setDone(true);
      // Reload the page after a brief delay so the banner disappears
      setTimeout(() => window.location.reload(), 800);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleResume}
      disabled={loading || done}
      className="btn btn-sm"
      style={{
        fontSize: "0.72rem",
        background: done ? "#22c55e" : "#ff9500",
        color: "#000",
        border: "none",
        borderRadius: 3,
        fontWeight: 700,
        padding: "3px 12px",
        letterSpacing: "0.06em",
        minWidth: 72
      }}
    >
      {done ? "RESUMED ✓" : loading ? "…" : "RESUME"}
    </button>
  );
}
