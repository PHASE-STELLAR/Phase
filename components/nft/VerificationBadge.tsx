'use client';

import React from 'react';
import { CheckCircle2, ExternalLink } from 'lucide-react';

interface VerificationBadgeProps {
  verified: boolean;
  issuer?: string;
  collectionId?: number;
  className?: string;
}

export function VerificationBadge({
  verified,
  issuer,
  collectionId,
  className = '',
}: VerificationBadgeProps) {
  if (!verified) {
    return null;
  }

  const stellarExpertUrl = collectionId
    ? `https://stellar.expert/explorer/testnet/contract/${process.env.NEXT_PUBLIC_PHASE_PROTOCOL_ID}`
    : undefined;

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="flex items-center gap-1 px-3 py-1 rounded-full bg-green-500/20 border border-green-500/50 text-green-400">
        <CheckCircle2 size={16} className="flex-shrink-0" />
        <span className="text-xs font-medium">Verified Artist</span>
      </div>

      {stellarExpertUrl && (
        <a
          href={stellarExpertUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
          title="View on Stellar Expert"
        >
          <ExternalLink size={14} />
        </a>
      )}
    </div>
  );
}
