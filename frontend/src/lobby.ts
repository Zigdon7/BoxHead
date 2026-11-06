// Pure lobby / friends presentation logic, kept DOM-free so it can be unit tested.

export interface RoomInfo {
  id: string; name: string; verifiedOnly: boolean; permanent: boolean;
  players: number; wave: number; gameOver: boolean; paused: boolean; canJoin: boolean;
}

export interface Friend { handle: string; display_name: string; user_id: string; online: boolean; }

export const OPEN_ROOM_ID = 'open';

/** Split the server's room list into the browser's two sections. */
export function partitionRooms(rooms: RoomInfo[]): { verified: RoomInfo[]; open: RoomInfo[] } {
  return {
    verified: rooms.filter(r => r.verifiedOnly),
    open: rooms.filter(r => !r.verifiedOnly),
  };
}

/** Keep the remembered selection only while it still exists and is joinable. */
export function resolveSelectedRoom(rooms: RoomInfo[], selectedId: string): string {
  if (rooms.length === 0) return selectedId;
  return rooms.some(r => r.id === selectedId && r.canJoin) ? selectedId : OPEN_ROOM_ID;
}

/** Lobby status line. Official (server-run) lobbies get a badge in the UI instead of text. */
export function roomStatusText(room: RoomInfo): string {
  if (room.players === 0) return 'Waiting for players';
  if (room.gameOver) return 'Overrun · waiting for a restart';
  if (room.paused) return `Paused · Wave ${room.wave}`;
  return `In progress · Wave ${room.wave}`;
}

export function verifyStatusText(verified: boolean, clientThinksSignedIn: boolean): string {
  if (verified) return 'Verified account. You can join every lobby.';
  return clientThinksSignedIn
    ? 'Your session has expired. Sign in again to join verified lobbies.'
    : 'Playing as a guest. Sign in to join verified lobbies.';
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
