import { timingSafeEqual } from 'node:crypto';

/**
 * The board page's cookie. Agents, the CLI and plain HTTP clients never receive it, so this cookie — not
 * an actor string — decides who may act as the human.
 */
export const BOARD_COOKIE = 'hud_board';

/** The Set-Cookie value that hands the board page its identity for this server process. */
export function boardCookie(token: string): string {
  return `${BOARD_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`;
}

/** One cookie value out of a `Cookie` header. */
export function cookieOf(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== name) continue;
    return part.slice(at + 1).trim();
  }
  return undefined;
}

/** Constant-time compare of the board cookie against this process's token. */
export function isBoardRequest(header: string | undefined, token: string): boolean {
  const value = cookieOf(header, BOARD_COOKIE);
  if (!value || value.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(token));
}

/**
 * `user` is the human at the board page. Any other caller — MCP, the CLI, a probe, a plain HTTP script —
 * must name itself, because an actor string is a claim, not an identity.
 */
export function actorAllowed(actor: string, board: boolean): boolean {
  return actor !== 'user' || board;
}
