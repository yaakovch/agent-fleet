/** A stale-revision rejection confirms that creation did not execute. */
export async function retryStaleSessionCreation<T>(
  create: (key: string) => Promise<T>,
  refresh: () => Promise<unknown>,
  initialKey: string,
  newKey: () => string
): Promise<T> {
  try {
    return await create(initialKey);
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'stale_revision') throw error;
    await refresh();
    // expectedRevision changes the request hash. A safely rejected operation
    // needs a new key; uncertain outcomes must keep their original identity.
    return create(newKey());
  }
}
