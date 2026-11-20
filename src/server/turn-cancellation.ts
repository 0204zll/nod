const operations = new Map<string, Set<AbortController>>();

export async function withTurnCancellation<T>(
  turnIds: string | Iterable<string>,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const sources = [...new Set(typeof turnIds === 'string' ? [turnIds] : turnIds)].map((id) => {
    const active = operations.get(id) ?? new Set<AbortController>();
    operations.set(id, active);
    active.add(controller);
    return { id, active };
  });
  try {
    return await operation(controller.signal);
  } finally {
    for (const { id, active } of sources) {
      active.delete(controller);
      if (!active.size) operations.delete(id);
    }
  }
}

export function cancelTurnOperations(turnIds: Iterable<string> = operations.keys()) {
  for (const id of turnIds) for (const controller of operations.get(id) ?? []) controller.abort();
}
