/**
 * Where party members are when the party splits. Two characters are together
 * when their places match, so spelling must not matter: "The sewer outflow",
 * "the sewer outflow." and "  the Sewer  Outflow " are one place.
 */
export const placeKey = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:the|a|an)\s+/, '');
