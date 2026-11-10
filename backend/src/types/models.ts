/** Row shapes matching the pre-existing `ondemand` tables + new side tables. */

export type AdminStatus = "Active" | "Inactive" | "Deleted";

/** administrators (legacy MyISAM). */
export interface AdministratorRow {
  iAdminId: number;
  iGroupId: number;
  vFirstName: string;
  vLastName: string;
  vEmail: string;
  vContactNo: string;
  vCode: string;
  vPassword: string;
  vCountry: string;
  vState: string;
  vCity: string;
  vAddress: string;
  vAddressLat: string;
  vAddressLong: string;
  fHotelServiceCharge: number;
  vPaymentEmail: string;
  vBankAccountHolderName: string;
  vAccountNumber: string;
  vBankName: string;
  vBankLocation: string;
  vBIC_SWIFT_Code: string;
  eStatus: AdminStatus;
  eDefault: "Yes" | "No";
  vPassword_token: string;
}

/** admin_groups (legacy MyISAM). */
export interface AdminGroupRow {
  iGroupId: number;
  vGroup: string;
  eStatus: AdminStatus;
}

/** admin_pro_permissions (legacy MyISAM). */
export interface PermissionRow {
  id: number;
  permission_name: string;
  name: string;
  status: AdminStatus;
  display_group_id: number;
  display_sub_group_id: number;
  display_order: number;
  vDispalyAppType: string;
  eFor: string;
  eType: "List" | "Other";
}

/** admin_pro_permission_display_groups (legacy MyISAM). */
export interface PermissionDisplayGroupRow {
  id: number;
  name: string;
  eStatus: AdminStatus;
  vDispalyAppType: string;
  eFor: string;
  display_order: number;
}

/** admin_pro_permission_display_sub_groups (legacy MyISAM). */
export interface PermissionDisplaySubGroupRow {
  id: number;
  name: string;
  eStatus: AdminStatus;
  vDispalyAppType: string;
  eFor: string;
  iGroupsId: number;
  display_order: number;
}

/** admin_pro_group_permission (legacy InnoDB). */
export interface GroupPermissionRow {
  id: number;
  group_id: number;
  permission_id: number;
}

/** admin_locations (legacy InnoDB). */
export interface AdminLocationRow {
  id: number;
  admin_id: number;
  location_id: number;
}

/** admin_password_resets. */
export interface PasswordResetRow {
  id: number;
  admin_id: number;
  token_hash: string;
  expires_at: Date;
  attempts: number;
  created_at: Date;
}

/** admin_audit_log. */
export interface AuditLogRow {
  id: number;
  event: string;
  admin_id: number | null;
  email_masked: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: Date;
}

/** admin_alerts (legacy MyISAM). */
export interface AdminAlertRow {
  iAlertId: number;
  tAlertText: string;
  iCompanyId: number;
  iDriverId: number;
  dDate: Date;
  eStatus: "Read" | "Unread";
}

/** admin_login_state (NEW side table — additive, InnoDB). */
export interface LoginStateRow {
  admin_id: number;
  failed_attempts: number;
  locked_until: Date | null;
  last_login_at: Date | null;
  last_failed_at: Date | null;
  updated_at: Date;
}

/** admin_refresh_tokens (NEW side table — additive, InnoDB). */
export interface RefreshTokenRow {
  id: number;
  admin_id: number;
  token_hash: string;
  family_id: string;
  ip: string | null;
  user_agent: string | null;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by: string | null;
  created_at: Date;
}

/** admin_admin_group (NEW side table — extra roles, additive, InnoDB). */
export interface AdminGroupAssignmentRow {
  id: number;
  admin_id: number;
  group_id: number;
  created_at: Date;
}

/** Authenticated principal attached to the request by the auth middleware. */
export interface AuthPrincipal {
  adminId: number;
  groupId: number;
  email: string;
  name: string;
  permissions: string[];
  roleIds: number[];
}
