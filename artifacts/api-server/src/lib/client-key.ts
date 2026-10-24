import { isIP } from "node:net";
import { ipKeyGenerator } from "express-rate-limit";

/**
 * H-D17: the one key every rate limiter in this API counts by.
 *
 * Render serves this API behind Cloudflare: live responses carry
 * `server: cloudflare` and a `cf-ray` id. Behind it, `req.ip` is right only if
 * `trust proxy` matches a hop count Render does not publish. Correction, 23 Oct
 * 2026: a probe that seemed to show `trust proxy 1` gave each request a new key
 * (three reads of `remaining=9`) was confounded - the prober's own outgoing
 * address changed on every request. Whether the old key was right is unknown.
 * Keying on Cloudflare's header removes the dependence on the hop count.
 *
 * Cloudflare writes the connecting client's address into CF-Connecting-IP on
 * every request it proxies, replacing any value the client sent. That is the
 * address counted here. The hop count behind it is not published by Render, so
 * it is not guessed with a larger `trust proxy` number.
 *
 * Absent or not an IP address (a direct request in tests or local dev), the key
 * is `req.ip`, which is what the limiters used before this block. That fallback
 * is not proof the header arrives in production: the gate's live probe is.
 *
 * `ipKeyGenerator` groups an IPv6 address by its /56, so one host cannot rotate
 * through its own subnet to reset the count.
 */
export function clientKey(req: { get(name: string): string | undefined; ip?: string }): string {
  const forwarded = req.get("cf-connecting-ip")?.trim();
  if (forwarded && isIP(forwarded)) return ipKeyGenerator(forwarded);
  if (req.ip) return ipKeyGenerator(req.ip);
  // No address at all (a socket closed before the request was read). These
  // share one bucket rather than each getting an unlimited one.
  return "no-address";
}
