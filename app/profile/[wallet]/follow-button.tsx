"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useWallet } from "@/components/wallet-provider";
import type { FollowSuggestion } from "@/lib/follow-store";

type Props = {
  targetWallet: string;
};

export function FollowSuggestions({
  profileWallet,
}: {
  profileWallet: string;
}) {
  const { address } = useWallet();
  const [suggestions, setSuggestions] = useState<FollowSuggestion[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  // phase-138: per-request infra cost surfaced for treasury visibility
  const [costUnits, setCostUnits] = useState<number | null>(null);

  useEffect(() => {
    if (!address || address !== profileWallet) return;
    const controller = new AbortController();
    setIsSearching(true);

    const searchParam = searchQuery
      ? `&search=${encodeURIComponent(searchQuery)}`
      : "";
    fetch(
      `/api/profile/follow?mode=suggestions&wallet=${encodeURIComponent(address)}&limit=6${searchParam}`,
      {
        signal: controller.signal,
      },
    )
      .then(async (response): Promise<{
        suggestions?: FollowSuggestion[];
        costUnits?: number;
      }> => (response.ok ? response.json() : { suggestions: [] }))
      .then((data) => {
        setSuggestions(data.suggestions ?? []);
        setCostUnits(typeof data.costUnits === "number" ? data.costUnits : null);
        setIsSearching(false);
      })
      .catch(() => {
        setIsSearching(false);
      });
    return () => controller.abort();
  }, [address, profileWallet, searchQuery]);

  if (!address || address !== profileWallet) return null;

  return (
    <section aria-labelledby="follow-suggestions-title" className="space-y-3">
      <div className="flex items-baseline justify-between border-b border-violet-800/20 pb-1">
        <h2
          id="follow-suggestions-title"
          className="text-[9px] uppercase tracking-widest text-zinc-500"
        >
          PEOPLE_TO_FOLLOW
        </h2>
        <span className="text-[8px] text-zinc-600">
          {costUnits !== null ? `STELLAR GRAPH · ${costUnits}u` : "STELLAR GRAPH"}
        </span>
      </div>

      {/* Typo-tolerant search input */}
      <input
        type="text"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="Search users (typo-tolerant)"
        className="w-full bg-zinc-900/50 border border-violet-800/20 px-3 py-1.5 text-[10px] text-zinc-300 placeholder-zinc-600 focus:border-violet-500/40 focus:outline-none"
      />

      {isSearching && (
        <div className="text-center text-[9px] text-zinc-500 py-2">
          Searching...
        </div>
      )}

      {!isSearching && suggestions.length === 0 && searchQuery && (
        <div className="text-center text-[9px] text-zinc-500 py-2">
          No matches found
        </div>
      )}

      {!isSearching && suggestions.length > 0 && (
        <div className="divide-y divide-violet-800/20 border-y border-violet-800/20">
          {suggestions.map((suggestion) => (
            <Link
              key={suggestion.wallet}
              href={`/profile/${suggestion.wallet}`}
              className="flex items-center gap-3 py-2.5 text-[10px] transition-colors hover:text-violet-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-400"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-zinc-300">
                  {suggestion.displayName ??
                    `${suggestion.wallet.slice(0, 6)}…${suggestion.wallet.slice(-4)}`}
                </span>
                {suggestion.displayName && (
                  <span className="block truncate text-[8px] text-zinc-600">
                    {suggestion.wallet}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-[8px] text-zinc-500">
                {suggestion.mutualFollows > 0
                  ? `${suggestion.mutualFollows} mutual`
                  : `${suggestion.sharedAssets} shared assets`}
              </span>
              {suggestion.matchScore && suggestion.matchScore < 1 && (
                <span className="text-[7px] text-violet-400">
                  ~{Math.round(suggestion.matchScore * 100)}%
                </span>
              )}
              <span aria-hidden="true" className="text-violet-500">
                →
              </span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

export function FollowButton({ targetWallet }: Props) {
  const { address } = useWallet();
  const [following, setFollowing] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!address || address === targetWallet) return;
    fetch(
      `/api/profile/follow?wallet=${encodeURIComponent(targetWallet)}&viewer=${encodeURIComponent(address)}`,
    )
      .then((r) => r.json() as Promise<{ isFollowing?: boolean | null }>)
      .then((data) => setFollowing(data.isFollowing ?? false))
      .catch(() => {});
  }, [address, targetWallet]);

  if (!address || address === targetWallet) return null;

  async function toggle() {
    if (!address || busy) return;
    setBusy(true);
    setError(null);
    const action = following ? "unfollow" : "follow";
    try {
      const res = await fetch("/api/profile/follow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: address, to: targetWallet, action }),
      });
      if (res.ok) {
        setFollowing(!following);
      } else {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(data?.error ?? "Follow request failed");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={busy || following === null}
        onClick={() => void toggle()}
        className={`shrink-0 font-mono text-[10px] uppercase tracking-widest px-4 py-1.5 border transition-colors disabled:opacity-40 ${
          following
            ? "border-violet-700/40 text-violet-500 hover:border-red-500/40 hover:text-red-400"
            : "border-[#534AB7] bg-[#534AB7]/10 text-[#7F77DD] hover:bg-[#534AB7]/20"
        }`}
      >
        {following === null
          ? "···"
          : following
            ? "[ FOLLOWING ]"
            : "[ FOLLOW ]"}
      </button>
      {error && (
        <span className="max-w-48 text-right font-mono text-[9px] uppercase tracking-wider text-red-400">
          {error}
        </span>
      )}
    </span>
  );
}
