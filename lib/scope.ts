// ideas/generations/posts carry no brand_id (spec §2) — they are scoped
// through the brand's categories. An empty key list means the brand owns no
// categories, which must produce an empty result rather than an unfiltered
// one; a `keys.length ? filter : items` shortcut would invert exactly that.
export function scopeToCategoryKeys<T extends { category_key: string }>(
  items: T[],
  keys: string[],
): T[] {
  const allowed = new Set(keys);
  return items.filter((i) => allowed.has(i.category_key));
}
