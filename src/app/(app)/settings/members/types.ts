export interface InviteState {
  error?: string;
  /** Set on success — the one-time invite link to copy and share. */
  link?: string;
  /** Email the link was created for, for display alongside the link. */
  email?: string;
}

export interface ResetLinkState {
  error?: string;
  /** Set on success — the one-time password-reset link to copy and hand off. */
  link?: string;
}

export interface CreateTeamState {
  error?: string;
  success?: boolean;
}
