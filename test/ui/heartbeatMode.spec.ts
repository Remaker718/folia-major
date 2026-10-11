import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { installBaseState, mockNeteaseApi, neteaseFixtures, openApp, svgDataUrl } from './helpers/appFixtures';

// test/ui/heartbeatMode.spec.ts — real app controls, mocked NetEase responses, and locally cached playable audio.

test.use({ serviceWorkers: 'block', actionTimeout: 15_000 });

const seedId = 14001;
const recommendationId = 14002;
const nextId = 14003;
const likedPlaylistId = 14901;
const rawSong = (id: number, name: string) => ({
    id, name, ar: [{ id: 140, name: 'Heartbeat Artist' }],
    al: { id: 141, name: 'Heartbeat Album', picUrl: svgDataUrl('Heart', '#be185d') }, dt: 120_000,
});
const songs = [rawSong(seedId, 'Liked Seed'), rawSong(recommendationId, 'Heartbeat Recommendation'), rawSong(nextId, 'Heartbeat Refill')];
const likedPlaylist = {
    ...neteaseFixtures.playlists[0], id: likedPlaylistId, name: 'My Liked Songs', specialType: 5,
    creator: neteaseFixtures.profile, trackCount: 1,
};

type HeartbeatCall = { id: string | null; pid: string | null; sid: string | null };

const snapshot = (page: Page) => page.evaluate(async () => {
    const playbackPath = '/src/stores/usePlaybackStore.ts';
    const heartbeatPath = '/src/stores/useHeartbeatModeStore.ts';
    const audioPath = '/src/stores/useAudioSettingsStore.ts';
    const [{ usePlaybackStore }, { useHeartbeatModeStore }, { useAudioSettingsStore }] = await Promise.all([
        import(playbackPath), import(heartbeatPath), import(audioPath),
    ]);
    const playback = usePlaybackStore.getState();
    const heartbeat = useHeartbeatModeStore.getState();
    return {
        songId: playback.currentSong ? String(playback.currentSong.id) : null,
        queue: playback.playQueue.map((song: { id: string | number }) => String(song.id)),
        audioSrc: playback.audioSrc as string | null,
        playerState: playback.playerState as string,
        active: heartbeat.session !== null,
        loading: heartbeat.loading as boolean,
        fm: playback.isFmMode as boolean,
        storedLoop: useAudioSettingsStore.getState().loopMode as string,
    };
});

/** Reuse the checked-in PCM fixture, padding its data with silence so automatic track-end cannot race UI assertions. */
async function cachePlayableSongs(page: Page) {
    const fixture = readFileSync(new URL('../manual/stage-client/fixtures/stage-demo-tone.wav', import.meta.url));
    const audio = Buffer.alloc(44 + fixture.readUInt32LE(28) * 120);
    fixture.copy(audio);
    audio.writeUInt32LE(audio.length - 8, 4);
    audio.writeUInt32LE(audio.length - 44, 40);
    await page.evaluate(async ({ bytes, length, ids }) => {
        const audioPath = '/src/services/audioCache.ts';
        const dbPath = '/src/services/db.ts';
        const keyPath = '/src/services/onlineMusic/resourceKeys.ts';
        const [{ saveAudioBlob }, { saveToCache }, { getSongResourceCacheKey }] = await Promise.all([
            import(audioPath), import(dbPath), import(keyPath),
        ]);
        const pcm = new Uint8Array(length);
        pcm.set(bytes);
        const blob = new Blob([pcm], { type: 'audio/wav' });
        await Promise.all(ids.map(async id => {
            const song = { id, sourceRef: { kind: 'online', providerId: 'netease', mediaId: String(id) } };
            await saveAudioBlob(getSongResourceCacheKey('audio', song), blob);
            await saveToCache(getSongResourceCacheKey('lyric', song), { lines: [] });
        }));
    }, { bytes: Array.from(audio.subarray(0, fixture.length)), length: audio.length, ids: songs.map(song => song.id) });
}

async function openHeartbeatApp(page: Page, mode: 'logged-in' | 'guest' = 'logged-in') {
    const calls: HeartbeatCall[] = [];
    await installBaseState(page, { neteaseMode: mode });
    await page.addInitScript(() => {
        localStorage.setItem('last_home_view_tab', 'radio');
        localStorage.setItem('playback_entry_view', 'player');
        localStorage.setItem('playback_entry_view_chosen', 'true');
        localStorage.setItem('visualizer_mode', 'classic');
        localStorage.setItem('auto_use_best_lyric', 'false');
        localStorage.setItem('player_loop_mode', 'one');
    });
    await mockNeteaseApi(page, mode);
    await page.route('**/__mock_netease__/**', async route => {
        const url = new URL(route.request().url());
        const endpoint = url.pathname.replace('/__mock_netease__', '');
        let body: unknown;
        if (endpoint === '/user/playlist') body = { code: 200, playlist: [likedPlaylist], more: false };
        else if (endpoint === '/playlist/track/all') body = { code: 200, songs: [songs[0]], privileges: [] };
        else if (endpoint === '/playmode/intelligence/list') {
            calls.push({ id: url.searchParams.get('id'), pid: url.searchParams.get('pid'), sid: url.searchParams.get('sid') });
            body = { code: 200, data: [{ songInfo: songs[calls.length === 1 ? 1 : 2] }] };
        } else if (endpoint === '/personal_fm') body = { code: 200, data: [songs[0]] };
        else if (endpoint === '/recommend/songs') body = { code: 200, data: { dailySongs: [] } };
        else if (endpoint === '/recommend/resource') body = { code: 200, recommend: [] };
        else { await route.fallback(); return; }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await openApp(page);
    if (mode === 'logged-in') {
        await expect.poll(() => page.evaluate(async () => {
            const storePath = '/src/stores/useOnlineProviderAccountStore.ts';
            const { useOnlineProviderAccountStore } = await import(storePath);
            return useOnlineProviderAccountStore.getState().accounts.netease?.status;
        })).toBe('authenticated');
        await cachePlayableSongs(page);
    }
    return calls;
}

const palette = (page: Page) => page.getByTestId('command-palette-panel');
const heartbeatHeading = (page: Page) => page.locator('[data-grid3d-index]').getByRole('heading', { name: 'Heartbeat', exact: true });
async function searchCommand(page: Page, query: string) {
    await expect.poll(async () => {
        if (!await palette(page).isVisible()) await page.keyboard.press('ControlOrMeta+k');
        return palette(page).isVisible();
    }).toBe(true);
    await palette(page).getByRole('combobox').fill(query);
}

test('radio Heartbeat card starts a liked seed, next refills sequentially, and stopping preserves playback', async ({ page }) => {
    const calls = await openHeartbeatApp(page);
    // The carousel's first click centers a non-focused card; its second click activates it.
    await heartbeatHeading(page).click();
    await heartbeatHeading(page).click();
    await expect.poll(async () => (await snapshot(page)).songId).toBe(String(seedId));
    await expect.poll(async () => (await snapshot(page)).active).toBe(true);
    expect(calls).toEqual([{ id: String(seedId), pid: String(likedPlaylistId), sid: String(seedId) }]);
    await expect.poll(async () => (await snapshot(page)).audioSrc).toMatch(/^blob:/);
    await expect.poll(async () => (await snapshot(page)).playerState).toBe('PLAYING');
    expect(await snapshot(page)).toMatchObject({ queue: [String(seedId), String(recommendationId)], fm: false, storedLoop: 'one' });

    await searchCommand(page, 'next track');
    await palette(page).getByText('Next track', { exact: true }).click();
    await expect(palette(page)).toBeHidden();
    await expect.poll(async () => (await snapshot(page)).songId).toBe(String(recommendationId));
    expect(calls).toEqual([
        { id: String(seedId), pid: String(likedPlaylistId), sid: String(seedId) },
        { id: String(recommendationId), pid: String(likedPlaylistId), sid: String(seedId) },
    ]);
    await expect.poll(async () => (await snapshot(page)).queue).toEqual(songs.map(song => String(song.id)));
    await expect.poll(async () => (await snapshot(page)).playerState).toBe('PLAYING');
    await page.getByTestId('panel-toggle').getByRole('button').last().click();
    await page.locator('[data-ponder-panel-tab-button="queue"]').click();
    const heartbeatStatus = page.getByTestId('heartbeat-status');
    await expect(heartbeatStatus).toContainText('Heartbeat is on');
    await page.screenshot({ path: test.info().outputPath('heartbeat-active-queue.png'), animations: 'disabled' });
    const beforeStop = await snapshot(page);
    await heartbeatStatus.getByRole('button', { name: 'Stop Heartbeat', exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).active).toBe(false);
    await expect(heartbeatStatus).toBeHidden();
    const afterStop = await snapshot(page);
    expect(afterStop.playerState).toBe('PLAYING');
    expect({ song: afterStop.songId, queue: afterStop.queue, audio: afterStop.audioSrc, loop: afterStop.storedLoop })
        .toEqual({ song: beforeStop.songId, queue: beforeStop.queue, audio: beforeStop.audioSrc, loop: 'one' });
});

test('command palette starts Heartbeat and switches to its stop action', async ({ page }) => {
    const calls = await openHeartbeatApp(page);
    await searchCommand(page, 'heartbeat');
    await palette(page).getByText('Start Heartbeat', { exact: true }).click();
    await expect(palette(page)).toBeHidden();
    await expect.poll(async () => (await snapshot(page)).active).toBe(true);
    await expect.poll(async () => (await snapshot(page)).songId).toBe(String(seedId));
    expect(calls).toHaveLength(1);
    await searchCommand(page, 'heartbeat');
    await expect(palette(page).getByText('Stop Heartbeat', { exact: true })).toBeVisible();
    await palette(page).getByText('Stop Heartbeat', { exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).active).toBe(false);
});

test('Bravais radio shortcut starts Heartbeat through the real home surface', async ({ page }) => {
    const calls = await openHeartbeatApp(page);
    await page.getByTestId('dev-library-renderer-switch').locator('[data-renderer="bravais"]').click();
    const stage = page.locator('[data-library-stage="bravais"]');
    await expect(stage).toBeAttached();
    await expect(stage).not.toHaveAttribute('data-bravais-settling', /.*/);
    await page.locator('[data-bravais-shortcut="heartbeat"]:visible').click();
    await expect.poll(async () => (await snapshot(page)).songId).toBe(String(seedId));
    await expect.poll(async () => (await snapshot(page)).active).toBe(true);
    await expect.poll(async () => (await snapshot(page)).playerState).toBe('PLAYING');
    expect(calls).toEqual([{ id: String(seedId), pid: String(likedPlaylistId), sid: String(seedId) }]);
    await searchCommand(page, 'heartbeat');
    await palette(page).getByText('Stop Heartbeat', { exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).active).toBe(false);
});

test('guests cannot start Heartbeat from the home card or command palette', async ({ page }) => {
    const calls = await openHeartbeatApp(page, 'guest');
    await expect(heartbeatHeading(page)).toHaveCount(0);
    await searchCommand(page, 'heartbeat');
    await expect(palette(page).getByText('Start Heartbeat', { exact: true })).toHaveCount(0);
    expect(calls).toHaveLength(0);
});

test('switching to an authenticated unsupported provider removes Heartbeat entry points', async ({ page }) => {
    const calls = await openHeartbeatApp(page);
    await expect(heartbeatHeading(page)).toBeVisible();
    await page.evaluate(async () => {
        const storePath = '/src/stores/useOnlineProviderAccountStore.ts';
        const { useOnlineProviderAccountStore } = await import(storePath);
        useOnlineProviderAccountStore.getState().updateAccount('kugou', {
            status: 'authenticated', user: { id: 'unsupported-user', nickname: 'Other Platform' },
            collections: [], hydration: 'ready', freshness: 'fresh',
        });
        useOnlineProviderAccountStore.getState().setActiveProviderId('kugou');
    });
    await expect(heartbeatHeading(page)).toHaveCount(0);
    await searchCommand(page, 'heartbeat');
    await expect(palette(page).getByText('Start Heartbeat', { exact: true })).toHaveCount(0);
    expect(calls).toHaveLength(0);
});
