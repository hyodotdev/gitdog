export const CURRENT_TERMS_VERSION = "2026-11-03";
export const CURRENT_PRIVACY_POLICY_VERSION = "2026-11-03";
export const LEGAL_POLICY_VERSION_MISMATCH_CODE =
  "LEGAL_POLICY_VERSION_MISMATCH";

const LEGAL_POLICY_VERSION_PATTERN =
  /^([1-9]\d{3})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

type LegalAttestation = {
  minimumAgeAttestedAt?: number;
  professionalUseAttestedAt?: number;
  termsAcceptedVersion?: string;
  privacyPolicyAcceptedVersion?: string;
};

function isValidAttestationTimestamp(value: number | undefined): boolean {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** Policy versions are exact calendar dates so lexical order is chronological. */
export function isValidLegalPolicyVersion(value: string): boolean {
  const match = LEGAL_POLICY_VERSION_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= daysInMonth[month - 1];
}

export function canAcceptDisplayedLegalPolicyVersion(
  displayedVersion: string,
  currentVersion: string,
): boolean {
  return (
    isValidLegalPolicyVersion(displayedVersion) &&
    isValidLegalPolicyVersion(currentVersion) &&
    displayedVersion === currentVersion
  );
}

export function hasCurrentLegalAttestation(
  attestation: LegalAttestation | null | undefined,
): boolean {
  if (!attestation) {
    return false;
  }

  return (
    isValidAttestationTimestamp(attestation.minimumAgeAttestedAt) &&
    isValidAttestationTimestamp(attestation?.professionalUseAttestedAt) &&
    attestation.termsAcceptedVersion === CURRENT_TERMS_VERSION &&
    attestation.privacyPolicyAcceptedVersion === CURRENT_PRIVACY_POLICY_VERSION
  );
}

export function requiresCurrentLegalAttestation(
  attestation: LegalAttestation | null | undefined,
): boolean {
  return !hasCurrentLegalAttestation(attestation);
}

export function satisfiesCurrentLegalAttestationRequirement(
  attestation: LegalAttestation | null | undefined,
): boolean {
  return !requiresCurrentLegalAttestation(attestation);
}
