"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type ProfilesResponse = {
  profiles: string[];
};

export default function ProfileSwitcher({ currentProfile }: { currentProfile: string }) {
  const router = useRouter();
  const [profiles, setProfiles] = useState<string[]>([currentProfile]);

  useEffect(() => {
    const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
    fetch(`${apiBase}/profiles/list`)
      .then((r) => r.json())
      .then((data: ProfilesResponse) => {
        if (data.profiles && data.profiles.length > 0) {
          setProfiles(data.profiles);
        }
      })
      .catch(() => {
        /* silently ignore — keep currentProfile */
      });
  }, []);

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const selected = e.target.value;
    router.push(`/?profileId=${encodeURIComponent(selected)}`);
  }

  if (profiles.length <= 1) {
    return (
      <span
        style={{
          fontSize: "0.74rem",
          letterSpacing: "0.06em",
          color: "var(--hk-muted)",
          textTransform: "uppercase"
        }}
      >
        {currentProfile}
      </span>
    );
  }

  return (
    <select
      value={currentProfile}
      onChange={handleChange}
      style={{
        background: "var(--hk-card)",
        border: "1px solid var(--hk-border)",
        color: "var(--hk-text)",
        borderRadius: "4px",
        padding: "2px 8px",
        fontSize: "0.74rem",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        cursor: "pointer"
      }}
    >
      {profiles.map((pid) => (
        <option key={pid} value={pid}>
          {pid}
        </option>
      ))}
    </select>
  );
}
