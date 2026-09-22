import { admitGlobal, loadGuardConfig } from "./guard";
import { errorResponse, HttpError } from "./http";

const COUNT_KEY = "connections";

/**
 * Per-user socket count across conversation objects.
 * The conversation object still caps its own sockets; this only rejects a user
 * who has too many open chats at once.
 */
export class UserGate implements DurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("not found", { status: 404 });
    const path = new URL(request.url).pathname;
    if (path === "/reserve") return this.reserve();
    if (path === "/release") return this.release();
    return new Response("not found", { status: 404 });
  }

  private async reserve(): Promise<Response> {
    const max = loadGuardConfig(this.env).maxWsPerUserGlobal;
    const count = (await this.ctx.storage.get<number>(COUNT_KEY)) ?? 0;
    const decision = admitGlobal(count, max);
    if (!decision.ok) {
      return errorResponse(new HttpError(429, "too many connections", { retryAfter: decision.retryAfterSeconds }));
    }
    await this.ctx.storage.put(COUNT_KEY, count + 1);
    return new Response(null, { status: 204 });
  }

  private async release(): Promise<Response> {
    const count = (await this.ctx.storage.get<number>(COUNT_KEY)) ?? 0;
    await this.ctx.storage.put(COUNT_KEY, Math.max(0, count - 1));
    return new Response(null, { status: 204 });
  }
}
