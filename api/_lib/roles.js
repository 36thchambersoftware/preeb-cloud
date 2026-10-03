/**
 * Shared PREEB delegator role model (the bear ladder).
 * Mirrors DELEGATOR_ROLES in profile.js — keep the two in sync.
 */

const DELEGATOR_ROLES = [
  { name: '@Delegator',    thresholdAda: 1 },
  { name: '@PANDA',        thresholdAda: 500 },
  { name: '@BLACK BEAR',   thresholdAda: 1000 },
  { name: '@GRIZZLY BEAR', thresholdAda: 2500 },
  { name: '@POLAR BEAR',   thresholdAda: 5000 },
  { name: '@CARE BEAR',    thresholdAda: 50000 },
];

/**
 * Returns the highest role unlocked for a lovelace amount, or null when
 * below the lowest threshold (less than 1 ADA).
 */
export function getRoleForLovelace(lovelace) {
  const amount = typeof lovelace === 'bigint' ? lovelace : BigInt(String(lovelace || '0'));
  let best = null;
  for (const role of DELEGATOR_ROLES) {
    if (amount >= BigInt(role.thresholdAda) * 1_000_000n) best = role;
  }
  return best;
}

export function getRoleSummary(counts) {
  return DELEGATOR_ROLES
    .filter((role) => role.name !== '@Delegator')
    .map((role) => ({ role: role.name, count: counts[role.name] || 0 }));
}

export { DELEGATOR_ROLES };
