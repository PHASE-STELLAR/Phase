import { incSecurityCounter } from "@/lib/security-counters"

export type AdminAction =
  | "feature_flag_toggle"
  | "feature_flag_kill_switch"
  | "quest_create"
  | "quest_delete"
  | "webhook_test"
  | "wallet_allowlist"
  | "wallet_denylist"

export type AdminAuditEntry = {
  id: string
  action: AdminAction
  operator: string
  timestamp: number
  resourceId: string
  resourceType: string
  reason?: string
  confirmed: boolean
  success: boolean
  error?: string
}

export interface AdminConsoleSurface {
  operator: string
  actions: AdminAction[]
  auditLog: AdminAuditEntry[]
  stats: {
    totalActions: number
    successCount: number
    failureCount: number
  }
}

const auditEntries: AdminAuditEntry[] = []

export function isDestructiveAction(action: AdminAction): boolean {
  return [
    "feature_flag_kill_switch",
    "quest_delete",
    "wallet_denylist",
  ].includes(action)
}

export function requiresConfirmation(action: AdminAction): boolean {
  return isDestructiveAction(action)
}

export function auditAdminAction(entry: AdminAuditEntry): void {
  auditEntries.push(entry)
  incSecurityCounter(`admin_action_${entry.action}`)
  if (!entry.success) {
    incSecurityCounter(`admin_action_${entry.action}_failed`)
  }
}

export function getAuditLog(limit: number = 100): AdminAuditEntry[] {
  return auditEntries.slice(-limit)
}

export function getOperatorStats(operator: string): {
  total: number
  success: number
  failure: number
  recentActions: AdminAuditEntry[]
} {
  const operatorActions = auditEntries.filter((e) => e.operator === operator)
  return {
    total: operatorActions.length,
    success: operatorActions.filter((e) => e.success).length,
    failure: operatorActions.filter((e) => !e.success).length,
    recentActions: operatorActions.slice(-10),
  }
}

export function validateAdminAction(action: AdminAction, operator: string): {
  valid: boolean
  error?: string
} {
  if (!operator || operator.length === 0) {
    return { valid: false, error: "Invalid operator identity" }
  }
  if (!action || action.length === 0) {
    return { valid: false, error: "Invalid action" }
  }
  return { valid: true }
}

export const ADMIN_EN_STRINGS = {
  feature_flag_toggle: "Toggle Feature Flag",
  feature_flag_kill_switch: "Activate Kill Switch (Destructive)",
  quest_create: "Create Quest",
  quest_delete: "Delete Quest (Destructive)",
  webhook_test: "Test Webhook",
  wallet_allowlist: "Add to Allowlist",
  wallet_denylist: "Add to Denylist (Destructive)",
  confirmation_required: "This action is destructive and requires confirmation.",
  audit_trail: "Audit Trail",
}

export const ADMIN_ES_STRINGS = {
  feature_flag_toggle: "Alternar Bandera de Características",
  feature_flag_kill_switch: "Activar Interruptor de Parada (Destructivo)",
  quest_create: "Crear Búsqueda",
  quest_delete: "Eliminar Búsqueda (Destructiva)",
  webhook_test: "Probar Webhook",
  wallet_allowlist: "Agregar a Lista Permitida",
  wallet_denylist: "Agregar a Lista Denegada (Destructiva)",
  confirmation_required: "Esta acción es destructiva y requiere confirmación.",
  audit_trail: "Pista de Auditoría",
}
