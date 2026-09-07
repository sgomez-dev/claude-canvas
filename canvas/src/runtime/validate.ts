export const IDENT_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class InvalidIdentifierError extends Error {
  constructor(field: string) {
    super(
      `Invalid ${field}: must match ${IDENT_RE.source}. ` +
        `Letters, digits, underscore and hyphen only, 1-64 characters.`
    );
    this.name = "InvalidIdentifierError";
  }
}

export function assertIdent(field: string, value: string): string {
  if (!IDENT_RE.test(value)) throw new InvalidIdentifierError(field);
  return value;
}
