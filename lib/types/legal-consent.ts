export type LegalDocumentType = "tos" | "privacy";

export interface LegalDocument {
  id: string;
  type: LegalDocumentType;
  version: string;
  title: string;
  content: string;
  content_sha256: string;
  effective_at: number;
  changelog?: string;
}

export interface ConsentRecord {
  wallet: string;
  tos_version: string;
  tos_hash: string;
  tos_accepted_at: number;
  privacy_version: string;
  privacy_hash: string;
  privacy_accepted_at: number;
  accepted_at: number;
  signature?: string;
  user_agent?: string;
  ip_address?: string;
}

export interface ConsentStatus {
  wallet: string;
  accepted: boolean;
  pending_documents: LegalDocumentType[];
  current_versions: {
    tos: string;
    privacy: string;
  };
  consent: ConsentRecord | null;
}

export type ConsentSubmitInput = {
  wallet: string;
  tos_version: string;
  tos_hash: string;
  privacy_version: string;
  privacy_hash: string;
  signature?: string;
  user_agent?: string;
};
