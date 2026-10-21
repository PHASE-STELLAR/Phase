"use client";

import React, { useState, useEffect } from "react";
import { getLegalCopy, type LegalCopyDictionary } from "@/lib/copy/legal-copy";
import type { LegalDocument } from "@/lib/types/legal-consent";

interface ConsentModalProps {
  isOpen: boolean;
  wallet: string;
  lang?: string;
  onAccepted?: () => void;
  onDeclined?: () => void;
}

export function ConsentModal({
  isOpen,
  wallet,
  lang = "en",
  onAccepted,
  onDeclined,
}: ConsentModalProps) {
  const [activeTab, setActiveTab] = useState<"tos" | "privacy">("tos");
  const [hasScrolledTos, setHasScrolledTos] = useState(false);
  const [hasScrolledPrivacy, setHasScrolledPrivacy] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<{
    tos?: LegalDocument;
    privacy?: LegalDocument;
  }>({});

  const copy: LegalCopyDictionary = getLegalCopy(lang);

  useEffect(() => {
    if (!isOpen) return;
    let isMounted = true;
    async function loadDocuments() {
      try {
        const res = await fetch(`/api/legal/documents?lang=${lang}`);
        if (res.ok) {
          const data = await res.json();
          if (isMounted && data.documents) {
            setDocuments(data.documents);
          }
        }
      } catch (e) {
        if (isMounted) setError(String(e));
      }
    }
    loadDocuments();
    return () => {
      isMounted = false;
    };
  }, [isOpen, lang]);

  if (!isOpen) return null;

  const currentDoc = activeTab === "tos" ? documents.tos : documents.privacy;

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const reachedBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 20;
    if (reachedBottom) {
      if (activeTab === "tos") setHasScrolledTos(true);
      else setHasScrolledPrivacy(true);
    }
  };

  const handleAccept = async () => {
    if (!agreed) {
      setError(copy.consentPendingError);
      return;
    }
    if (!documents.tos || !documents.privacy) {
      setError("Documents not loaded");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/legal/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet,
          tos_version: documents.tos.version,
          tos_hash: documents.tos.content_sha256,
          privacy_version: documents.privacy.version,
          privacy_hash: documents.privacy.content_sha256,
        }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Failed to record consent");
      }

      onAccepted?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 sm:p-6 overflow-y-auto">
      <div className="relative w-full max-w-2xl bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header - accommodates text expansion in ES */}
        <div className="p-6 border-b border-zinc-800">
          <h2 className="text-xl font-bold text-zinc-100 tracking-tight">
            {copy.modalTitle}
          </h2>
          <p className="mt-1 text-sm text-zinc-400">{copy.modalSubtitle}</p>

          {/* Document switcher tabs */}
          <div className="mt-4 flex gap-2 border-b border-zinc-800">
            <button
              type="button"
              onClick={() => setActiveTab("tos")}
              className={`pb-2 px-3 text-sm font-medium transition-colors border-b-2 ${
                activeTab === "tos"
                  ? "border-cyan-400 text-cyan-400"
                  : "border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {copy.tabsTos}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("privacy")}
              className={`pb-2 px-3 text-sm font-medium transition-colors border-b-2 ${
                activeTab === "privacy"
                  ? "border-cyan-400 text-cyan-400"
                  : "border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {copy.tabsPrivacy}
            </button>
          </div>

          {currentDoc && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              <span>
                {copy.versionLabel}: <code className="text-zinc-300">{currentDoc.version}</code>
              </span>
              <span>•</span>
              <span className="font-mono truncate max-w-xs" title={currentDoc.content_sha256}>
                SHA-256: {currentDoc.content_sha256.slice(0, 16)}...
              </span>
            </div>
          )}
        </div>

        {/* Scrollable text container */}
        <div
          onScroll={handleScroll}
          className="flex-1 p-6 overflow-y-auto space-y-4 text-sm text-zinc-300 leading-relaxed font-mono whitespace-pre-wrap bg-zinc-950/50"
        >
          {currentDoc?.content ?? "Loading agreement text..."}
        </div>

        {/* Footer controls */}
        <div className="p-6 border-t border-zinc-800 space-y-4 bg-zinc-900/90">
          {error && (
            <div className="p-3 bg-red-950/50 border border-red-800/80 rounded text-xs text-red-300">
              {error}
            </div>
          )}

          <label className="flex items-start gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-zinc-700 bg-zinc-800 text-cyan-500 focus:ring-cyan-400 focus:ring-offset-zinc-900"
            />
            <span className="text-xs text-zinc-300 leading-tight">
              {copy.acceptCheckbox}
            </span>
          </label>

          <div className="flex flex-col-reverse sm:flex-row justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onDeclined}
              disabled={loading}
              className="w-full sm:w-auto px-4 py-2 rounded-lg text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition"
            >
              {copy.rejectButton}
            </button>
            <button
              type="button"
              onClick={handleAccept}
              disabled={!agreed || loading}
              className={`w-full sm:w-auto px-5 py-2 rounded-lg text-xs font-semibold text-black transition ${
                agreed && !loading
                  ? "bg-cyan-400 hover:bg-cyan-300"
                  : "bg-zinc-700 text-zinc-500 cursor-not-allowed"
              }`}
            >
              {loading ? "Recording..." : copy.acceptButton}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
