// An organisation's short name (its slug) from its name: lower case, accents dropped, words
// joined by single hyphens, at most 63 characters, as the server's slug rule allows.

export function slugOf(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
}
