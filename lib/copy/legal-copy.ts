/**
 * Legal domain localization strings for ToS and Privacy consent flows.
 *
 * Spanish (es) text is ~20% longer than English (en). Modal design and copy keys
 * must account for this expansion to avoid truncation, overflow, or broken layout.
 */

export interface LegalCopyDictionary {
  modalTitle: string;
  modalSubtitle: string;
  tabsTos: string;
  tabsPrivacy: string;
  versionLabel: string;
  effectiveDateLabel: string;
  checksumLabel: string;
  scrollNotice: string;
  acceptCheckbox: string;
  acceptButton: string;
  rejectButton: string;
  consentPendingError: string;
  consentSuccess: string;
  alreadyAccepted: string;
  closeLabel: string;
}

export const LEGAL_COPY: Record<"en" | "es", LegalCopyDictionary> = {
  en: {
    modalTitle: "Terms of Service & Privacy Policy",
    modalSubtitle: "Please review and accept our updated legal agreements to continue using PHASE.",
    tabsTos: "Terms of Service",
    tabsPrivacy: "Privacy Policy",
    versionLabel: "Version",
    effectiveDateLabel: "Effective",
    checksumLabel: "SHA-256 Digest",
    scrollNotice: "Scroll to review the complete agreement before accepting.",
    acceptCheckbox: "I have read and agree to the Terms of Service and Privacy Policy.",
    acceptButton: "Accept & Continue",
    rejectButton: "Decline",
    consentPendingError: "You must accept the updated agreements to proceed.",
    consentSuccess: "Agreements accepted successfully.",
    alreadyAccepted: "You have already accepted the current version of these agreements.",
    closeLabel: "Close",
  },
  es: {
    modalTitle: "Términos del Servicio y Política de Privacidad",
    modalSubtitle: "Por favor revise y acepte nuestros acuerdos legales actualizados para continuar usando PHASE.",
    tabsTos: "Términos del Servicio",
    tabsPrivacy: "Política de Privacidad",
    versionLabel: "Versión",
    effectiveDateLabel: "Fecha de vigencia",
    checksumLabel: "Compendio criptográfico SHA-256",
    scrollNotice: "Desplácese hacia abajo para revisar el acuerdo completo antes de manifestar su conformidad.",
    acceptCheckbox: "He leído y acepto los Términos del Servicio y la Política de Privacidad vigentes.",
    acceptButton: "Aceptar y Continuar",
    rejectButton: "Rechazar",
    consentPendingError: "Debe aceptar los acuerdos actualizados para poder continuar con la operación.",
    consentSuccess: "Acuerdos legales aceptados correctamente.",
    alreadyAccepted: "Ya ha aceptado la versión vigente de estos acuerdos legales.",
    closeLabel: "Cerrar",
  },
};

export function getLegalCopy(lang?: string): LegalCopyDictionary {
  if (lang && lang.toLowerCase().startsWith("es")) {
    return LEGAL_COPY.es;
  }
  return LEGAL_COPY.en;
}

/**
 * Calculates expansion ratio of translated copy against English baseline.
 * Used in tests and layout sizing verifications.
 */
export function calculateCopyExpansion(key: keyof LegalCopyDictionary): number {
  const enLen = LEGAL_COPY.en[key].length;
  const esLen = LEGAL_COPY.es[key].length;
  return (esLen - enLen) / enLen;
}
