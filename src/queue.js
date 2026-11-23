/**
 * Build the rating queue: manifest order, minus rated ids, with each series'
 * episodes re-sorted by `ep` into the slots that series occupies.
 */
export function buildQueue(videos, ratedIds) {
  const pending = videos.filter((v) => !ratedIds.has(v.id));
  const bySeries = new Map();
  for (const v of pending) {
    if (!v.series) continue;
    if (!bySeries.has(v.series)) bySeries.set(v.series, []);
    bySeries.get(v.series).push(v);
  }
  for (const list of bySeries.values()) list.sort((a, b) => (a.ep ?? 0) - (b.ep ?? 0));
  const cursor = new Map();
  return pending.map((v) => {
    if (!v.series) return v.id;
    const i = cursor.get(v.series) ?? 0;
    cursor.set(v.series, i + 1);
    return bySeries.get(v.series)[i].id;
  });
}

/**
 * Skip: move `id` to the end. For a series episode, its later queued episodes
 * move with it (in order) so episodes are never shown out of order.
 */
export function skipInQueue(queue, id, byId) {
  const v = byId.get(id);
  let moving = [id];
  if (v?.series) {
    moving = queue.filter((q) => {
      const o = byId.get(q);
      return o?.series === v.series && (o.ep ?? 0) >= (v.ep ?? 0);
    });
    moving.sort((a, b) => (byId.get(a).ep ?? 0) - (byId.get(b).ep ?? 0));
  }
  const set = new Set(moving);
  return [...queue.filter((q) => !set.has(q)), ...moving];
}
