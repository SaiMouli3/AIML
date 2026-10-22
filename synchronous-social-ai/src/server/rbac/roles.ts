export const ROLES = [
  "owner",
  "admin",
  "marketing_manager",
  "creator",
  "approver",
  "analyst",
  "agency_operator",
  "auditor",
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Workspace owner",
  admin: "Admin",
  marketing_manager: "Marketing manager",
  creator: "Creator / operator",
  approver: "Approver",
  analyst: "Analyst",
  agency_operator: "Agency operator",
  auditor: "Auditor",
};

export const PERMISSIONS = [
  "workspace.manage",
  "workspace.kill_switch",
  "members.manage",
  "brain.read",
  "brain.write",
  "content.read",
  "content.write",
  "media.generate",
  "approvals.read",
  "approvals.request",
  "approvals.decide.tier3",
  "approvals.decide.tier4",
  "integrations.read",
  "integrations.manage",
  "campaigns.read",
  "campaigns.write",
  "inbox.read",
  "inbox.reply",
  "automations.read",
  "automations.manage",
  "analytics.read",
  "audit.read",
  "agents.run",
  "agents.manage",
  "usage.read",
  "operations.manage",
  /** API keys, models and prices. Owner only: keys can spend money and see every prompt. */
  "ai.configure",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = new Set<Permission>(PERMISSIONS);
const READ: Permission[] = [
  "brain.read",
  "content.read",
  "approvals.read",
  "integrations.read",
  "campaigns.read",
  "analytics.read",
  "automations.read",
];
const MAKER: Permission[] = [
  ...READ,
  "brain.write",
  "content.write",
  "media.generate",
  "approvals.request",
  "inbox.read",
  "inbox.reply",
  "agents.run",
  "campaigns.write",
];

const MATRIX: Record<Role, Set<Permission>> = {
  owner: ALL,
  admin: new Set(PERMISSIONS.filter((p) => p !== "ai.configure")),
  marketing_manager: new Set([...MAKER, "approvals.decide.tier3", "usage.read"]),
  creator: new Set(MAKER.filter((p) => p !== "brain.write" && p !== "campaigns.write")),
  approver: new Set([...READ, "inbox.read", "approvals.decide.tier3", "approvals.decide.tier4"]),
  analyst: new Set([...READ, "usage.read"]),
  agency_operator: new Set(MAKER),
  auditor: new Set([...READ, "audit.read", "usage.read"]),
};
// Owners and admins share permissions except AI keys/models/costs (owner only); only an owner can grant
// or remove the owner role (assignableRoles).

export function can(role: Role | string, permission: Permission): boolean {
  return MATRIX[role as Role]?.has(permission) ?? false;
}

export function permissionsFor(role: Role): Permission[] {
  return [...(MATRIX[role] ?? [])];
}

export const isRole = (r: string): r is Role => (ROLES as readonly string[]).includes(r);

/** Roles a member may assign: nobody can grant a role more powerful than their own. */
export function assignableRoles(actor: Role): Role[] {
  if (actor === "owner") return [...ROLES];
  if (actor === "admin") return ROLES.filter((r) => r !== "owner");
  return [];
}
