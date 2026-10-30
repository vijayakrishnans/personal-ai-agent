// What `cloudflare:workers` gives a Durable Object, and no more: its state
// and its env, as the runtime's base class keeps them.
export class DurableObject<E = unknown> {
  protected ctx: DurableObjectState;
  protected env: E;
  constructor(ctx: DurableObjectState, env: E) {
    this.ctx = ctx;
    this.env = env;
  }
}
