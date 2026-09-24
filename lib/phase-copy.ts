import type { AppLang } from "@/components/lang-context"
import type { ImageUriValidationMessages } from "@/lib/phase-protocol"

function getNodeEnv(): string {
  if (typeof process === "undefined" || !process.env) return "production"
  return process.env.NODE_ENV ?? "production"
}

export type ChamberLogsCopy = {
  chamberOnline: string
  walletRequest: string
  walletLinkedPrefix: string
  walletDenied: string
  walletUnlink: string
  systemDesync: string
  tracePrefix: string
  runtimeFaultPrefix: string
  rebootProcess: string
  manualPhaseStart: string
  detectingLiquidity: string
  authorizingTx: string
  mintingNft: string
  crystallizing: string
  phaseTransitionComplete: string
  mintConfirmedViewPedestal: string
  lowEnergyWarning: string
  x402Initiating: string
  /** Antes del settle: se abre Stellar Wallets Kit para elegir la wallet que firma y recibe el NFT. */
  walletKitPickerForSettle: string
  /** Usuario cerró el modal del kit sin elegir wallet. */
  walletKitPickerDismissed: string
  receivingChallenge: string
  signingAuth: string
  settlingPayment: string
  decrypting: string
  x402Ok: string
  forgedOnSettle: string
  faucetEmitting: string
  faucetLoadingSupply: string
  faucetOk: string
  /** Toast / log tras mint; usa `{amount}` (ej. 10.00). */
  faucetReceived: string
  faucetFailPrefix: string
  genesisSupplyRequested: string
  genesisTransferComplete: string
  /** Narrativa: antes de abrir Freighter para changeTrust (recompensas LIQ). */
  classicTrustlineEstablishing: string
  classicTrustlineFreighter: string
  classicTrustlineConfirmed: string
  classicTrustlineRejected: string
  classicTrustlineAccountMissing: string
}

export type ArtifactLabelsCopy = {
  registeredDefault: string
  owner: string
  serial: string
  powerLevel: string
  readonly: string
  noVisual: string
  ariaLabel: string
  sepSuffix: string
  dataLocked: string
  contract: string
  terminalRestricted: string
  systemActive: string
  verifying: string
  downloadCertificate: string
  expandPreview: string
  closePreview: string
  unverifiedCopy: string
  /** `{token}` `{sig}` — sello en esquina si hay propiedad verificada. */
  authenticitySealVerified: string
  /** Línea bajo banner terminal bloqueada. */
  accessDeniedLine: string
  /** Subtítulo mientras `owner_of` / RPC aún no cerró (no es un “denied”). */
  verifyingHint: string
  /** Estado de metadato público (pre-fusión vs sellado on-chain). */
  stateLiquid: string
  stateSolid: string
  /** Acción solo para el dueño verificado. */
  accessPrivateMetadata: string
  /** Línea bajo el panel público cuando el canal privado está abierto. */
  privateChannelUnlocked: string
  /** Artefacto verificado: estándar de metadata (SEP-41/SEP-50). */
  metadataStandard: string
  /** Vista verificada pero wallet ≠ owner_of(token) — overlay + blur. */
  previewOnly: string
  /** Breve animación al confirmar titular on-chain. */
  decryptingImage: string
  monitorCollectionName: string
  monitorContractAddr: string
  supplyStabilized: string
  secretId: string
  holderSignature: string
  rawMetadata: string
  pendingOwnershipVerification: string
  /** Imagen remota no carga (CORS, gateway IPFS, URL caída). */
  imageLoadHint: string
  openImageUrl: string
  /** Cámara / preview: dirección del contrato de colección (copiar). */
  chamberPreviewCollectionAddress: string
  /** Cámara / preview: botón copiar valor. */
  chamberPreviewCopy: string
  /** Cámara / preview: fila Token ID (copiar entero para Freighter). */
  chamberPreviewTokenId: string
}

/** PhaseError 1..13; índice 0 sin usar. Misma lista para forja y cámara. */
const PHASE_HOST_CONTRACT_ERRORS_EN: readonly string[] = [
  "",
  "You already hold a PHASE for this collection (AlreadyPhased).",
  "Not enough PHASELQ on the Soroban token contract this app uses. Freighter may show classic PHASELQ while settle reads the SAC—use the faucet, wait for confirmation, or fund the same C… contract.",
  "Token transfer failed inside the protocol (TransferFailed). Retry or check SAC balance.",
  "Wrong token contract: PHASE expects its authorized PHASELQ SAC (UnauthorizedToken). Check NEXT_PUBLIC_PHASER_TOKEN_ID matches this deployment.",
  "This invoice was already settled or cannot be paid again (SettlementFailed). Start a new x402 flow.",
  "Invalid x402 invoice (InvalidInvoice).",
  "Unknown or invalid collection id (InvalidCollection).",
  "CreatorAlreadyHasCollection (reserved, no longer enforced by the contract).",
  "Amount is below this collection’s fusion price (AmountBelowCollectionPrice).",
  "Collection metadata breaks protocol rules—name, price, or image URI (InvalidCollectionMetadata).",
  "That PHASE NFT id does not exist (NftNotFound).",
  "You are not the on-chain owner of that NFT (NotNftOwner).",
  "Cannot transfer a PHASE NFT to yourself (SelfTransfer).",
]

const PHASE_HOST_CONTRACT_ERRORS_ES: readonly string[] = [
  "",
  "Ya tenés un PHASE para esta colección (AlreadyPhased).",
  "PHASELQ insuficiente en el contrato Soroban (SAC) que usa esta app. Freighter puede mostrar saldo clásico pero el settle lee el SAC—usá el faucet, esperá confirmación o fondeá el mismo contrato C….",
  "Falló una transferencia de token en el protocolo (TransferFailed). Reintentá o revisá saldo en el SAC.",
  "Contrato de token incorrecto: PHASE solo acepta el SAC PHASELQ autorizado (UnauthorizedToken). Verificá NEXT_PUBLIC_PHASER_TOKEN_ID con este despliegue.",
  "Esa factura ya se liquidó o no se puede pagar de nuevo (SettlementFailed). Iniciá un flujo x402 nuevo.",
  "Factura x402 inválida (InvalidInvoice).",
  "Id de colección inexistente o inválido (InvalidCollection).",
  "CreatorAlreadyHasCollection (reservado, ya no es aplicado por el contrato).",
  "El monto es menor que el precio de fusión de la colección (AmountBelowCollectionPrice).",
  "Los metadatos de la colección no cumplen las reglas del protocolo (InvalidCollectionMetadata).",
  "Ese id de NFT PHASE no existe (NftNotFound).",
  "No sos el dueño on-chain de ese NFT (NotNftOwner).",
  "No podés transferir un NFT PHASE a vos mismo (SelfTransfer).",
]

const PHASE_HOST_CONTRACT_UNKNOWN_EN =
  "PHASE contract host error #{code}. See contracts/phase-protocol (PhaseError) or the full host diagnostic."
const PHASE_HOST_CONTRACT_UNKNOWN_ES =
  "Error de host en contrato PHASE #{code}. Ver contracts/phase-protocol (PhaseError) o el diagnóstico completo del host."

export const phaseCopy: Record<
  AppLang,
  {
    nav: { home: string; market: string; forge: string; chamber: string; lang: string }
    dashboard: {
      title: string
      subtitle: string
      /** Mensaje “blindaje” vs pantallazo (poster sin llave on-chain). */
      shieldBlurb: string
      refresh: string
      refreshing: string
      wallet: string
      connect: string
      connecting: string
      disconnect: string
      empty: string
      noPreview: string
      creator: string
      mint: string
      openChamber: string
      id: string
      priceSuffix: string
      previewPendingFusion: string
      previewUnverifiedCopy: string
      previewChainVerified: string
      back: string
      myArtifactsSection: string
      platformListings: string
      sellNft: string
      sellModalTitle: string
      buyerAddressLabel: string
      buyerHint: string
      listingPriceLabel: string
      listingPublish: string
      listingHint: string
      transferNft: string
      transferBusy: string
      cancel: string
      close: string
      cancelListing: string
      listingLoadError: string
      transferWasmHint: string
      /** Bóveda PHASE: lista por RPC (owner_of), sin indexador de terceros. */
      vaultRpcTitle: string
      vaultRpcBlurb: string
      vaultRpcLoading: string
      vaultRpcEmpty: string
      vaultRpcError: string
    }
    studioModal: {
      windowTitle: string
      canvasMeta: string
      file: string
      edit: string
      view: string
      saveSeal: string
      newCanvas: string
      exitDiscard: string
      undo: string
      closePolygon: string
      zoomIn: string
      zoomOut: string
      zoom100: string
      refLine: string
      cancel: string
      clear: string
      seal: string
    }
    studioEditor: {
      tools: string
      pencil: string
      brush: string
      airbrush: string
      eraser: string
      bucket: string
      line: string
      rect: string
      ellipse: string
      polygon: string
      text: string
      select: string
      thickness: string
      paletteTitle: string
      hint: string
      textPlaceholder: string
    }
    imageValidation: ImageUriValidationMessages
    forge: {
      exit: string
      title: string
      oracleBadge: string
      market: string
      chamber: string
      intro: string
      anomalyLabel: string
      collectionName: string
      fusionPrice: string
      readout: string
      linkWallet: string
      linking: string
      walletLabel: string
      initiateAgent: string
      forgeCollection: string
      deploying: string
      disconnect: string
      artPreview: string
      lorePreview: string
      awaitingFeed: string
      oracleHint: string
      collectionLive: string
      magicLink: string
      copy: string
      copied: string
      openChamber: string
      collectionIdLabel: string
      registerTitle: string
      tabOracle: string
      tabManual: string
      /** `aria-label` del grupo de pestañas Oracle / Manual. */
      forgeTablistAria: string
      manualClearFile: string
      oracleStyleLabel: string
      oracleStyleAdaptive: string
      oracleStyleCyber: string
      manualBadge: string
      manualIntro: string
      manualDropLabel: string
      manualDropHint: string
      manualUrlLabel: string
      manualLoreLabel: string
      manualLorePlaceholder: string
      manualUploadMint: string
      manualAwaiting: string
      manualAwaitingHint: string
      /** Forja: abre popup con texto de `intro` / `manualIntro`. */
      protocolBriefButton: string
      protocolBriefTitleOracle: string
      protocolBriefTitleManual: string
      /** Forja: abre panel PHASELQ / quests en modal (columna compacta). */
      rewardsPanelButton: string
      rewardsPanelTitle: string
      rewardsPanelClose: string
      /** Forja: lore en popup (accesibilidad). */
      loreExpandHint: string
      /** Forja: colección creada — abre modal con enlace y acciones. */
      collectionLiveDetails: string
      /** Trustline: una frase para quien no sabe qué es PHASELQ ni dónde sacarlo. */
      trustline_beginner_blurb: string
      /** Trustline: `<details>` con issuer/código técnico. */
      trustline_technical_details_label: string
      /** Forja: CTA principal generar (Oráculo, idle). */
      forgeCtaGenerateIdle: string
      forgeCtaGenerateContacting: string
      forgeCtaGenerateArming: string
      forgeCtaGenerateSigning: string
      /** Forja: textos rotativos mientras la IA genera (botón + strip). */
      forgeAgentForgingTickers: readonly [string, string]
      /** Forja: tras imagen lista, mint en cadena. */
      forgeCtaMintArtifact: string
      /** Forja: título de bloque debajo del CTA (nombre, precio, etc.). */
      forgeSectionLaterOptions: string
      forgeNarrativeWorldTitle: string
      forgeNarrativeWorldName: string
      forgeNarrativeWorldNamePlaceholder: string
      forgeNarrativeWorldBackstory: string
      forgeOptionalShort: string
      /** Mini rail UX en /forge: paso 1 (Oráculo). */
      uxRailStepAOracle: string
      /** Mini rail UX en /forge: paso 1 (Manual). */
      uxRailStepAManual: string
      /** Mini rail UX en /forge: paso 2 (colección + precio + despliegue). */
      uxRailStepB: string
      deployStatus: string
      agentDeployStatus: string
      deployTickers: readonly [string, string, string, string, string]
      agentProcessTickers: readonly [string, string, string]
      signingPayment: string
      paywallNegotiating: string
      trustline_section_title: string
      trustline_standby: string
      trustline_signing: string
      trustline_syncing: string
      trustline_ready: string
      trustline_get_testnet_xlm: string
      trustline_msg_initialized: string
      trustline_msg_empty_account: string
      trustline_msg_connect_wallet: string
      trustline_msg_config_missing: string
      trustline_msg_waiting_confirmation: string
      trustline_msg_protocol_ready: string
      trustline_gas_label: string
      trustline_friendbot_link: string
      /** Subtítulo bajo el asset (qué hace este bloque). */
      trustline_asset_hint: string
      trustline_albedo_prep_title: string
      trustline_albedo_prep_body: string
      trustline_albedo_prep_button: string
      trustline_albedo_prep_working: string
      oracle_blocked_msg: string
      mint_blocked_msg: string
      ipfsOracleHint: string
      /** Forge payment gate: CTA label when agent is ready to accept payment. `{amount}` = formatted price. */
      paymentGateCta: string
      /** Forge payment gate: CTA label while waiting for oracle response before 402. */
      paymentGateContacting: string
      /** Forge payment gate: CTA label while building settle tx (RPC). */
      paymentGateArming: string
      /** Forge payment gate: CTA label when Freighter/wallet signing dialog is open. */
      paymentGateSigning: string
      /** Forge payment gate: CTA label once payment confirmed, agent generating artifact. */
      paymentGateForging: string
      /** Forge: secondary hint below CTA explaining what the payment does. */
      paymentGateHint: string
      /** Forge: status strip text during payment (PROCESSING_PAYMENT). */
      paymentGateStatusStrip: string
      /** Forge: status strip text while arming the settle tx. */
      paymentGateArmingStrip: string
      /** Forge: mint artifact button label (after oracle returns). */
      mintArtifactCta: string
      errors: {
        connectWallet: string
        nameShort: string
        priceInvalid: string
        collectionIdRead: string
        clipboard: string
        anomalyShort: string
        agentRequest: string
        agentPay: string
        agentNot402: string
        fetchAgentImage: string
        finalUri: string
        lowEnergyAgent: string
        /** Saldo no comprobado por fallo temporal del RPC (no confundir con PHASELQ bajo). */
        rpcBalanceCheckFailed: string
        /** RPC Soroban testnet saturado (503 / overload). */
        sorobanTestnetCongested: string
        /** Freighter en mainnet u otra red; `{network}` = nombre que reporta Freighter. */
        freighterWrongNetwork: string
        manualNoImage: string
        /** Usuario cerró Freighter / rechazó la firma del settle x402 */
        userAbortedFreighter: string
        /** Settle on-chain OK pero el servidor Oracle respondió ≥500 */
        oracleOfflineAfterPayment: string
        /** Fallback cuando el mensaje no es legible (códigos internos) */
        fusionChamberHalted: string
        /** Índice 0 vacío; 1..13 = PhaseError on-chain (ver contracts/phase-protocol). */
        phaseHostContractErrors: readonly string[]
        phaseHostContractUnknown: string
      }
      placeholders: {
        collectionName: string
        price: string
        anomaly: string
        manualImageUrl: string
      }
    }
    chamber: {
      exit: string
      market: string
      forge: string
      sync: string
      fullMarket: string
      community: string
      catalogLoading: string
      noCommunity: string
      forgeCta: string
      defaultPool: string
      boot: string
      /** One line under the page hero (aligned with Phase Market layout). */
      pageHeroSubtitle: string
      /** Opens modal: collect + quests (chamber one-screen layout). */
      operatorPanelButton: string
      operatorPanelHeading: string
      operatorPanelBackdropClose: string
      statusMonitor: string
      invalidCollectionTitle: string
      invalidCollectionBody: string
      lowEnergyTitle: string
      reqLiqPrefix: string
      wallet: string
      offline: string
      liqBalance: string
      /** Si `getTokenBalance` > saldo del SAC del protocolo; `{total}` = formato 0.00 */
      liqBalanceIssuerMismatch: string
      collectionId: string
      collectionIdProtocol: string
      x402Price: string
      network: string
      networkValue: string
      signalLabel: string
      classicAssetLabel: string
      freighterBalanceLabel: string
      phaseState: string
      nftMinted: string
      liquid: string
      powerLevel: string
      linkWallet: string
      uplinking: string
      disconnect: string
      exhibitionPedestal: string
      /** Encima del arte en pedestal (más corto que `exhibitionPedestal`). */
      pedestalVisualShort: string
      /** `<details>`: contrato, supply, metadata técnica. */
      chamberTechnicalDetails: string
      /** Columna centro-izquierda (preview del NFT). */
      chamberColumnPreview: string
      /** Columna centro-derecha (info / collect). */
      chamberColumnInfo: string
      /** Ticker monospace en el panel de preview (split chamber). */
      chamberDockPreviewTicker: string
      /** Ticker principal en el panel info (split chamber). */
      chamberDockInfoTicker: string
      /** Sub-línea terminal en el panel info (split chamber). */
      chamberDockInfoSubline: string
      mintingTitle: string
      committingLedger: string
      solidState: string
      onChainMeta: string
      stellarExpert: string
      artifactAsciiView: string
      syncingMeta: string
      x402MintPrice: string
      protocolDefaultPool: string
      noImageUri: string
      noImageHint: string
      awaitingPhase: string
      theReactor: string
      x402StreamActive: string
      executeX402: string
      executeSettlement: string
      initializeGenesisSupply: string
      genesisSupplyLoading: string
      manualPhase: string
      solidStateStandby: string
      /** THE_REACTOR: un solo CTA para enviar el NFT desde custodia del emisor a la wallet conectada. */
      reactorClaimNftCta: string
      /** Preview cámara (split izquierda): CTA corto para custodia → wallet. */
      chamberPreviewCollectCta: string
      /** NFT ya en la wallet conectada — reactor en espera (enlace opcional al dashboard). */
      reactorNftSecuredHint: string
      /** `owner_of` no es el emisor ni la wallet: no se puede COLECTAR desde reactor. */
      reactorClaimUnavailableHint: string
      systemLogs: string
      logsToggle: string
      logsClose: string
      live: string
      nodeDesyncTitle: string
      rebootProcess: string
      collectionTitleLoading: string
      defaultChamberTitle: string
      titleWithName: string
      pedestalWithCreator: string
      pedestalLoading: string
      pedestalDefault: string
      collectionLine: string
      collectionLinkTitle: string
      faucetButton: string
      rewardsSectionTitle: string
      /** Columna derecha: genesis/daily + panel COLLECT NFT (sin quests). */
      collectInfoPanelTitle: string
      /** Bajo THE_REACTOR: cadena de misiones (quests). */
      reactorQuestsSectionTitle: string
      rewardsHelpAria: string
      rewardsHelpClose: string
      rewardsHelpModalTitle: string
      rewardsHelpLiqTitle: string
      rewardsHelpLiqBody: string
      rewardsHelpQuestsTitle: string
      rewardsHelpQuestsBody: string
      rewardsQuestProgress: string
      /** Panel COLLECT: ya sos owner on-chain del utility NFT (columna derecha). */
      rewardsNftInWalletTitle: string
      /** Enlace a Stellar Expert del contrato PHASE (C…). */
      rewardsNftStellarExpertLink: string
      /** Panel custodia emisor → COLLECT (cualquier wallet; el servidor firma el transfer). */
      rewardsNftCollectPanelTitle: string
      /** `{tokenId}` `{issuerShort}` — primeros caracteres del emisor clásico PHASELQ. */
      rewardsNftCollectPanelBody: string
      /** `{tokenId}` — owner on-chain no es el emisor; COLLECT no aplica. */
      rewardsNftNotIssuerCustodyBody: string
      rewardsNftCollectButton: string
      rewardsNftCollectSending: string
      /** Mientras corre POST /api/phase-nft/verify para COLLECT. */
      rewardsNftCollectVerifying: string
      /** Título si verify falla; el detalle sale del estado (mensaje API). */
      rewardsNftCollectVerifyFailed: string
      /** Tras reintentos: `owner_of` sigue vacío (mint aún no visible o id incorrecto). */
      rewardsNftCollectVerifyNotMintedYet: string
      /** Pedestal: NFT aún en custodia del emisor; ancla al panel lateral COLLECT. */
      pedestalIssuerCustodyHint: string
      pedestalIssuerCustodyScrollLink: string
      /** Pedestal: wallets sin galería Soroban — el NFT existe en ledger aunque no se vea en la UI. */
      walletNftVisibilityTitle: string
      walletNftVisibilityBody: string
      creatorCanMint: string
      creatorMintRule: string
      creatorAlreadyMinted: string
      freighterManualAddTitle: string
      freighterManualAddBody: string
      freighterManualAddTroubleshoot: string
      /** Pedestal: self-transfer para re-emitir evento `transfer` (útil si una wallet externa cachea por eventos). */
      freighterIndexPingButton: string
      freighterIndexPingToastOk: string
      freighterIndexPingToastFail: string
      /** Título del bloque violeta (misma familia que COLLECT en recompensas). */
      freighterTransferPanelTitle: string
      /** Un clic: lee la dirección G… del portapapeles y abre firma + envío on-chain. */
      freighterTransferClipboardButton: string
      /** Texto auxiliar bajo el botón (copiar destino al portapapeles antes). */
      freighterTransferClipboardBlurb: string
      /** Mientras la wallet firma o el RPC envía la tx. */
      freighterTransferSigningLabel: string
      /** `navigator.clipboard.readText` no disponible o permiso denegado. */
      freighterTransferClipboardReadFailed: string
      /** Portapapeles vacío al pulsar transferir. */
      freighterTransferClipboardEmpty: string
      freighterTransferToastOk: string
      freighterTransferToastFail: string
      freighterTransferInvalidRecipient: string
      freighterTransferSameAddress: string
      /** Pedestal: comprobar name/symbol/owner_of/token_uri + JSON metadata vs SEP-0050 (Freighter). */
      freighterSep50CheckButton: string
      freighterSep50CheckIntro: string
      freighterSep50CheckFailToast: string
      /** Pedestal: ya sos owner on-chain; Freighter no lista solo — Add manually. */
      freighterOwnerOnChainAddBody: string
      /** Meta pedestal: contrato PHASE (NFT SEP-41/SEP-50), no el SAC PHASELQ. */
      onChainMetaNftContractLabel: string
      /** Meta pedestal: contrato SAC del token fungible PHASELQ (liquidez). */
      onChainMetaPhaselqSacLabel: string
      /** Un clic: portapapeles = línea1 contrato C… NFT, línea2 id numérico (sin #). */
      freighterCopyBundleButton: string
      freighterCopyBundleToast: string
      /** Pedestal: dueño on-chain del token = wallet; enlace a /dashboard. */
      artifactSecuredLedgerVault: string
      /** Lectura `balance(wallet)` en contrato PHASE; `{count}` = entero. */
      artifactLedgerBalanceContract: string
      protocolStackLabel: string
      /** Subtítulo bajo saldo PHASELQ — liquidez SEP-41. */
      tokenStandardSep41Note: string
      rewardsLiquidityLaneTitle: string
      rewardsMissionChainTitle: string
      /** Botón recompensa: fase trustline Freighter (ámbar). */
      rewardsButtonEstablishingTrustline: string
      /** Botón recompensa: llamada POST /api/faucet. */
      rewardsButtonTransmittingFunds: string
      rewardsTokenTicker: string
      /** Usuario rechazó firmar changeTrust. */
      rewardsTrustlineRejectedToast: string
      /** Cuenta sin XLM / no existe en testnet. */
      rewardsTrustlineAccountMissing: string
      /** Albedo: falta permiso implícito antes del flujo automático de trustline. */
      rewardsTrustlineAlbedoImplicitRequired: string
      /** Error narrativo si el mensaje contiene "unauthorized" sin código PHASE claro. */
      biometricTrustGateClosed: string
      /** Classic asset collect button states */
      classicCollectDisabled: string
      classicCollecting: string
      classicAlreadyCollected: string
      /** `{amount}` = formatted token amount */
      classicAutoCollect: string
      classicCollectAsset: string
      classicRewardOptions: string
      /** Shown when trustline is not set up */
      noTrustline: string
      /** Shown while verifying on-chain owner */
      verifyingOwner: string
      /** Collect to wallet button (standalone, no brackets) */
      collectToMyWallet: string
      /** Payment gate explainer under the price. `{amount}` = formatted price */
      paymentGateExplainer: string
      /** Índice 0 vacío; 1..13 = PhaseError on-chain. */
      phaseHostContractErrors: readonly string[]
      phaseHostContractUnknown: string
      logs: ChamberLogsCopy
      artifact: ArtifactLabelsCopy
    }
  }
> = {
  en: {
    nav: {
      home: "← Home",
      market: "Market",
      forge: "Forge",
      chamber: "Chamber",
      lang: "Language",
    },
    dashboard: {
      title: "On-chain collections",
      subtitle:
        "Each card is a PHASE collection. Mint opens the fusion chamber for that collection: pay the listed PHASELQ via initiate_phase and receive the utility NFT.",
      shieldBlurb:
        "A screenshot is just a poster — it is not the contract. Your PHASE utility NFT is the on-chain key; previews here stay low-trust until you verify in the Reactor.",
      refresh: "Refresh ledger",
      refreshing: "Syncing…",
      wallet: "Wallet (optional)",
      connect: "Connect Freighter",
      connecting: "Connecting…",
      disconnect: "Disconnect",
      empty: "No collections yet — forge one first.",
      noPreview: "No image URL",
      creator: "Creator",
      mint: "Mint NFT — pay PHASELQ",
      openChamber: "Open chamber",
      id: "ID",
      priceSuffix: "PHASELQ",
      previewPendingFusion: "[ PENDING_FUSION ]",
      previewUnverifiedCopy: "[ UNVERIFIED_COPY ]",
      previewChainVerified: "[ CHAIN_VERIFIED ]",
      back: "◄ Back",
      myArtifactsSection: "[ MY_STABILIZED_ARTIFACTS ]",
      platformListings: "[ PLATFORM_LISTINGS ]",
      sellNft: "[ SELL_NFT ]",
      sellModalTitle: "Sell / transfer NFT",
      buyerAddressLabel: "Buyer Stellar address (G…)",
      buyerHint:
        "Agree PHASELQ payment with the buyer off-wallet, then transfer the on-chain NFT here. Requires deployed contract with transfer_phase_nft.",
      listingPriceLabel: "List price (PHASELQ)",
      listingPublish: "[ PUBLISH_LISTING ]",
      listingHint: "Listing is visible on this market; payment is peer-to-peer.",
      transferNft: "[ TRANSFER_ON_CHAIN ]",
      transferBusy: "Signing…",
      cancel: "Cancel",
      close: "Close",
      cancelListing: "[ DELIST ]",
      listingLoadError: "Could not load listings.",
      transferWasmHint:
        "If simulation fails, redeploy the PHASE WASM with transfer_phase_nft and update CONTRACT_ID.",
      vaultRpcTitle: "[ PHASE_VAULT // SOROBAN_RPC ]",
      vaultRpcBlurb:
        "Your PHASE utility NFTs listed by this app via Soroban simulation (total_supply + owner_of). No third-party indexer required for this view.",
      vaultRpcLoading: "Scanning chain…",
      vaultRpcEmpty: "No PHASE NFTs found for this wallet in the scanned id range.",
      vaultRpcError: "Could not load vault (RPC or timeout). Retry later.",
    },
    studioModal: {
      windowTitle: "PHASE Art Studio",
      canvasMeta: "px · lossless PNG",
      file: "File",
      edit: "Edit",
      view: "View",
      saveSeal: "Save & seal…",
      newCanvas: "New canvas",
      exitDiscard: "Exit without saving",
      undo: "Undo",
      closePolygon: "Close polygon",
      zoomIn: "Zoom in",
      zoomOut: "Zoom out",
      zoom100: "Zoom 100%",
      refLine: "Inspired by",
      cancel: "Cancel",
      clear: "Clear",
      seal: "Seal",
    },
    studioEditor: {
      tools: "Tools",
      pencil: "Pencil",
      brush: "Brush",
      airbrush: "Airbrush",
      eraser: "Eraser",
      bucket: "Fill",
      line: "Line",
      rect: "Rectangle",
      ellipse: "Ellipse",
      polygon: "Polygon",
      text: "Text",
      select: "Select",
      thickness: "Size",
      paletteTitle: "PHASE palette (greens / cyans / grays)",
      hint: "Canvas {w}×{h}px · lossless PNG on seal · Zoom {z}% · Selection + Del clears region",
      textPlaceholder: "Your text…",
    },
    imageValidation: {
      maxLen: "Image URL must be at most 256 characters.",
      control: "Image URL cannot contain control characters.",
      quotes: "Image URL cannot contain \" or \\ (on-chain JSON).",
      mustHttpsOrIpfs: "On-chain image must be https://… or ipfs://…",
      ipfsCidShort: "Invalid ipfs:// URI (CID too short).",
    },
    forge: {
      exit: "◄ Exit",
      title: "PHASE Forge",
      oracleBadge: "◈ AGENT_IA // THE_ORACLE",
      market: "Market",
      chamber: "Chamber",
      intro:
        "Create an image and short story with AI, then save it on Stellar testnet as your collection. You pay once in your wallet with the PHASE token (test coins only). After the image is ready, you choose a name and mint it on-chain.",
      anomalyLabel: "Describe what you want",
      collectionName: "Collection name",
      fusionPrice: "Price (PHASE token)",
      readout: "Price preview",
      linkWallet: "Connect wallet",
      linking: "Connecting…",
      walletLabel: "Wallet",
      initiateAgent: "Generate with AI",
      forgeCollection: "Create collection",
      deploying: "Saving on the network…",
      disconnect: "Disconnect",
      artPreview: "Preview",
      lorePreview: "Story text",
      awaitingFeed: "Nothing generated yet",
      oracleHint: "Write a few words (4+). Then tap Generate — your wallet will ask you to confirm a small test payment.",
      collectionLive: "Collection published",
      magicLink: "Share link",
      copy: "Copy link",
      copied: "Copied",
      openChamber: "Open chamber",
      collectionIdLabel: "Collection",
      registerTitle: "Create",
      tabOracle: "AI image",
      tabManual: "I have an image",
      forgeTablistAria: "Choose how to create",
      manualClearFile: "Remove file",
      oracleStyleLabel: "Look of the image",
      oracleStyleAdaptive: "Match your description",
      oracleStyleCyber: "Bold sci-fi look",
      manualBadge: "◈ DIRECT_UPLOAD // NO_X402",
      manualIntro:
        "Upload your own picture (or paste a link), add optional text, and publish the collection on testnet. No AI step — only normal network fees.",
      manualDropLabel: "Image file",
      manualDropHint: "PNG, JPEG or WebP — or paste a link below",
      manualUrlLabel: "Image link (optional)",
      manualLoreLabel: "Description (optional)",
      manualLorePlaceholder: "Short description (shown only here before mint).",
      manualUploadMint: "Publish collection",
      manualAwaiting: "Add an image to continue",
      manualAwaitingHint: "Drop a file or paste https:// or ipfs://",
      protocolBriefButton: "How it works",
      protocolBriefTitleOracle: "How AI create works",
      protocolBriefTitleManual: "Upload mode",
      rewardsPanelButton: "Free test tokens",
      rewardsPanelTitle: "Test tokens & rewards",
      rewardsPanelClose: "Close",
      loreExpandHint: "Tap for full text",
      collectionLiveDetails: "Details",
      trustline_beginner_blurb:
        "PHASE is the test payment token. Tap the big button once so your wallet can hold it. Need coins? Get free test XLM from Friendbot (link below), then open “Free test tokens” on the right for more PHASE.",
      trustline_technical_details_label: "Technical details",
      forgeCtaGenerateIdle: "Generate image",
      forgeCtaGenerateContacting: "Connecting…",
      forgeCtaGenerateArming: "Preparing payment…",
      forgeCtaGenerateSigning: "Confirm in your wallet",
      forgeAgentForgingTickers: ["Creating your image…", "Writing the story…"],
      forgeCtaMintArtifact: "Save image on-chain",
      forgeSectionLaterOptions: "Name & price (before save)",
      forgeNarrativeWorldTitle: "Story world (optional)",
      forgeNarrativeWorldName: "World name",
      forgeNarrativeWorldNamePlaceholder: "E.g. Shadow sector 7",
      forgeNarrativeWorldBackstory: "Backstory",
      forgeOptionalShort: "Optional…",
      uxRailStepAOracle: "1 · Oracle",
      uxRailStepAManual: "1 · Image",
      uxRailStepB: "2 · Collection · deploy",
      deployStatus: "CONTRACT_DEPLOY",
      agentDeployStatus: "ORACLE_PIPELINE",
      deployTickers: [
        "Saving collection…",
        "Sending to the network…",
        "Waiting for confirmation…",
        "Linking your wallet…",
        "Almost done…",
      ],
      agentProcessTickers: [
        "Working…",
        "Still working…",
        "Finishing up…",
      ],
      signingPayment: "Opening wallet for payment…",
      paywallNegotiating: "Getting payment details…",
      trustline_section_title: "First: add the PHASE token to your wallet",
      trustline_standby: "Add PHASE token to my wallet",
      trustline_signing: "Approve in your wallet…",
      trustline_syncing: "Confirming on the network…",
      trustline_ready: "PHASE token is ready",
      trustline_get_testnet_xlm: "Get free test XLM",
      trustline_msg_initialized: "Your wallet can hold PHASE. You can generate or claim free test tokens.",
      trustline_msg_empty_account: "Your test account needs a few free XLM first. Use Friendbot (link below), then come back.",
      trustline_msg_connect_wallet: "Connect your wallet first, then tap the button above.",
      trustline_msg_config_missing: "This site is missing token configuration. Ask the team to set CLASSIC_LIQ in the server env.",
      trustline_msg_waiting_confirmation: "Sent. Waiting for the network to confirm…",
      trustline_msg_protocol_ready: "You can use Rewards and pay for AI generation.",
      trustline_gas_label: "Test XLM balance",
      trustline_friendbot_link: "Get free XLM ↗",
      trustline_asset_hint:
        "Works with Freighter, Albedo, xBull and other Stellar wallets on testnet.",
      trustline_albedo_prep_title: "Albedo: allow signing",
      trustline_albedo_prep_body:
        "Tap once below so your browser does not block the wallet popup.",
      trustline_albedo_prep_button: "Allow Albedo signing",
      trustline_albedo_prep_working: "Opening Albedo…",
      oracle_blocked_msg:
        "Add the PHASE token with the button above, then you can generate.",
      mint_blocked_msg:
        "Add the PHASE token with the button above, then you can publish.",
      paymentGateCta: "Pay PHASELQ to the Forge Agent",
      paymentGateContacting: "Contacting agent…",
      paymentGateArming: "Preparing payment transaction…",
      paymentGateSigning: "Sign payment in your wallet…",
      paymentGateForging: "Agent received payment — generating artifact…",
      paymentGateHint:
        "Your payment is sent on-chain to the Forge Agent. Once confirmed on the Stellar ledger, the agent generates and mints your artifact automatically.",
      paymentGateStatusStrip: "Open your wallet to sign the payment",
      paymentGateArmingStrip: "Building payment transaction…",
      mintArtifactCta: "Mint artifact on-chain",
      ipfsOracleHint: "Tip: configure PINATA_JWT on the server so long image URLs (e.g. Pollinations) are sealed to ipfs:// before mint (256-char on-chain limit).",
      errors: {
        connectWallet: "Connect your wallet first.",
        nameShort: "Collection name is too short (min. 2 characters).",
        priceInvalid: "Invalid PHASELQ price.",
        collectionIdRead: "Could not read collection_id on-chain.",
        clipboard: "Could not copy to clipboard.",
        anomalyShort: "Write a little more — at least 4 characters.",
        agentRequest: "Oracle request failed.",
        agentPay: "Settlement transaction failed or was rejected.",
        agentNot402: "Unexpected response from forge-agent (expected 402 then paid run).",
        fetchAgentImage: "Could not download generated image for mint.",
        finalUri: "Could not produce a valid on-chain image URI (try enabling IPFS upload).",
        lowEnergyAgent:
          "You need a bit more PHASE in your wallet for this step. Add the token above, then open “Free test tokens” on the right.",
        rpcBalanceCheckFailed:
          "Could not read your PHASELQ balance (Soroban RPC timed out or errored). Wait a few seconds and try again, or set STELLAR_RPC_FALLBACK_URLS in .env.local.",
        sorobanTestnetCongested:
          "Stellar Testnet is congested (HTTP 503). Please retry in a few seconds.",
        freighterWrongNetwork:
          "Freighter is not on Stellar testnet (current: {network}). Switch network in Freighter to Testnet, then retry.",
        manualNoImage: "Provide an image file or a valid https:// or ipfs:// URL.",
        userAbortedFreighter: "Payment cancelled in Freighter (x402 PHASELQ settle was not signed).",
        oracleOfflineAfterPayment:
          "On-chain settlement likely succeeded, but the Oracle step failed (often Gemini: missing key, quota, or model). PHASELQ was debited. Fix GEMINI_API_KEY / GEMINI_MODEL on the server, check logs, then retry — or use Manual forge without another settle.",
        fusionChamberHalted:
          "[ PROTOCOL_HALTED: ERROR_IN_FUSION_CHAMBER ] — Check PHASELQ balance, contract IDs, IPFS config, and the browser console for the underlying error.",
        phaseHostContractErrors: PHASE_HOST_CONTRACT_ERRORS_EN,
        phaseHostContractUnknown: PHASE_HOST_CONTRACT_UNKNOWN_EN,
      },
      placeholders: {
        collectionName: "Crypto-Art 2026",
        price: "5.0",
        anomaly: "Describe the artifact to forge…",
        manualImageUrl: "https://… or ipfs://…",
      },
    },
    chamber: {
      exit: "◄ Exit",
      market: "Market",
      forge: "Forge",
      sync: "Sync",
      fullMarket: "Full market →",
      community: "Community",
      catalogLoading: "Syncing catalog…",
      noCommunity: "No community collections yet.",
      forgeCta: "Forge one",
      defaultPool: "Default pool",
      boot: "Chamber loading…",
      pageHeroSubtitle:
        "Pay PHASELQ tokens to mint your artifact NFT on the Stellar ledger, then collect it to your wallet.",
      operatorPanelButton: "Rewards & collect",
      operatorPanelHeading: "Rewards & collect",
      operatorPanelBackdropClose: "Close panel",
      statusMonitor: "Status",
      invalidCollectionTitle: "Collection not found",
      invalidCollectionBody:
        "No on-chain metadata for collection #{id}. Check the forge link or collection ID.",
      lowEnergyTitle: "Insufficient balance",
      reqLiqPrefix: "REQ ≥",
      wallet: "Wallet",
      offline: "— OFFLINE —",
      liqBalance: "PHASELQ balance",
      liqBalanceIssuerMismatch:
        "Also held as PHASELQ elsewhere: {total} — only the balance above is spendable for settlement on this protocol deployment.",
      collectionId: "Collection ID",
      collectionIdProtocol: "0 (protocol)",
      x402Price: "Mint price",
      network: "Network",
      networkValue: "Stellar Testnet",
      signalLabel: "Signal",
      classicAssetLabel: "Classic asset",
      freighterBalanceLabel: "Wallet balance",
      phaseState: "Artifact",
      nftMinted: "Minted",
      liquid: "Not minted yet",
      powerLevel: "Power level",
      linkWallet: "Connect wallet",
      uplinking: "Connecting…",
      disconnect: "Disconnect",
      exhibitionPedestal: "EXHIBITION_PEDESTAL // SMART_ASSET",
      pedestalVisualShort: "Artifact",
      chamberTechnicalDetails: "Contract & on-chain details",
      chamberColumnPreview: "Preview",
      chamberColumnInfo: "Info & collect",
      chamberDockPreviewTicker: "Artifact preview",
      chamberDockInfoTicker: "Ownership verified",
      chamberDockInfoSubline: "NFT metadata on-chain (SEP-41/SEP-50)",
      mintingTitle: "Minting artifact…",
      committingLedger: "Recording on the Stellar ledger…",
      solidState: "On-chain",
      onChainMeta: "name() · symbol() · owner_of() · token_uri",
      stellarExpert: "Stellar Expert ↗",
      artifactAsciiView: "Artifact preview",
      syncingMeta: "Loading collection…",
      x402MintPrice: "Mint price",
      protocolDefaultPool: "Protocol default pool",
      noImageUri: "[ NO_COLLECTION_IMAGE_URI ]",
      noImageHint: "Creator: add an image when forging",
      awaitingPhase: "Pay to mint and reveal your artifact",
      theReactor: "The Reactor",
      x402StreamActive: "Payment in progress…",
      executeX402: "Complete payment",
      executeSettlement: "Complete payment",
      initializeGenesisSupply: "⚡ Claim starter PHASELQ",
      genesisSupplyLoading: "Claiming starter PHASELQ…",
      manualPhase: "Manual phase transition",
      solidStateStandby: "Artifact minted — ready to collect",
      reactorClaimNftCta: "Collect to wallet",
      chamberPreviewCollectCta: "Collect",
      reactorNftSecuredHint: "Your artifact is in your wallet. View it in the Dashboard.",
      reactorClaimUnavailableHint:
        "Your artifact is on-chain but cannot be collected from here — it is not in issuer custody.",
      systemLogs: "SYSTEM_LOGS",
      logsToggle: "Logs",
      logsClose: "Close logs",
      live: "LIVE",
      nodeDesyncTitle: "Connection lost",
      rebootProcess: "Retry connection",
      collectionTitleLoading: "Collection",
      defaultChamberTitle: "PHASE Protocol — Default Pool",
      titleWithName: "{name} // #{id}",
      pedestalWithCreator: "{name} · CREATOR {addr}",
      pedestalLoading: "Loading collection…",
      pedestalDefault: "Default collection · Core liquidity pool",
      collectionLine: "Collection #{id} · {name}",
      collectionLinkTitle: "Collection #{id}",
      faucetButton: "⚡ Claim PHASELQ",
      rewardsSectionTitle: "Rewards",
      collectInfoPanelTitle: "Collect — liquidity + NFT",
      reactorQuestsSectionTitle: "Quests",
      rewardsHelpAria: "Help: PHASELQ and reward programs",
      rewardsHelpClose: "Close",
      rewardsHelpModalTitle: "PHASELQ & rewards",
      rewardsHelpLiqTitle: "What is LIQ?",
      rewardsHelpLiqBody:
        "LIQ is the short name we show in the UI for PHASELQ, the Soroban testnet utility token for PHASE. You use it to pay mint prices (initiate_phase / x402 settlement) and to experiment with the reactor. Balances use seven decimals like other Stellar assets. This is testnet liquidity—not real money.",
      rewardsHelpQuestsTitle: "Genesis, daily, and quests",
      rewardsHelpQuestsBody:
        "Genesis is a one-time starting grant for new wallets. Daily recharge refills on a 24-hour timer. Quests are one-time missions (connect wallet, forge a collection, complete a settlement). Progress bars show eligibility; Claim requests a server-signed mint when requirements are met.",
      rewardsQuestProgress: "QUEST PROGRESS",
      rewardsNftInWalletTitle: "In your wallet",
      rewardsNftStellarExpertLink: "[ VIEW ON STELLAR EXPERT ]",
      rewardsNftCollectPanelTitle: "COLLECT · UTILITY NFT (SEP-41/50)",
      rewardsNftCollectPanelBody:
        "Token #{tokenId}: the NFT is held by the classic PHASELQ issuer ({issuerShort}…). Collect sends transfer(issuer → your wallet), signed by the server — no wallet signature needed. Works with Albedo, Freighter, xBull, etc.",
      rewardsNftNotIssuerCustodyBody:
        "Token #{tokenId}: on-chain owner is not the PHASELQ issuer; server Collect does not apply. Use your wallet’s “add NFT manually” (contract address + Token ID) if your app supports it.",
      rewardsNftCollectButton: "COLLECT",
      rewardsNftCollectSending: "SENDING…",
      rewardsNftCollectVerifying: "Verifying NFT on ledger…",
      rewardsNftCollectVerifyFailed: "Ledger check failed",
      rewardsNftCollectVerifyNotMintedYet:
        "This token is not visible on the PHASE contract yet. Open Chamber, press SYNC, wait for the pedestal to load, then tap COLLECT again.",
      pedestalIssuerCustodyHint:
        "Utility NFT is still in issuer custody. Use COLLECT in the right-hand panel (server-signed transfer to your connected wallet).",
      pedestalIssuerCustodyScrollLink: "Jump to COLLECT panel ↓",
      walletNftVisibilityTitle: "NFT NOT SHOWING IN YOUR WALLET?",
      walletNftVisibilityBody:
        "If your transaction history shows a successful settlement (invoke settle → true), the protocol already minted your NFT on-chain—that is the proof. Many wallets show Soroban transactions in history but do not display SEP-41/SEP-50 NFTs in the main balance view. This does not mean the NFT is lost.\n\n• Your PHASE utility NFT lives on testnet: verified by owner_of = your address on the PHASE contract.\n• Tap COPY · CONTRACT + TOKEN ID below to paste into your wallet's \"add NFT manually\" (works with Freighter, Albedo, xBull, etc.).\n• PHASE Dashboard → Vault scans Soroban RPC and lists every PHASE NFT for your wallet (source of truth).\n• Stellar Expert (contract link) helps verify owner_of, token_uri, and transfers on-chain.",
      creatorCanMint: "CREATOR_MINT_ENABLED",
      creatorMintRule: "Creator can mint this collection too (one utility NFT per wallet per collection).",
      creatorAlreadyMinted: "Creator already minted this collection with this wallet.",
      freighterManualAddTitle: "SOROBAN_NFT · MANUAL_ADD (ANY_WALLET)",
      freighterManualAddBody:
        "If it does not appear in your wallet UI: look for “add NFT / Soroban contract” (Albedo builds vary) or use Freighter Collectibles → Add manually.",
      freighterManualAddTroubleshoot:
        "Freighter’s Collectibles flow may rely on its own backend or a public indexer — independent from this app. If Add manually fails, use Ping Freighter index below (no-op self-transfer, emits a standard transfer event), wait, then retry Add manually. To move the NFT to someone else, copy their Stellar G-address to the clipboard, then use the magenta ledger button (no typing in this panel). In PHASE, your authoritative list is the dashboard vault (Soroban RPC scan) — no Mercury subscription required for that.",
      freighterIndexPingButton: "[ PING FREIGHTER INDEX ]",
      freighterIndexPingToastOk: "Index ping submitted. Wait 1–5 min, then Add Collectible in Freighter again.",
      freighterIndexPingToastFail: "Index ping failed. Check network or try again.",
      freighterTransferPanelTitle: "COLLECTIBLE · TRANSFER (SIGN IN WALLET)",
      freighterTransferClipboardButton: "TRANSFER NFT",
      freighterTransferClipboardBlurb:
        "Copy the recipient’s Stellar G-address to the clipboard, then tap TRANSFER NFT — your wallet signs the Soroban transfer (same flow style as COLLECT).",
      freighterTransferSigningLabel: "SIGNING…",
      freighterTransferClipboardReadFailed: "Could not read the clipboard. Allow paste permission or copy the G-address again.",
      freighterTransferClipboardEmpty: "Clipboard is empty. Copy the recipient’s G-address first.",
      freighterTransferToastOk: "NFT transfer submitted. Wait for ledger confirmation.",
      freighterTransferToastFail: "NFT transfer failed. Check the address, network, and try again.",
      freighterTransferInvalidRecipient: "Enter a valid Stellar public address (G…, 56 characters).",
      freighterTransferSameAddress:
        "Use Ping Freighter index for a self-transfer. Copy a different G-address to the clipboard to move the NFT.",
      freighterSep50CheckButton: "[ CHECK SEP-50 / FREIGHTER READINESS ]",
      freighterSep50CheckIntro:
        "Runs on our server: Soroban name(), symbol(), owner_of, token_uri, then fetches metadata JSON. Freighter still uses its own indexer for auto-list — this only proves the contract + URL match the SEP-0050 draft.",
      freighterSep50CheckFailToast: "SEP-50 check request failed.",
      freighterOwnerOnChainAddBody:
        "You already own this NFT on the PHASE contract. Albedo often shows nothing here even though the ledger does—use COPY below + Dashboard vault. Freighter: Collectibles → Add manually with the same C… + Token ID (testnet).",
      onChainMetaNftContractLabel: "NFT_PROTOCOL_CONTRACT",
      onChainMetaPhaselqSacLabel: "PHASELQ_SAC (fungible)",
      freighterCopyBundleButton: "[ COPY · C… CONTRACT + TOKEN ID ]",
      freighterCopyBundleToast:
        "Copied 2 lines: (1) PHASE NFT contract C…, (2) numeric Token ID. Paste into your wallet’s manual add (Albedo / Freighter / etc.) or keep for Lab.",
      artifactSecuredLedgerVault: "Artifact secured on the Stellar ledger — view in PHASE vault",
      artifactLedgerBalanceContract: "CONTRACT balance() · {count} utility NFT(s) attributed to this wallet",
      protocolStackLabel: "Pay with PHASELQ · Mint on Stellar · Collect to your wallet",
      tokenStandardSep41Note: "PHASELQ adheres to SEP-41 (Soroban token interface).",
      rewardsLiquidityLaneTitle: "LIQUIDITY_BOOTSTRAP",
      rewardsMissionChainTitle: "OPERATOR_QUEST_CHAIN",
      rewardsButtonEstablishingTrustline: "Setting up trustline…",
      rewardsButtonTransmittingFunds: "Sending funds…",
      rewardsTokenTicker: "LIQ",
      rewardsTrustlineRejectedToast: "Trustline required to receive funds. Approve the changeTrust request in your wallet.",
      rewardsTrustlineAccountMissing:
        "Stellar account not on testnet or unfunded. Add test XLM (Friendbot) before claiming PHASELQ.",
      rewardsTrustlineAlbedoImplicitRequired:
        "Albedo: allow signing first (bottom bar or Forge trustline card), then claim again.",
      biometricTrustGateClosed: "Unauthorized. Please check your wallet and try again.",
      classicCollectDisabled: "Not available yet",
      classicCollecting: "Collecting…",
      classicAlreadyCollected: "Already in your wallet",
      classicAutoCollect: "Set up and collect +{amount} PHASELQ",
      classicCollectAsset: "Collect +{amount} PHASELQ",
      classicRewardOptions: "PHASELQ rewards",
      noTrustline: "Not configured",
      verifyingOwner: "Verifying ownership…",
      collectToMyWallet: "Collect to my wallet",
      paymentGateExplainer: "Pay {amount} PHASELQ to the Forge Agent — your artifact is generated and minted on the Stellar ledger automatically.",
      phaseHostContractErrors: PHASE_HOST_CONTRACT_ERRORS_EN,
      phaseHostContractUnknown: PHASE_HOST_CONTRACT_UNKNOWN_EN,
      logs: {
        chamberOnline: "Chamber online — waiting for wallet…",
        walletRequest: "Connecting wallet…",
        walletLinkedPrefix: "Wallet connected:",
        walletDenied: "Wallet connection denied",
        walletUnlink: "Wallet disconnected",
        systemDesync: "Connection lost — reconnecting to Stellar node…",
        tracePrefix: "[ trace ]",
        runtimeFaultPrefix: "[ error ]",
        rebootProcess: "Retrying connection…",
        manualPhaseStart: "Manual phase — starting",
        detectingLiquidity: "Checking PHASELQ balance…",
        authorizingTx: "Authorizing Soroban transaction…",
        mintingNft: "Minting utility NFT…",
        crystallizing: "Crystallizing identity…",
        phaseTransitionComplete: "Phase transition complete",
        mintConfirmedViewPedestal: "NFT minted — check artifact panel",
        lowEnergyWarning: "Insufficient PHASELQ — claim your daily reward to continue",
        x402Initiating: "Starting on-chain payment…",
        walletKitPickerForSettle:
          "Choose a wallet to sign the payment and receive the NFT…",
        walletKitPickerDismissed: "Wallet picker closed — payment cancelled",
        receivingChallenge: "Receiving payment challenge…",
        signingAuth: "Signing authorization…",
        settlingPayment: "Sending payment…",
        decrypting: "Decrypting artifact data…",
        x402Ok: "Payment confirmed — artifact unlocked",
        forgedOnSettle: "Artifact minted on payment — check pedestal",
        faucetEmitting: "Sending PHASELQ reward…",
        faucetLoadingSupply: "Loading supply…",
        faucetOk: "PHASELQ received — balance updated",
        faucetReceived: "+{amount} PHASELQ received",
        faucetFailPrefix: "[ faucet error ]",
        genesisSupplyRequested: "Requesting starter PHASELQ…",
        genesisTransferComplete: "Starter PHASELQ received",
        classicTrustlineEstablishing: "Checking PHASELQ trustline for reward…",
        classicTrustlineFreighter: "Waiting for changeTrust signature in wallet…",
        classicTrustlineConfirmed: "Trustline active — classic asset ready",
        classicTrustlineRejected: "Trustline signature denied",
        classicTrustlineAccountMissing: "Account not found — add testnet XLM first",
      },
      artifact: {
        registeredDefault: "PHASE utility artifact",
        owner: "Owner",
        serial: "Serial",
        powerLevel: "Power level",
        readonly: "Read-only view",
        noVisual: "No image",
        ariaLabel: "Phase utility NFT artifact",
        sepSuffix: "· SEP-41/50",
        dataLocked: "Locked",
        contract: "Contract",
        terminalRestricted: "Connect wallet to verify ownership",
        systemActive: "Ownership verified",
        verifying: "Verifying on-chain…",
        downloadCertificate: "Download certificate",
        expandPreview: "Expand",
        closePreview: "Close",
        unverifiedCopy: "Preview only",
        authenticitySealVerified: "✦ On-chain #{token} · viewer:{sig}",
        accessDeniedLine: "A screenshot is not the NFT — connect wallet to verify",
        verifyingHint: "Checking ownership on the Stellar ledger…",
        stateLiquid: "Liquid",
        stateSolid: "Solid",
        accessPrivateMetadata: "View private metadata",
        privateChannelUnlocked: "Private metadata",
        metadataStandard: "Metadata standard",
        previewOnly: "Preview only",
        decryptingImage: "Revealing…",
        monitorCollectionName: "Collection",
        monitorContractAddr: "Contract",
        supplyStabilized: "Supply",
        secretId: "Token ID",
        holderSignature: "Holder signature",
        rawMetadata: "Raw metadata",
        pendingOwnershipVerification: "Verifying ownership…",
        imageLoadHint:
          "The preview URL did not load (blocked, slow IPFS gateway, or bad link). Open the URL in a new tab or try another gateway.",
        openImageUrl: "Open image URL",
        chamberPreviewCollectionAddress: "Collection address",
        chamberPreviewCopy: "Copy",
        chamberPreviewTokenId: "Token ID",
      },
    },
  },
  es: {
    nav: {
      home: "← Inicio",
      market: "Mercado",
      forge: "Forja",
      chamber: "Cámara",
      lang: "Idioma",
    },
    dashboard: {
      title: "Colecciones on-chain",
      subtitle:
        "Cada tarjeta es una colección PHASE. Mint abre la cámara de fusión: pagas el PHASELQ indicado con initiate_phase y recibes el NFT de utilidad.",
      shieldBlurb:
        "Un pantallazo es solo un póster — no es el contrato. Tu NFT de utilidad PHASE es la llave on-chain; aquí las vistas son de baja confianza hasta que verifiques en el Reactor.",
      refresh: "Actualizar ledger",
      refreshing: "Sincronizando…",
      wallet: "Wallet (opcional)",
      connect: "Conectar Freighter",
      connecting: "Conectando…",
      disconnect: "Desconectar",
      empty: "Aún no hay colecciones — crea una en la forja.",
      noPreview: "Sin URL de imagen",
      creator: "Creador",
      mint: "Acuñar NFT — pagar PHASELQ",
      openChamber: "Abrir cámara",
      id: "ID",
      priceSuffix: "PHASELQ",
      previewPendingFusion: "[ PENDING_FUSION ]",
      previewUnverifiedCopy: "[ COPIA_NO_VERIFICADA ]",
      previewChainVerified: "[ VERIFICADO_EN_CADENA ]",
      back: "◄ Volver",
      myArtifactsSection: "[ MIS_ARTEFACTOS_ESTABILIZADOS ]",
      platformListings: "[ ANUNCIOS_EN_LA_PLATAFORMA ]",
      sellNft: "[ VENDER_NFT ]",
      sellModalTitle: "Vender / transferir NFT",
      buyerAddressLabel: "Dirección Stellar del comprador (G…)",
      buyerHint:
        "Acordá el pago en PHASELQ con el comprador (transferencia directa), luego transferí el NFT on-chain aquí. Requiere contrato PHASE con transfer_phase_nft desplegado.",
      listingPriceLabel: "Precio de venta (PHASELQ)",
      listingPublish: "[ PUBLICAR_ANUNCIO ]",
      listingHint: "El anuncio se ve en este mercado; el cobro es P2P entre wallets.",
      transferNft: "[ TRANSFERIR_ON_CHAIN ]",
      transferBusy: "Firmando…",
      cancel: "Cancelar",
      close: "Cerrar",
      cancelListing: "[ QUITAR_ANUNCIO ]",
      listingLoadError: "No se pudieron cargar los anuncios.",
      transferWasmHint:
        "Si falla la simulación, redesplegá el WASM PHASE con transfer_phase_nft y actualizá CONTRACT_ID.",
      vaultRpcTitle: "[ BÓVEDA_PHASE // RPC_SOROBAN ]",
      vaultRpcBlurb:
        "Tus NFT de utilidad PHASE listados por esta app vía simulación Soroban (total_supply + owner_of). Esta vista no depende de un indexador de terceros.",
      vaultRpcLoading: "Escaneando cadena…",
      vaultRpcEmpty: "No se encontraron NFT PHASE para esta wallet en el rango escaneado.",
      vaultRpcError: "No se pudo cargar la bóveda (RPC o tiempo de espera). Reintentá más tarde.",
    },
    studioModal: {
      windowTitle: "PHASE Estudio de arte",
      canvasMeta: "px · PNG sin pérdida",
      file: "Archivo",
      edit: "Edición",
      view: "Ver",
      saveSeal: "Guardar y sellar…",
      newCanvas: "Lienzo nuevo",
      exitDiscard: "Salir sin guardar",
      undo: "Deshacer",
      closePolygon: "Cerrar polígono",
      zoomIn: "Acercar",
      zoomOut: "Alejar",
      zoom100: "Zoom 100%",
      refLine: "Inspirado en",
      cancel: "Cancelar",
      clear: "Borrar",
      seal: "Sellar",
    },
    studioEditor: {
      tools: "Herramientas",
      pencil: "Lápiz",
      brush: "Pincel",
      airbrush: "Aerógrafo",
      eraser: "Borrador",
      bucket: "Cubo",
      line: "Línea",
      rect: "Rectángulo",
      ellipse: "Elipse",
      polygon: "Polígono",
      text: "Texto",
      select: "Selección",
      thickness: "Grosor",
      paletteTitle: "Paleta PHASE (verdes / cianes / grises)",
      hint: "Lienzo {w}×{h}px · PNG sin pérdida al sellar · Zoom {z}% · Selección + Supr borra región",
      textPlaceholder: "Tu texto…",
    },
    imageValidation: {
      maxLen: "La URL de imagen debe tener como máximo 256 caracteres.",
      control: "La URL de imagen no puede contener caracteres de control.",
      quotes: "La URL de imagen no puede contener \" ni \\ (JSON on-chain).",
      mustHttpsOrIpfs: "La imagen on-chain debe ser https://… o ipfs://…",
      ipfsCidShort: "URI ipfs:// inválida (CID demasiado corto).",
    },
    forge: {
      exit: "◄ Salir",
      title: "PHASE Forja",
      oracleBadge: "◈ AGENTE_IA // EL_ORÁCULO",
      market: "Mercado",
      chamber: "Cámara",
      intro:
        "Creás imagen y texto corto con IA y después lo guardás en Stellar testnet como tu colección. Pagás una vez desde la wallet con el token PHASE (monedas de prueba). Cuando la imagen esté lista, elegís nombre y lo publicás en la red.",
      anomalyLabel: "Describí lo que querés",
      collectionName: "Nombre de la colección",
      fusionPrice: "Precio (token PHASE)",
      readout: "Vista del precio",
      linkWallet: "Conectar wallet",
      linking: "Conectando…",
      walletLabel: "Wallet",
      initiateAgent: "Generar con IA",
      forgeCollection: "Crear colección",
      deploying: "Guardando en la red…",
      disconnect: "Desconectar",
      artPreview: "Vista previa",
      lorePreview: "Texto de la historia",
      awaitingFeed: "Todavía no hay imagen",
      oracleHint: "Escribí unas palabras (mínimo 4). Después tocá Generar — la wallet te pedirá confirmar un pago de prueba chico.",
      collectionLive: "Colección publicada",
      magicLink: "Enlace para compartir",
      copy: "Copiar enlace",
      copied: "Copiado",
      openChamber: "Abrir cámara",
      collectionIdLabel: "Colección",
      registerTitle: "Crear",
      tabOracle: "Imagen con IA",
      tabManual: "Ya tengo imagen",
      forgeTablistAria: "Elegí cómo crear",
      manualClearFile: "Quitar archivo",
      oracleStyleLabel: "Estilo visual",
      oracleStyleAdaptive: "Según tu descripción",
      oracleStyleCyber: "Estilo sci-fi marcado",
      manualBadge: "◈ CARGA_DIRECTA // SIN_X402",
      manualIntro:
        "Subís tu propia imagen (o pegás un enlace), podés sumar texto opcional y publicás la colección en testnet. Sin paso de IA — solo fees de red normales.",
      manualDropLabel: "Archivo de imagen",
      manualDropHint: "PNG, JPEG o WebP — o pegá un enlace abajo",
      manualUrlLabel: "Enlace de imagen (opcional)",
      manualLoreLabel: "Descripción (opcional)",
      manualLorePlaceholder: "Texto corto (solo se muestra acá antes de publicar).",
      manualUploadMint: "Publicar colección",
      manualAwaiting: "Agregá una imagen para seguir",
      manualAwaitingHint: "Soltá un archivo o pegá https:// o ipfs://",
      protocolBriefButton: "Cómo funciona",
      protocolBriefTitleOracle: "Cómo funciona la IA",
      protocolBriefTitleManual: "Modo subir imagen",
      rewardsPanelButton: "Tokens de prueba gratis",
      rewardsPanelTitle: "Tokens de prueba y recompensas",
      rewardsPanelClose: "Cerrar",
      loreExpandHint: "Tocá para leer todo",
      collectionLiveDetails: "Detalles",
      trustline_beginner_blurb:
        "PHASE es el token de pago de prueba. Tocá el botón grande una vez para que tu wallet pueda guardarlo. ¿Necesitás monedas? Pedí XLM gratis con Friendbot (enlace abajo) y después abrí «Tokens de prueba gratis» a la derecha para sumar PHASE.",
      trustline_technical_details_label: "Detalles técnicos",
      forgeCtaGenerateIdle: "Generar imagen",
      forgeCtaGenerateContacting: "Conectando…",
      forgeCtaGenerateArming: "Preparando el pago…",
      forgeCtaGenerateSigning: "Confirmá en tu wallet",
      forgeAgentForgingTickers: ["Creando tu imagen…", "Escribiendo el texto…"],
      forgeCtaMintArtifact: "Guardar imagen en la red",
      forgeSectionLaterOptions: "Nombre y precio (antes de guardar)",
      forgeNarrativeWorldTitle: "Mundo narrativo (opcional)",
      forgeNarrativeWorldName: "Nombre del mundo",
      forgeNarrativeWorldNamePlaceholder: "Ej: Sector Umbral-7",
      forgeNarrativeWorldBackstory: "Contexto",
      forgeOptionalShort: "Opcional…",
      uxRailStepAOracle: "1 · Oráculo",
      uxRailStepAManual: "1 · Imagen",
      uxRailStepB: "2 · Colección · despliegue",
      deployStatus: "DESPLIEGUE_CONTRATO",
      agentDeployStatus: "TUBERÍA_ORÁCULO",
      deployTickers: [
        "Guardando colección…",
        "Enviando a la red…",
        "Esperando confirmación…",
        "Vinculando tu wallet…",
        "Casi listo…",
      ],
      agentProcessTickers: [
        "Trabajando…",
        "Seguimos…",
        "Terminando…",
      ],
      signingPayment: "Abriendo la wallet para pagar…",
      paywallNegotiating: "Obteniendo datos del pago…",
      trustline_section_title: "Primero: agregá el token PHASE a tu wallet",
      trustline_standby: "Agregar token PHASE a mi wallet",
      trustline_signing: "Aprobá en tu wallet…",
      trustline_syncing: "Confirmando en la red…",
      trustline_ready: "El token PHASE ya está listo",
      trustline_get_testnet_xlm: "Pedir XLM de prueba gratis",
      trustline_msg_initialized: "Tu wallet ya puede guardar PHASE. Podés generar o pedir tokens de prueba.",
      trustline_msg_empty_account: "Tu cuenta de prueba necesita un poco de XLM gratis primero. Usá Friendbot (enlace abajo) y volvé.",
      trustline_msg_connect_wallet: "Conectá la wallet primero y tocá el botón de arriba.",
      trustline_msg_config_missing: "Falta configuración del token en el servidor. Avisá al equipo (CLASSIC_LIQ en .env).",
      trustline_msg_waiting_confirmation: "Enviado. Esperando confirmación de la red…",
      trustline_msg_protocol_ready: "Ya podés usar Recompensas y pagar la generación con IA.",
      trustline_gas_label: "Saldo de XLM de prueba",
      trustline_friendbot_link: "Pedir XLM gratis ↗",
      trustline_asset_hint:
        "Funciona con Freighter, Albedo, xBull y otras wallets de Stellar en testnet.",
      trustline_albedo_prep_title: "Albedo: permitir firmar",
      trustline_albedo_prep_body:
        "Tocá una vez abajo para que el navegador no bloquee el popup de la wallet.",
      trustline_albedo_prep_button: "Permitir firma con Albedo",
      trustline_albedo_prep_working: "Abriendo Albedo…",
      oracle_blocked_msg:
        "Agregá el token PHASE con el botón de arriba y después podés generar.",
      mint_blocked_msg:
        "Agregá el token PHASE con el botón de arriba y después podés publicar.",
      paymentGateCta: "Pagar PHASELQ al Agente Forge",
      paymentGateContacting: "Contactando al agente…",
      paymentGateArming: "Preparando transacción de pago…",
      paymentGateSigning: "Firmá el pago en tu wallet…",
      paymentGateForging: "El agente recibió el pago — generando artefacto…",
      paymentGateHint:
        "Tu pago se envía on-chain al Agente Forge. Una vez confirmado en el ledger de Stellar, el agente genera y mintea tu artefacto automáticamente.",
      paymentGateStatusStrip: "Abrí tu wallet para firmar el pago",
      paymentGateArmingStrip: "Construyendo transacción de pago…",
      mintArtifactCta: "Mintear artefacto on-chain",
      ipfsOracleHint:
        "Tip: configurá PINATA_JWT en el servidor para sellar URLs largas de imagen (p. ej. Pollinations) a ipfs:// antes del mint (límite 256 caracteres on-chain).",
      errors: {
        connectWallet: "Conecta la wallet primero.",
        nameShort: "Nombre de colección demasiado corto (mín. 2 caracteres).",
        priceInvalid: "Precio PHASELQ inválido.",
        collectionIdRead: "No se pudo leer collection_id on-chain.",
        clipboard: "No se pudo copiar al portapapeles.",
        anomalyShort: "Escribí un poco más — al menos 4 caracteres.",
        agentRequest: "Falló la petición al Oráculo.",
        agentPay: "La transacción de liquidación falló o fue rechazada.",
        agentNot402: "Respuesta inesperada de forge-agent (se esperaba 402 y luego ejecución pagada).",
        fetchAgentImage: "No se pudo descargar la imagen generada para el mint.",
        finalUri: "No se pudo obtener una URI de imagen válida on-chain (probá habilitar subida IPFS).",
        lowEnergyAgent:
          "Te falta un poco de PHASE en la wallet para este paso. Agregá el token arriba y después abrí «Tokens de prueba gratis» a la derecha.",
        rpcBalanceCheckFailed:
          "No se pudo leer tu saldo PHASELQ (el RPC Soroban falló o hizo timeout). Esperá unos segundos y reintentá, o configurá STELLAR_RPC_FALLBACK_URLS en .env.local.",
        sorobanTestnetCongested:
          "La red de Stellar Testnet está congestionada (Error 503). Por favor, reintenta en unos segundos.",
        freighterWrongNetwork:
          "Freighter no está en Stellar testnet (red actual: {network}). Cambiá a Testnet en Freighter y reintentá.",
        manualNoImage: "Necesitás un archivo de imagen o una URL https:// o ipfs:// válida.",
        userAbortedFreighter: "Pago cancelado en Freighter (no se firmó el settle x402 en PHASELQ).",
        oracleOfflineAfterPayment:
          "La liquidación on-chain probablemente se confirmó, pero falló el paso del Oráculo (suele ser Gemini: clave, cuota o modelo). El PHASELQ ya se debitó. Revisá GEMINI_API_KEY / GEMINI_MODEL y los logs del servidor, reintentá, o usá Forja manual sin otro settle.",
        fusionChamberHalted:
          "[ PROTOCOL_HALTED: ERROR_IN_FUSION_CHAMBER ] — Revisá saldo PHASELQ, IDs de contrato, configuración IPFS y la consola del navegador para el error concreto.",
        phaseHostContractErrors: PHASE_HOST_CONTRACT_ERRORS_ES,
        phaseHostContractUnknown: PHASE_HOST_CONTRACT_UNKNOWN_ES,
      },
      placeholders: {
        collectionName: "Cripto-Arte 2026",
        price: "5.0",
        anomaly: "Describe el artefacto a forjar…",
        manualImageUrl: "https://… o ipfs://…",
      },
    },
    chamber: {
      exit: "◄ Salir",
      market: "Mercado",
      forge: "Forja",
      sync: "Sincronizar",
      fullMarket: "Mercado completo →",
      community: "Comunidad",
      catalogLoading: "Sincronizando catálogo…",
      noCommunity: "Aún no hay colecciones de la comunidad.",
      forgeCta: "Forjar una",
      defaultPool: "Pool por defecto",
      boot: "Cámara cargando…",
      pageHeroSubtitle:
        "Pagá tokens PHASELQ para mintear tu artefacto NFT en el ledger de Stellar, luego recogelo en tu wallet.",
      operatorPanelButton: "Recompensas y recoger",
      operatorPanelHeading: "Recompensas y recoger",
      operatorPanelBackdropClose: "Cerrar panel",
      statusMonitor: "Estado",
      invalidCollectionTitle: "Colección no encontrada",
      invalidCollectionBody:
        "No hay metadata on-chain para la colección #{id}. Revisá el enlace de la forja o el ID de colección.",
      lowEnergyTitle: "Saldo insuficiente",
      reqLiqPrefix: "REQ ≥",
      wallet: "Wallet",
      offline: "— DESCONECTADO —",
      liqBalance: "Saldo PHASELQ",
      liqBalanceIssuerMismatch:
        "PHASELQ en otras líneas / emisores: {total} — para liquidar aquí solo cuenta el saldo de arriba (SAC del protocolo).",
      collectionId: "ID de colección",
      collectionIdProtocol: "0 (protocolo)",
      x402Price: "Precio de mint",
      network: "Red",
      networkValue: "Stellar Testnet",
      signalLabel: "Señal",
      classicAssetLabel: "Asset clásico",
      freighterBalanceLabel: "Saldo en wallet",
      phaseState: "Artefacto",
      nftMinted: "Acuñado",
      liquid: "Aún no acuñado",
      powerLevel: "Nivel de energía",
      linkWallet: "Conectar wallet",
      uplinking: "Conectando…",
      disconnect: "Desconectar",
      exhibitionPedestal: "PEDESTAL_EXPOSICIÓN // ACTIVO_INTELIGENTE",
      pedestalVisualShort: "Artefacto",
      chamberTechnicalDetails: "Contrato y datos on-chain",
      chamberColumnPreview: "Vista previa",
      chamberColumnInfo: "Info y recoger",
      chamberDockPreviewTicker: "Vista previa del artefacto",
      chamberDockInfoTicker: "Propiedad verificada",
      chamberDockInfoSubline: "Metadata NFT on-chain (SEP-41/SEP-50)",
      mintingTitle: "Acuñando artefacto…",
      committingLedger: "Registrando en el ledger de Stellar…",
      solidState: "On-chain",
      onChainMeta: "name() · symbol() · owner_of() · token_uri",
      stellarExpert: "Stellar Expert ↗",
      artifactAsciiView: "Vista previa del artefacto",
      syncingMeta: "Cargando colección…",
      x402MintPrice: "Precio de mint",
      protocolDefaultPool: "Pool de liquidez por defecto del protocolo",
      noImageUri: "[ SIN_URI_IMAGEN_COLECCIÓN ]",
      noImageHint: "Creador: añade imagen al forjar",
      awaitingPhase: "Pagá para mintear y revelar tu artefacto",
      theReactor: "El Reactor",
      x402StreamActive: "Pago en progreso…",
      executeX402: "Completar pago",
      executeSettlement: "Completar pago",
      initializeGenesisSupply: "⚡ Reclamar PHASELQ inicial",
      genesisSupplyLoading: "Reclamando PHASELQ inicial…",
      manualPhase: "Transición de fase manual",
      solidStateStandby: "Artefacto acuñado — listo para recoger",
      reactorClaimNftCta: "Recoger en mi wallet",
      chamberPreviewCollectCta: "Recoger",
      reactorNftSecuredHint: "Tu artefacto está en tu wallet. Podés verlo en el Dashboard.",
      reactorClaimUnavailableHint:
        "Tu artefacto está on-chain pero no se puede recoger desde aquí — no está en custodia del emisor.",
      systemLogs: "REGISTRO_SISTEMA",
      logsToggle: "Logs",
      logsClose: "Cerrar registro",
      live: "EN_VIVO",
      nodeDesyncTitle: "Conexión perdida",
      rebootProcess: "Reintentar conexión",
      collectionTitleLoading: "Colección",
      defaultChamberTitle: "PHASE Protocol — Pool por defecto",
      titleWithName: "{name} // #{id}",
      pedestalWithCreator: "{name} · CREADOR {addr}",
      pedestalLoading: "Cargando colección…",
      pedestalDefault: "Colección por defecto · Pool de liquidez central",
      collectionLine: "Colección #{id} · {name}",
      collectionLinkTitle: "Colección #{id}",
      faucetButton: "⚡ Reclamar PHASELQ",
      rewardsSectionTitle: "Recompensas",
      collectInfoPanelTitle: "Recoger — liquidez + NFT",
      reactorQuestsSectionTitle: "Quests",
      rewardsHelpAria: "Ayuda: PHASELQ y recompensas",
      rewardsHelpClose: "Cerrar",
      rewardsHelpModalTitle: "PHASELQ y recompensas",
      rewardsHelpLiqTitle: "¿Qué es LIQ?",
      rewardsHelpLiqBody:
        "LIQ es la etiqueta corta que ves en la interfaz para PHASELQ, el token de utilidad Soroban en testnet de PHASE. Sirve para pagar precios de mint (initiate_phase / liquidación x402) y para probar el reactor. Los saldos usan siete decimales como otros assets Stellar. Es liquidez de testnet, no dinero real.",
      rewardsHelpQuestsTitle: "Genesis, diaria y misiones",
      rewardsHelpQuestsBody:
        "Genesis es un fondo inicial único para wallets nuevas. La recarga diaria se reinicia cada 24 horas. Las quests son misiones de una sola vez (vincular wallet, crear colección, completar una liquidación). Las barras muestran el avance; Reclamar pide un mint firmado por el servidor cuando cumples los requisitos.",
      rewardsQuestProgress: "PROGRESO QUESTS",
      rewardsNftInWalletTitle: "En tu wallet",
      rewardsNftStellarExpertLink: "[ VER EN STELLAR EXPERT ]",
      rewardsNftCollectPanelTitle: "COLECTAR · NFT DE UTILIDAD (SEP-41/50)",
      rewardsNftCollectPanelBody:
        "Token #{tokenId}: el NFT está en custodia del emisor clásico PHASELQ ({issuerShort}…). Colectar envía transfer(emisor → tu wallet) firmado por el servidor — no hace falta firmar en la wallet. Sirve con Albedo, Freighter, xBull, etc.",
      rewardsNftNotIssuerCustodyBody:
        "Token #{tokenId}: el owner on-chain no es el emisor PHASELQ; el colectar del servidor no aplica. Usá “añadir NFT manual” en tu wallet (dirección del contrato + Token ID) si la app lo permite.",
      rewardsNftCollectButton: "COLECTAR",
      rewardsNftCollectSending: "ENVIANDO…",
      rewardsNftCollectVerifying: "Verificando NFT en el ledger…",
      rewardsNftCollectVerifyFailed: "Falló la verificación en el ledger",
      rewardsNftCollectVerifyNotMintedYet:
        "Este token aún no aparece en el contrato PHASE. Abrí Chamber, pulsá SYNC, esperá al pedestal y volvé a COLECTAR.",
      pedestalIssuerCustodyHint:
        "El NFT de utilidad sigue en custodia del emisor. Usá COLECTAR en el panel derecho (transfer firmado por el servidor a tu wallet conectada).",
      pedestalIssuerCustodyScrollLink: "Ir al panel COLECTAR ↓",
      walletNftVisibilityTitle: "¿NO VES EL NFT EN TU WALLET?",
      walletNftVisibilityBody:
        "Si tu historial de transacciones muestra un settlement exitoso (invoke settle → true), el protocolo ya minteó tu NFT en el ledger—esa es la prueba. Muchas wallets muestran transacciones Soroban en el historial pero no exhiben NFTs SEP-41/50 en la vista principal de balance. Esto no significa que el NFT se haya perdido.\n\n• Tu NFT de utilidad PHASE vive en testnet: verificado por owner_of = tu dirección en el contrato PHASE.\n• Tocá COPIAR · CONTRATO + ID abajo para pegar en \"añadir NFT manualmente\" de tu wallet (funciona con Freighter, Albedo, xBull, etc.).\n• **Dashboard PHASE → Bóveda** escanea RPC Soroban y lista todos los NFT PHASE de tu wallet (fuente de verdad).\n• **Stellar Expert** sirve para verificar owner_of, token_uri y transferencias on-chain.",
      creatorCanMint: "Creador puede mintear",
      creatorMintRule: "El creador también puede mintear esta colección (1 NFT de utilidad por wallet por colección).",
      creatorAlreadyMinted: "El creador ya minteó esta colección con esta wallet.",
      freighterManualAddTitle: "NFT_SOROBAN · AÑADIR_MANUAL (CUALQUIER_WALLET)",
      freighterManualAddBody:
        "Si no aparece en la UI de tu wallet: buscá “añadir NFT / contrato Soroban” (según versión de Albedo) o Freighter → Collectibles → Add manually.",
      freighterManualAddTroubleshoot:
        "El flujo Collectibles de Freighter puede depender de su propio backend o de un indexador público — ajeno a esta app. Si Add manually falla, usá Ping índice Freighter abajo (self-transfer sin efecto, emite evento transfer estándar), esperá y reintentá Add manually. Para mover el NFT a otra persona, copiá su dirección G de Stellar al portapapeles y usá el botón magenta de ledger (sin escribir en este panel). En PHASE, la lista autoritativa es la bóveda del dashboard (escaneo RPC Soroban) — no hace falta suscripción a Mercury para eso.",
      freighterIndexPingButton: "[ PING ÍNDICE FREIGHTER ]",
      freighterIndexPingToastOk: "Ping al índice enviado. Esperá 1–5 min y volvé a Add Collectible en Freighter.",
      freighterIndexPingToastFail: "Falló el ping al índice. Revisá la red o reintentá.",
      freighterTransferPanelTitle: "COLECTABLE · TRANSFERIR (FIRMAR EN WALLET)",
      freighterTransferClipboardButton: "TRANSFERIR NFT",
      freighterTransferClipboardBlurb:
        "Copiá la dirección G del destinatario al portapapeles y tocá TRANSFERIR NFT — la wallet firma la transferencia Soroban (mismo estilo que COLECTAR).",
      freighterTransferSigningLabel: "FIRMANDO…",
      freighterTransferClipboardReadFailed: "No se pudo leer el portapapeles. Permití pegar o volvé a copiar la dirección G.",
      freighterTransferClipboardEmpty: "El portapapeles está vacío. Copiá primero la dirección G del destinatario.",
      freighterTransferToastOk: "Transferencia de NFT enviada. Esperá confirmación en el ledger.",
      freighterTransferToastFail: "Falló la transferencia del NFT. Revisá la dirección, la red y reintentá.",
      freighterTransferInvalidRecipient: "Ingresá una dirección pública Stellar válida (G…, 56 caracteres).",
      freighterTransferSameAddress:
        "Para self-transfer usá Ping índice Freighter. Copiá otra dirección G al portapapeles para mover el NFT.",
      freighterSep50CheckButton: "[ COMPROBAR SEP-50 / FREIGHTER ]",
      freighterSep50CheckIntro:
        "Se ejecuta en nuestro servidor: name(), symbol(), owner_of, token_uri en Soroban y luego el GET del JSON. Freighter sigue usando su propio backend para auto-listar — esto solo confirma que el contrato y la URL encajan con el borrador SEP-0050.",
      freighterSep50CheckFailToast: "Falló la petición de comprobación SEP-50.",
      freighterOwnerOnChainAddBody:
        "Ya sos dueño on-chain del NFT en el contrato PHASE. Albedo suele no mostrarlo aunque el ledger sí: usá COPIAR abajo y la bóveda del Dashboard. En Freighter: Collectibles → Add manually con el mismo C… + Token ID (testnet).",
      onChainMetaNftContractLabel: "CONTRATO_NFT_PHASE",
      onChainMetaPhaselqSacLabel: "PHASELQ_SAC (fungible)",
      freighterCopyBundleButton: "[ COPIAR · CONTRATO C… + ID ]",
      freighterCopyBundleToast:
        "Copiado en 2 líneas: (1) contrato C… del NFT PHASE, (2) Token ID numérico (sin #). Pegá en tu wallet (Albedo / Freighter / etc.) o guardalo para Lab.",
      artifactSecuredLedgerVault: "Artefacto asegurado en el ledger Stellar — ver en bóveda PHASE",
      artifactLedgerBalanceContract: "CONTRACT balance() · {count} NFT(s) de utilidad atribuidos a esta wallet",
      protocolStackLabel: "Pagá con PHASELQ · Mintea en Stellar · Recolectá en tu wallet",
      tokenStandardSep41Note: "PHASELQ cumple SEP-41 (interfaz de token Soroban).",
      rewardsLiquidityLaneTitle: "ARRANQUE_LIQUIDEZ",
      rewardsMissionChainTitle: "CADENA_MISIONES_OPERADOR",
      rewardsButtonEstablishingTrustline: "Configurando trustline…",
      rewardsButtonTransmittingFunds: "Enviando fondos…",
      rewardsTokenTicker: "LIQ",
      rewardsTrustlineRejectedToast:
        "Trustline requerida para recibir fondos. Aprobá el changeTrust en tu wallet.",
      rewardsTrustlineAccountMissing:
        "La cuenta no está en testnet o sin XLM. Añadí XLM de prueba (Friendbot) antes de reclamar PHASELQ.",
      rewardsTrustlineAlbedoImplicitRequired:
        "Albedo: primero concedé permiso de firma (barra inferior o tarjeta trustline en Forge) y volvé a reclamar.",
      biometricTrustGateClosed: "Unauthorized. Please check your wallet and try again.",
      classicCollectDisabled: "No disponible aún",
      classicCollecting: "Recolectando…",
      classicAlreadyCollected: "Ya en tu wallet",
      classicAutoCollect: "Configurar y recoger +{amount} PHASELQ",
      classicCollectAsset: "Recoger +{amount} PHASELQ",
      classicRewardOptions: "Recompensas PHASELQ",
      noTrustline: "Sin configurar",
      verifyingOwner: "Verificando titularidad…",
      collectToMyWallet: "Recoger en mi wallet",
      paymentGateExplainer: "Pagá {amount} PHASELQ al Forge Agent — tu artefacto se genera y se mintea en el ledger de Stellar automáticamente.",
      phaseHostContractErrors: PHASE_HOST_CONTRACT_ERRORS_ES,
      phaseHostContractUnknown: PHASE_HOST_CONTRACT_UNKNOWN_ES,
      logs: {
        chamberOnline: "Cámara en línea — esperando wallet…",
        walletRequest: "Conectando wallet…",
        walletLinkedPrefix: "Wallet conectada:",
        walletDenied: "Conexión de wallet denegada",
        walletUnlink: "Wallet desconectada",
        systemDesync: "Conexión perdida — reconectando al nodo Stellar…",
        tracePrefix: "[ traza ]",
        runtimeFaultPrefix: "[ error ]",
        rebootProcess: "Reintentando conexión…",
        manualPhaseStart: "Fase manual — iniciando",
        detectingLiquidity: "Verificando saldo PHASELQ…",
        authorizingTx: "Autorizando transacción Soroban…",
        mintingNft: "Acuñando NFT de utilidad…",
        crystallizing: "Cristalizando identidad…",
        phaseTransitionComplete: "Transición de fase completa",
        mintConfirmedViewPedestal: "NFT acuñado — revisá el panel de artefacto",
        lowEnergyWarning: "PHASELQ insuficiente — reclamá tu recompensa diaria para continuar",
        x402Initiating: "Iniciando pago on-chain…",
        walletKitPickerForSettle:
          "Elegí una wallet para firmar el pago y recibir el NFT…",
        walletKitPickerDismissed: "Selector de wallet cerrado — pago cancelado",
        receivingChallenge: "Recibiendo desafío de pago…",
        signingAuth: "Firmando autorización…",
        settlingPayment: "Enviando pago…",
        decrypting: "Descifrando datos del artefacto…",
        x402Ok: "Pago confirmado — artefacto desbloqueado",
        forgedOnSettle: "Artefacto acuñado al pagar — revisá el pedestal",
        faucetEmitting: "Enviando recompensa PHASELQ…",
        faucetLoadingSupply: "Cargando suministro…",
        faucetOk: "PHASELQ recibido — saldo actualizado",
        faucetReceived: "+{amount} PHASELQ recibidos",
        faucetFailPrefix: "[ error faucet ]",
        genesisSupplyRequested: "Solicitando PHASELQ inicial…",
        genesisTransferComplete: "PHASELQ inicial recibido",
        classicTrustlineEstablishing: "Verificando trustline PHASELQ para recompensa…",
        classicTrustlineFreighter: "Esperando firma changeTrust en wallet…",
        classicTrustlineConfirmed: "Trustline activa — asset clásico listo",
        classicTrustlineRejected: "Firma de trustline denegada",
        classicTrustlineAccountMissing: "Cuenta no encontrada — agregá XLM testnet primero",
      },
      artifact: {
        registeredDefault: "Artefacto de utilidad PHASE",
        owner: "Propietario",
        serial: "Serie",
        powerLevel: "Nivel de energía",
        readonly: "Vista de solo lectura",
        noVisual: "Sin imagen",
        ariaLabel: "Artefacto NFT de utilidad PHASE",
        sepSuffix: "· SEP-41/50",
        dataLocked: "Bloqueado",
        contract: "Contrato",
        terminalRestricted: "Conectá tu wallet para verificar la propiedad",
        systemActive: "Propiedad verificada",
        verifying: "Verificando on-chain…",
        downloadCertificate: "Descargar certificado",
        expandPreview: "Ampliar",
        closePreview: "Cerrar",
        unverifiedCopy: "Solo vista previa",
        authenticitySealVerified: "✦ On-chain #{token} · visor:{sig}",
        accessDeniedLine: "Un pantallazo no es el NFT — conectá tu wallet para verificar",
        verifyingHint: "Verificando propiedad en el ledger de Stellar…",
        stateLiquid: "Líquido",
        stateSolid: "Sólido",
        accessPrivateMetadata: "Ver metadata privada",
        privateChannelUnlocked: "Metadata privada",
        metadataStandard: "Estándar de metadata",
        previewOnly: "Solo vista previa",
        decryptingImage: "Revelando…",
        monitorCollectionName: "Colección",
        monitorContractAddr: "Contrato",
        supplyStabilized: "Suministro",
        secretId: "Token ID",
        holderSignature: "Firma del titular",
        rawMetadata: "Metadata sin procesar",
        pendingOwnershipVerification: "Verificando propiedad…",
        imageLoadHint:
          "La imagen no cargó (CORS, gateway IPFS lento o enlace inválido). Abrí la URL en otra pestaña o probá otro gateway.",
        openImageUrl: "Abrir URL de imagen",
        chamberPreviewCollectionAddress: "Dirección de colección",
        chamberPreviewCopy: "Copiar",
        chamberPreviewTokenId: "ID de token",
      },
    },
  },
}

export function pickCopy(lang: AppLang) {
  return phaseCopy[lang]
}
