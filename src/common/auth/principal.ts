/**
 * The authenticated caller. `dealershipId` is the tenant boundary and comes **only** from the
 * token — never from the request body or a query param (§7, §14). Everything downstream scopes
 * to this value, which is what makes "out-of-tenant reference → 404" true by construction.
 */
export interface Principal {
  readonly dealershipId: string;
  readonly role: PrincipalRole;
  /** Present only for CUSTOMER principals; restricts reads to their own rows (§14 RBAC). */
  readonly customerId?: string;
  readonly subject: string;
}

export const PrincipalRole = {
  /** Service advisor / manager — may act on all appointments in their dealership. */
  STAFF: 'STAFF',
  /** Self-service customer — further restricted to their own rows. */
  CUSTOMER: 'CUSTOMER',
} as const;

export type PrincipalRole = (typeof PrincipalRole)[keyof typeof PrincipalRole];

export const PRINCIPAL_REQUEST_KEY = 'principal' as const;
