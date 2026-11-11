// Pure lobby / friends presentation logic, kept DOM-free so it can be unit tested.

export interface RoomMap { id: string; name: string; tier: number; minGearScore: number; threat: string; entryFee?: number }

/** A matchmaking pool: players only meet others in the same one. */
export interface PoolInfo { id: 'steam' | 'bluesky' | 'direct' | 'cross'; label: string }

export interface RoomInfo {
  id: string; name: string; pool: PoolInfo; permanent: boolean;
  players: number; paused: boolean; canJoin: boolean; map: RoomMap;
}

/** How the signed-in session matchmakes: its sign-in platform, and whether cross-play is on. */
export interface Matchmaking { platform: PoolInfo; crossplay: boolean; pool: PoolInfo }

export interface Friend { handle: string; display_name: string; user_id: string; online: boolean; }

/** The always-on raid on the first map, in the player's own pool: where a join without a choice lands. */
export const OPEN_ROOM_ID = 'outskirts';

/** Keep the remembered selection only while it still exists and is joinable;
 *  otherwise fall back to the public raid on the same map (or the first map). */
export function resolveSelectedRoom(rooms: RoomInfo[], selectedId: string, mapId?: string): string {
  if (rooms.length === 0) return selectedId;
  const pick = rooms.find(r => r.id === selectedId && r.canJoin && (!mapId || r.map.id === mapId));
  if (pick) return pick.id;
  return rooms.find(r => r.permanent && r.canJoin && r.map.id === mapId)?.id ?? OPEN_ROOM_ID;
}

/** Lobbies for one map. */
export function roomsForMap(rooms: RoomInfo[], mapId: string): RoomInfo[] {
  return rooms.filter(r => r.map.id === mapId);
}

/** Lobby status line. Official (server-run) lobbies get a badge in the UI instead of text. */
export function roomStatusText(room: RoomInfo): string {
  if (room.players === 0) return 'Empty · you deploy alone';
  if (room.paused) return 'Paused by the host';
  return `Raid in progress · ${room.players} ${room.players === 1 ? 'player' : 'players'} inside`;
}

/** One line under the cross-platform switch: who you'll meet. */
export function matchmakingText(mm: Matchmaking | null): string {
  if (!mm) return 'Sign in to see who you can play with.';
  if (mm.crossplay) return 'On: you meet players from Steam, Bluesky, email and Google who also turned it on.';
  return mm.platform.id === 'direct'
    ? 'Off: you only meet players who signed in with email or Google.'
    : `Off: you only meet players who signed in with ${mm.platform.label}.`;
}

/** Online friends first, then alphabetical by handle. */
export function sortFriends(friends: Friend[]): Friend[] {
  return [...friends].sort((a, b) =>
    Number(b.online) - Number(a.online) || a.handle.toLowerCase().localeCompare(b.handle.toLowerCase()));
}

/**
 * Callsign other players see. Email-style handles (email and Google sign-ins)
 * must never leak the full address into lobbies with strangers.
 */
export function defaultCallsign(handle: string): string {
  const local = handle.includes('@') ? handle.slice(0, handle.indexOf('@')) : handle;
  const name = local.trim().slice(0, 16);
  return name || 'Operative';
}

/** Label for the signed-in chip: emails as-is, social handles with an @. */
export function accountLabel(handle: string): string {
  return handle.includes('@') ? handle : `@${handle}`;
}

export function friendsSummary(friends: Friend[]): string {
  return `${friends.filter(f => f.online).length}/${friends.length} online`;
}

/** The line under "Sign in": the ways in this server offers. Google needs server-side keys, so it is optional. */
export function signInIntro(google: boolean): string {
  const ways = google ? 'Steam, Bluesky, Google and email' : 'Steam, Bluesky and email';
  return `You need an account to play. ${ways} all sign in to the same kind of BoxHead account, and you can link more later.`;
}

/** What `/api/config` says about the server's build (all optional: older servers send none of it). */
export interface ServerInfo { version?: string; build?: string; feedbackUrl?: string; notice?: string }

/** The build line on the home screen, for bug reports: "Build 3.0.0 · abc1234". Empty when the server says nothing. */
export function buildLabel(info: ServerInfo): string {
  const version = (info.version ?? '').trim();
  const build = (info.build ?? '').trim();
  if (!version) return '';
  return build ? `Build ${version} · ${build}` : `Build ${version}`;
}

/** An absolute http(s) address, or '' for anything else: a link from server
 *  settings never becomes a `javascript:` or relative href. */
export function safeLink(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch { return ''; }
}
