export function memoize<T extends {}>(fn: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= fn());
}
