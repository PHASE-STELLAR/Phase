'use client';

import React from 'react';
import { ExternalLink } from 'lucide-react';

interface ExplorerLinksProps {
  collectionId?: number;
  tokenId?: number;
  className?: string;
}

export function ExplorerLinks({
  collectionId,
  tokenId,
  className = '',
}: ExplorerLinksProps) {
  const contractId = process.env.NEXT_PUBLIC_PHASE_PROTOCOL_ID || '';

  const explorers = [
    {
      name: 'Stellar Expert',
      url: `https://stellar.expert/explorer/testnet/contract/${contractId}`,
      icon: '🌟',
    },
    {
      name: 'Soroban Explorer',
      url: `https://stellar-viewer.app/contract/${contractId}`,
      icon: '🔍',
    },
  ];

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <p className="text-sm text-gray-400">View on explorers:</p>
      <div className="flex flex-wrap gap-2">
        {explorers.map((explorer) => (
          <a
            key={explorer.name}
            href={explorer.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-3 py-2 rounded border border-gray-600 hover:border-blue-400 text-gray-300 hover:text-blue-400 transition-colors text-sm"
            title={`View on ${explorer.name}`}
          >
            <span>{explorer.icon}</span>
            <span>{explorer.name}</span>
            <ExternalLink size={14} />
          </a>
        ))}
      </div>
    </div>
  );
}
