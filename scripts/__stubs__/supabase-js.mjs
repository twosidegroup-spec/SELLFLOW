/**
 * Stub for `@supabase/supabase-js`.
 *
 * Records every RPC the app makes and answers from a script the test sets. This
 * is what lets the outbox test assert on the *actual* calls the real code
 * issues -- arguments, ordering, and how it reacts to each failure mode --
 * without a network or a database.
 */

export const calls = [];

/**
 * Queue of behaviours, consumed in order. Each is either a function
 * `(args) => ({ data, error })` or a plain result object.
 * When the queue is empty the default is success.
 */
let behaviours = [];
let defaultBehaviour = () => ({ data: 'ok', error: null });

export const __resetSupabaseStub = () => {
  calls.length = 0;
  behaviours = [];
  defaultBehaviour = () => ({ data: 'ok', error: null });
};

export const __queueRpc = (behaviour) => {
  behaviours.push(behaviour);
};

export const __setDefaultRpc = (behaviour) => {
  defaultBehaviour = behaviour;
};

/**
 * The options object the real `@/lib/supabase` passed to `createClient`.
 *
 * The session-persistence test asserts on this rather than on behaviour alone:
 * whether auth-js actually USES the storage adapter is decided inside the real
 * package, so the test has to inspect the value handed over rather than trust a
 * round trip through a stub.
 */
let clientOptions = null;

export const __resetClientOptions = () => {
  clientOptions = null;
};

export const __lastClientOptions = () => clientOptions;

/** Names of the RPCs in the order the app called them. */
export const __rpcNames = () => calls.map((call) => call.name);

/** Full call records for one RPC, so a test can assert on the arguments. */
export const __callsOf = (name) => calls.filter((call) => call.name === name);

const buildClient = () => ({
  auth: {
    getSession: async () => ({ data: { session: null }, error: null }),
    signInWithPassword: async () => ({ data: {}, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  },
  rpc: async (name, args) => {
    calls.push({ name, args });
    const behaviour = behaviours.length > 0 ? behaviours.shift() : defaultBehaviour;
    return typeof behaviour === 'function' ? behaviour(args) : behaviour;
  },
  from: () => ({
    select: () => ({
      single: async () => ({ data: null, error: null }),
      order: () => ({ range: async () => ({ data: [], error: null }) }),
    }),
  }),
});

const createClientWithCapture = (url, key, options) => {
  clientOptions = options ?? null;
  return buildClient();
};

export const createClient = createClientWithCapture;
export default { createClient: createClientWithCapture };
