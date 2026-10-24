import { describe, it, expect } from 'vitest';
import { createWakeLockHolder, type SentinelLike } from './wakeLock';

// The screen wake lock's bookkeeping, pure so it can be tested (WP-W1 review
// F6, and the S1-WEB-04 release listener). A fake sentinel stands in for
// WakeLockSentinel.

function fakeSentinel() {
    const listeners: Array<() => void> = [];
    const s = {
        released: false,
        release: async () => {
            s.released = true;
            for (const f of listeners) f();
        },
        addEventListener: (_type: 'release', fn: () => void) => {
            listeners.push(fn);
        },
        /** The browser releasing it by itself (the tab was hidden). */
        browserRelease: () => {
            s.released = true;
            for (const f of listeners) f();
        },
    };
    return s;
}

/** A request whose promise the test resolves when it wants. */
function deferredRequests() {
    const pending: Array<(s: SentinelLike) => void> = [];
    return {
        request: () => new Promise<SentinelLike>((resolve) => pending.push(resolve)),
        land: (s: SentinelLike) => pending.shift()?.(s),
    };
}

describe('wake lock holder', () => {
    it('a release while the request is pending releases the lock when it lands', async () => {
        const d = deferredRequests();
        const h = createWakeLockHolder({ request: d.request, canRequest: () => true });
        const acquiring = h.acquire();
        h.release();
        const s = fakeSentinel();
        d.land(s);
        await acquiring;
        expect(s.released).toBe(true);
        expect(h.held()).toBeNull();
    });

    it('the browser\'s own release clears the held lock, so a re-acquire works', async () => {
        const first = fakeSentinel();
        const second = fakeSentinel();
        const queue = [first, second];
        const h = createWakeLockHolder({ request: async () => queue.shift() as SentinelLike, canRequest: () => true });
        await h.acquire();
        expect(h.held()).toBe(first);
        first.browserRelease();
        expect(h.held()).toBeNull();
        await h.acquire();
        expect(h.held()).toBe(second);
        // A late release event from the old sentinel never clears the new one.
        first.browserRelease();
        expect(h.held()).toBe(second);
    });

    it('acquire is a no-op while a lock is held', async () => {
        let requests = 0;
        const h = createWakeLockHolder({
            request: async () => {
                requests++;
                return fakeSentinel();
            },
            canRequest: () => true,
        });
        await h.acquire();
        await h.acquire();
        expect(requests).toBe(1);
    });

    it('nothing is requested where the page may not ask, and a failed request holds nothing', async () => {
        let requests = 0;
        const hidden = createWakeLockHolder({
            request: async () => {
                requests++;
                return fakeSentinel();
            },
            canRequest: () => false,
        });
        await hidden.acquire();
        expect(requests).toBe(0);
        const failing = createWakeLockHolder({
            request: async () => {
                throw new Error('NotAllowedError');
            },
            canRequest: () => true,
        });
        await failing.acquire();
        expect(failing.held()).toBeNull();
    });

    it('a second acquire while the first is pending asks once and keeps the lock', async () => {
        const d = deferredRequests();
        let requests = 0;
        const h = createWakeLockHolder({
            request: () => {
                requests++;
                return d.request();
            },
            canRequest: () => true,
        });
        const a = h.acquire();
        h.release();
        const b = h.acquire();
        const s = fakeSentinel();
        d.land(s);
        await Promise.all([a, b]);
        expect(requests).toBe(1);
        // The latest intent was to hold it.
        expect(s.released).toBe(false);
        expect(h.held()).toBe(s);
    });

    it('release lets go of a held lock', async () => {
        const s = fakeSentinel();
        const h = createWakeLockHolder({ request: async () => s, canRequest: () => true });
        await h.acquire();
        h.release();
        expect(s.released).toBe(true);
        expect(h.held()).toBeNull();
    });
});

describe('wake lock resume (issue #730)', () => {
    it('a wish made from a hidden tab is honoured by resume()', async () => {
        let visible = false;
        let requests = 0;
        const holder = createWakeLockHolder({
            request: async () => {
                requests++;
                return fakeSentinel();
            },
            canRequest: () => visible,
        });
        // The sender is in the chat app when the recipient joins: acquire is
        // called while the page may not ask.
        await holder.acquire();
        expect(requests).toBe(0);

        visible = true;
        await holder.resume();
        expect(requests).toBe(1);
        expect(holder.held()).not.toBeNull();
    });

    it('resume is a no-op when nothing wants a lock', async () => {
        let requests = 0;
        const holder = createWakeLockHolder({
            request: async () => {
                requests++;
                return fakeSentinel();
            },
            canRequest: () => true,
        });
        await holder.resume();
        expect(requests).toBe(0);
        expect(holder.held()).toBeNull();
    });

    it('resume does nothing after release', async () => {
        let requests = 0;
        const holder = createWakeLockHolder({
            request: async () => {
                requests++;
                return fakeSentinel();
            },
            canRequest: () => true,
        });
        await holder.acquire();
        expect(holder.held()).not.toBeNull();
        await holder.release();
        await holder.resume();
        expect(requests).toBe(1);
        expect(holder.held()).toBeNull();
    });
});
