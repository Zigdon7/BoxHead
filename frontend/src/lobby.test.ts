import { describe, expect, it } from 'vitest';
import {
  RoomInfo, Friend, OPEN_ROOM_ID, partitionRooms, resolveSelectedRoom, roomStatusText,
  verifyStatusText, sortFriends, friendsSummary, defaultCallsign, accountLabel,
} from './lobby';

function room(overrides: Partial<RoomInfo> = {}): RoomInfo {
  return {
    id: 'r1', name: 'Room', verifiedOnly: false, permanent: false,
    players: 0, wave: 1, gameOver: false, paused: false, canJoin: true,
    ...overrides,
  };
}

function friend(handle: string, online: boolean): Friend {
  return { handle, display_name: handle, user_id: `id-${handle}`, online };
}

describe('partitionRooms', () => {
  it('splits verified and open lobbies, preserving server order', () => {
    const rooms = [
      room({ id: 'open', permanent: true }),
      room({ id: 'verified', verifiedOnly: true, permanent: true }),
      room({ id: 'a' }),
      room({ id: 'b', verifiedOnly: true }),
    ];
    const { verified, open } = partitionRooms(rooms);
    expect(verified.map(r => r.id)).toEqual(['verified', 'b']);
    expect(open.map(r => r.id)).toEqual(['open', 'a']);
  });

  it('handles an empty list', () => {
    expect(partitionRooms([])).toEqual({ verified: [], open: [] });
  });
});

describe('resolveSelectedRoom', () => {
  const rooms = [
    room({ id: OPEN_ROOM_ID }),
    room({ id: 'locked', verifiedOnly: true, canJoin: false }),
    room({ id: 'mine' }),
  ];

  it('keeps a joinable selection', () => {
    expect(resolveSelectedRoom(rooms, 'mine')).toBe('mine');
  });

  it('falls back to the open arena when the selection is locked for this user', () => {
    expect(resolveSelectedRoom(rooms, 'locked')).toBe(OPEN_ROOM_ID);
  });

  it('falls back when the remembered lobby has been shut down', () => {
    expect(resolveSelectedRoom(rooms, 'expired-lobby')).toBe(OPEN_ROOM_ID);
  });

  it('leaves the selection alone before the list has loaded', () => {
    expect(resolveSelectedRoom([], 'mine')).toBe('mine');
  });
});

describe('roomStatusText', () => {
  it('describes empty lobbies', () => {
    expect(roomStatusText(room())).toBe('0 online · empty');
  });

  it('shows the live wave for active lobbies', () => {
    expect(roomStatusText(room({ players: 3, wave: 7 }))).toBe('3 online · wave 7');
  });

  it('prioritises overrun over paused', () => {
    expect(roomStatusText(room({ players: 2, gameOver: true, paused: true }))).toBe('2 online · overrun');
    expect(roomStatusText(room({ players: 2, paused: true }))).toBe('2 online · paused');
  });

  it('marks official server-run lobbies', () => {
    expect(roomStatusText(room({ permanent: true }))).toBe('0 online · empty · official');
  });
});

describe('verifyStatusText', () => {
  it('confirms verified accounts', () => {
    expect(verifyStatusText(true, true)).toMatch(/Verified account/);
  });

  it('explains guests are unverified', () => {
    expect(verifyStatusText(false, false)).toMatch(/guest/);
  });

  it('flags a stale session the server no longer accepts', () => {
    expect(verifyStatusText(false, true)).toMatch(/session has expired/);
  });
});

describe('friends', () => {
  it('sorts online friends first, then case-insensitively by handle', () => {
    const sorted = sortFriends([
      friend('zed', false), friend('Bob', true), friend('amy', false), friend('carl', true),
    ]);
    expect(sorted.map(f => f.handle)).toEqual(['Bob', 'carl', 'amy', 'zed']);
  });

  it('does not mutate the input list', () => {
    const list = [friend('b', false), friend('a', true)];
    sortFriends(list);
    expect(list.map(f => f.handle)).toEqual(['b', 'a']);
  });

  it('summarises online counts', () => {
    expect(friendsSummary([])).toBe('0/0 online');
    expect(friendsSummary([friend('a', true), friend('b', false)])).toBe('1/2 online');
  });
});

describe('callsigns', () => {
  it('never exposes an email address to other players', () => {
    expect(defaultCallsign('jane.doe@example.com')).toBe('jane.doe');
    expect(defaultCallsign('someone-with-a-long-name@example.com')).toBe('someone-with-a-l');
  });

  it('keeps social handles, bounded to the server limit', () => {
    expect(defaultCallsign('pilot.bsky.social')).toBe('pilot.bsky.socia');
    expect(defaultCallsign('ace')).toBe('ace');
  });

  it('falls back when nothing usable remains', () => {
    expect(defaultCallsign('@example.com')).toBe('Operative');
    expect(defaultCallsign('   ')).toBe('Operative');
  });

  it('labels the account chip without a double @', () => {
    expect(accountLabel('me@example.com')).toBe('me@example.com');
    expect(accountLabel('me.bsky.social')).toBe('@me.bsky.social');
  });
});
