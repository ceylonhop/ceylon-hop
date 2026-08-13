// D-A / spec §3.1: margin is stripped from the wire response unless the caller has
// margin:view (founder only) — finance/ops price customers without ever seeing cost.
// Hot zones (D9): the founder-only "Ella premium +15%" annotation rides in a line item's
// meta.hotZone. It's a margin-class disclosure — WHY a price is elevated — so it must be stripped
// for any role without margin:view, exactly like marginCents. Returns meta with hotZone removed
// (undefined when there was no other meta), leaving every other meta field intact.
export function stripZoneMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta || !('hotZone' in meta)) return meta;
  const rest = { ...meta };
  delete rest.hotZone;
  return Object.keys(rest).length ? rest : undefined;
}
