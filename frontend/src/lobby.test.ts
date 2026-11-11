import { describe, expect, it } from 'vitest';
import {
  RoomInfo, Friend, Matchmaking, OPEN_ROOM_ID, resolveSelectedRoom, roomStatusText, roomsForMap,
  matchmakingText, sortFriends, friendsSummary, defaultCallsign, accountLabel, buildLabel, safeLink, signInIntro,
} from './lobby';

function room(overrides: Partial<RoomInfo> = {}): RoomInfo {
  return {
    id: 'r1', name: 'Room', pool: { id: 'steam', label: 'Steam' }, permanent: false,
    players: 0, paused: false, canJoin: true,
    map: { id: 'outskirts', name: 'Outskirts', tier: 1, minGearScore: 0, threat: 'Low' },
    ...overrides,
  };
}

function friend(handle: string, online: boolean): Friend {
  return { handle, display_name: handle, user_id: `id-${handle}`, online };
}

describe('resolveSelectedRoom', () => {
  const rooms = [
    room({ id: OPEN_ROOM_ID }),
    room({ id: 'locked', pool: { id: 'cross', label: 'Cross-platform' }, canJoin: false }),
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
  it('describes empty raids', () => {
    expect(roomStatusText(room())).toBe('Empty · you deploy alone');
    expect(roomStatusText(room({ permanent: true }))).toBe('Empty · you deploy alone');
  });

  it('counts operators in a live raid', () => {
    expect(roomStatusText(room({ players: 1 }))).toBe('Raid in progress · 1 player inside');
    expect(roomStatusText(room({ players: 3 }))).toBe('Raid in progress · 3 players inside');
  });

  it('shows a host pause', () => {
    expect(roomStatusText(room({ players: 2, paused: true }))).toBe('Paused by the host');
  });
});

describe('roomsForMap / map fallback', () => {
  const rust = { id: 'rustyard', name: 'Rust Yard', tier: 2, minGearScore: 20, threat: 'Moderate' };
  const rooms = [
    room({ id: 'outskirts', permanent: true }),
    room({ id: 'rustyard', permanent: true, map: rust }),
    room({ id: 'rust-mine', map: rust }),
  ];
  it('filters lobbies to one map', () => {
    expect(roomsForMap(rooms, 'rustyard').map(r => r.id)).toEqual(['rustyard', 'rust-mine']);
  });
  it('falls back to the public raid on the chosen map', () => {
    expect(resolveSelectedRoom(rooms, 'outskirts', 'rustyard')).toBe('rustyard');
    expect(resolveSelectedRoom(rooms, 'rust-mine', 'rustyard')).toBe('rust-mine');
  });
});

describe('matchmakingText', () => {
  const pool = (id: 'steam' | 'bluesky' | 'direct' | 'cross', label: string) => ({ id, label });
  const mm = (platform: ReturnType<typeof pool>, crossplay: boolean): Matchmaking =>
    ({ platform, crossplay, pool: crossplay ? pool('cross', 'Cross-platform') : platform });

  it('names the platform you are limited to', () => {
    expect(matchmakingText(mm(pool('steam', 'Steam'), false))).toBe('Off: you only meet players who signed in with Steam.');
    expect(matchmakingText(mm(pool('bluesky', 'Bluesky'), false))).toMatch(/with Bluesky\.$/);
    expect(matchmakingText(mm(pool('direct', 'Email & Google'), false))).toMatch(/email or Google/);
  });

  it('explains cross-play is opt-in on both sides', () => {
    expect(matchmakingText(mm(pool('steam', 'Steam'), true))).toMatch(/^On: .*also turned it on/);
  });

  it('asks signed-out visitors to sign in', () => {
    expect(matchmakingText(null)).toMatch(/Sign in/);
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

describe('sign-in options', () => {
  it('only offers Google when the server has it set up', () => {
    expect(signInIntro(true)).toContain('Steam, Bluesky, Google and email');
    expect(signInIntro(false)).toContain('Steam, Bluesky and email');
    expect(signInIntro(false)).not.toContain('Google');
  });
});

describe('server build info', () => {
  it('names the version and, when the server has one, the build', () => {
    expect(buildLabel({ version: '3.0.0-playtest.1', build: 'abc1234' })).toBe('Build 3.0.0-playtest.1 · abc1234');
    expect(buildLabel({ version: '3.0.0-playtest.1', build: '' })).toBe('Build 3.0.0-playtest.1');
    expect(buildLabel({ version: ' 3.0.0 ' })).toBe('Build 3.0.0');
  });

  it('shows nothing for a server that does not report a version', () => {
    expect(buildLabel({})).toBe('');
    expect(buildLabel({ build: 'abc1234' })).toBe('');
  });

  it('only turns http(s) addresses into links', () => {
    expect(safeLink('https://example.com/feedback')).toBe('https://example.com/feedback');
    expect(safeLink(' http://10.0.0.5:8080/bugs ')).toBe('http://10.0.0.5:8080/bugs');
    for (const bad of ['', '   ', 'javascript:alert(1)', 'data:text/html,x', '/relative', 'example.com', 'mailto:a@b.c', undefined, null, 42]) {
      expect(safeLink(bad)).toBe('');
    }
  });
});
