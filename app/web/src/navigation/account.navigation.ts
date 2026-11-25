// The person's own pages (the profile menu), and the homes of what the workspace frame and the
// pages before sign-in call: neither is a sidebar section, but each capability still has one.

import type { RouteName } from '../api/client.api.ts';
import type { Place } from './types.navigation.ts';

export const ACCOUNT: readonly Place[] = [
  {
    id: 'profile', label: 'Profile', href: '/account/profile/', icon: 'user', purpose: 'Your name, email and password.',
    does: ['See your name and email', 'Change your password'], keywords: ['password', 'name', 'email'],
    routes: ['changeOwnPassword'],
  },
  {
    id: 'security', label: 'Security', href: '/account/security/', icon: 'lock', purpose: 'How you sign in: second factors, security keys and linked identities.',
    does: ['Add an authenticator app or security key', 'Remove a second factor', 'Link and unlink sign-in identities'], keywords: ['mfa', '2fa', 'totp', 'passkey', 'webauthn', 'security key'],
    routes: ['listMfaFactors', 'removeMfaFactor', 'startTotpEnrolment', 'confirmTotpEnrolment', 'startSecurityKeyRegistration', 'confirmSecurityKeyRegistration',
      'listIdentities', 'unlinkIdentity', 'startSsoLink'],
  },
  {
    id: 'devices', label: 'Notifications and devices', href: '/account/devices/', icon: 'bell', purpose: 'Where Silo sends your notifications.',
    does: ['See and remove the devices that receive push notifications', 'Allow notifications in this browser'], keywords: ['push', 'mobile'],
    routes: ['listPushDevices', 'registerPushDevice', 'removePushDevice'],
  },
  {
    id: 'allowance', label: 'Allowance', href: '/account/allowance/', icon: 'chart', purpose: 'How much of today\'s model allowance you have used.',
    does: ['See your daily allowance and use'], keywords: ['tokens', 'ai usage', 'limit'],
    routes: ['readOwnAllowance'],
  },
  {
    id: 'organisations', label: 'Organisations', href: '/account/organisations/', icon: 'building', purpose: 'The organisations you belong to.',
    does: ['Switch organisation'], keywords: ['switch', 'tenant', 'workspace'],
    routes: ['listMyMemberships', 'switchMembership'],
  },
];

/** The workspace frame: what every page shows (who, where, what may be used, notifications, search). */
export const FRAME_ROUTES: readonly RouteName[] = [
  'currentSession', 'readOwnProfile', 'readMyPermissions', 'listMyPermittedScopes', 'readRail', 'readPreferences', 'updatePreferences', 'getResidency',
  'readOrganisationLogo', 'signOut', 'signOutWithProvider', 'recordWorkspaceInteraction',
  'listNotifications', 'readNotification', 'markNotificationRead', 'acknowledgeNotification', 'readDirectory',
];

/** Before sign-in: signing in, its second step, signing up, resetting a password, accepting an invitation. */
export const ENTRY_ROUTES: readonly RouteName[] = [
  'signIn', 'verifyMfa', 'signInOptions', 'startSignInBySso', 'completeOidc', 'completeSaml', 'startSecurityKeyAssertion', 'verifySecurityKeyAssertion',
  'requestPasswordReset', 'resetPassword', 'acceptInvitation', 'startSignup', 'completeSignup',
];
