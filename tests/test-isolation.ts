type MaybePromise<T> = T | PromiseLike<T>;

let previousTest: Promise<void> = Promise.resolve();

/**
 * Bun can execute test files concurrently in one process. Hold this lock for
 * tests that change process-wide state, while leaving unrelated tests parallel.
 */
export async function withTestIsolation<T>(
  names: readonly string[],
  callback: () => MaybePromise<T>,
): Promise<T> {
  const waitFor = previousTest;
  let release!: () => void;
  previousTest = new Promise<void>((resolve) => {
    release = resolve;
  });
  await waitFor;

  const original = new Map(names.map((name) => [name, process.env[name]]));
  try {
    return await callback();
  } finally {
    for (const name of names) {
      const value = original.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    release();
  }
}
